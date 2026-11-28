import path from 'node:path';
import type { LinkType } from '../knowledge/graph-store.js';

export const INFRA_AUTHOR = 'contextos:infra-import';
export const IMPORT_KINDS = [
  'compose-service',
  'dockerfile',
  'k8s-resource',
  'terraform-block'
] as const;
export interface InfraChunk {
  ref: string;
  file: string;
  kind: string;
  name: string;
  content: string;
}
export interface InfraFact {
  key: string;
  content: string;
  category: string;
  refs: string[];
}
export interface InfraLink {
  key: string;
  source: string;
  target: string;
  type: LinkType;
  rationale: string;
  refs: string[];
}
export interface InfraPlan {
  facts: InfraFact[];
  links: InfraLink[];
  skipped: { ref: string; reason: string }[];
}
type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Data) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const named = (value: unknown): value is string =>
  typeof value === 'string' && /^[\w./:@-]+$/.test(value) && !value.includes('[REDACTED]');
const workload = new Set([
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'Pod',
  'Job',
  'CronJob',
  'ReplicaSet',
  'ReplicationController'
]);

/** Consume D1 structural JSON exclusively. Never recover suppressed values from disk. */
export function planInfra(chunks: InfraChunk[]): InfraPlan {
  const plan: InfraPlan = { facts: [], links: [], skipped: [] };
  const parsed = chunks.flatMap((chunk) => {
    try {
      return [{ chunk, value: JSON.parse(chunk.content) as unknown }];
    } catch {
      plan.skipped.push({ ref: chunk.ref, reason: 'invalid structural JSON' });
      return [];
    }
  });
  const fact = (
    chunk: InfraChunk,
    details: unknown,
    category = 'service',
    refs = [chunk.ref],
    suffix = ''
  ) => {
    plan.facts.push({
      key: JSON.stringify([chunk.file, chunk.kind, chunk.name, suffix]),
      content: `${chunk.kind} ${chunk.name} (${chunk.file}): ${JSON.stringify(details)}`,
      category,
      refs
    });
  };
  const relation = (from: InfraChunk, to: InfraChunk, description: string) => {
    plan.links.push({
      key: JSON.stringify([
        from.file,
        from.kind,
        from.name,
        to.file,
        to.kind,
        to.name,
        description
      ]),
      source: from.ref,
      target: to.ref,
      type: 'reads_resource',
      rationale: description,
      refs: [from.ref, to.ref]
    });
  };
  for (const { chunk, value } of parsed) {
    const data = object(value);
    if (chunk.kind === 'compose-service') {
      fact(chunk, {
        name: data.name,
        image: data.image,
        build: data.build,
        ports: data.ports,
        depends_on: data.depends_on,
        env: Object.keys(object(data.environment)).sort(),
        volumes: data.volumes
      });
      for (const dependency of array(data.depends_on).filter(named)) {
        const targets = parsed.filter(
          (p) =>
            p.chunk.kind === 'compose-service' &&
            p.chunk.file === chunk.file &&
            object(p.value).name === dependency
        );
        if (targets.length === 1)
          relation(chunk, targets[0].chunk, `Compose depends_on explicitly names ${dependency}`);
        else
          plan.skipped.push({
            ref: chunk.ref,
            reason: `unresolved or ambiguous depends_on ${dependency}`
          });
      }
      if (Object.keys(object(data.environment)).length)
        plan.skipped.push({
          ref: chunk.ref,
          reason: 'environment hosts are redacted; shared resource relationships cannot be proven'
        });
      // A build mapping is the only supported association between a service and Dockerfile.
      const build = typeof data.build === 'string' ? { context: data.build } : object(data.build);
      if (named(build.context)) {
        const dockerfile = path.resolve(
          path.dirname(chunk.file),
          build.context,
          typeof build.dockerfile === 'string' ? build.dockerfile : 'Dockerfile'
        );
        const stages = parsed.filter(
          (p) =>
            p.chunk.kind === 'dockerfile' &&
            path.resolve(p.chunk.file) === dockerfile &&
            Array.isArray(p.value)
        );
        const target = build.target;
        const chosen = target
          ? stages.filter((p) =>
              array(p.value).some(
                (v) =>
                  object(v).instruction === 'FROM' &&
                  typeof object(v).value === 'string' &&
                  (object(v).value as string).split(/\s+AS\s+/i)[1] === target
              )
            )
          : stages.slice(-1);
        if (chosen.length === 1)
          fact(
            chunk,
            { dockerfile, stage: chosen[0].chunk.name, ...dockerDetails(chosen[0].value) },
            'service',
            [chunk.ref, chosen[0].chunk.ref],
            'dockerfile'
          );
      }
    } else if (chunk.kind === 'dockerfile' && Array.isArray(value)) {
      fact(chunk, dockerDetails(value));
    } else if (chunk.kind === 'terraform-block') {
      fact(
        chunk,
        {
          block: data.block,
          labels: data.labels,
          attributes: Object.keys(object(data.attributes)).sort()
        },
        terraformCategory(data)
      );
    } else if (chunk.kind === 'k8s-resource') {
      fact(chunk, data, data.kind === 'ConfigMap' || data.kind === 'Secret' ? 'env' : 'service');
      if (!workload.has(String(data.kind))) continue;
      for (const reference of array(data.refs)) {
        const ref = object(reference);
        const kind = /^(configMapKeyRef|configMapRef|configMap)$/.test(String(ref.type))
          ? 'ConfigMap'
          : /^(secretKeyRef|secretRef|secret)$/.test(String(ref.type))
            ? 'Secret'
            : undefined;
        if (!kind || !named(ref.name)) continue;
        const targets = parsed.filter(
          (p) =>
            p.chunk.kind === 'k8s-resource' &&
            object(p.value).kind === kind &&
            object(p.value).name === ref.name &&
            (object(p.value).namespace ?? 'default') === (data.namespace ?? 'default')
        );
        // Require a unique namespace/kind/name target within this view.
        const local = targets;
        if (local.length === 1)
          relation(
            chunk,
            local[0].chunk,
            `Kubernetes ${String(ref.type)} explicitly references ${kind}/${ref.name} in namespace ${String(data.namespace ?? 'default')}`
          );
        else
          plan.skipped.push({
            ref: chunk.ref,
            reason: `unresolved or ambiguous ${kind}/${ref.name}`
          });
      }
      plan.skipped.push({
        ref: chunk.ref,
        reason:
          'D1 omits Service selectors and workload serviceName; Service relations cannot be proven'
      });
    }
  }
  return plan;
}
function dockerDetails(value: unknown): Data {
  const instructions = array(value).map(object);
  return {
    base: instructions.filter((i) => i.instruction === 'FROM').map((i) => i.value),
    ports: instructions.filter((i) => i.instruction === 'EXPOSE').map((i) => i.value),
    entrypoint: instructions.filter((i) => i.instruction === 'ENTRYPOINT').map((i) => i.value),
    command: instructions.filter((i) => i.instruction === 'CMD').map((i) => i.value)
  };
}

/** Categories describe declared infrastructure types; they never establish edges. */
function terraformCategory(data: Data): string {
  const type = String(array(data.labels)[0] ?? '');
  if (data.block === 'variable' || data.block === 'output' || data.block === 'locals') return 'env';
  if (data.block !== 'resource' && data.block !== 'data') return 'host';
  if (/(?:^|_)(?:queue|topic)$/.test(type)) return 'queue';
  if (
    /(?:^|_)(?:db_instance|database|database_instance|redis|redis_cache|elasticache_cluster)$/.test(
      type
    )
  )
    return 'database';
  if (/(?:^|_)(?:secret|config_map)$/.test(type)) return 'env';
  return 'host';
}
