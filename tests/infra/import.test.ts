import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { importInfra, listInfra, INFRA_AUTHOR } from '../../src/core/infra/index.js';
import { planInfra, type InfraChunk } from '../../src/core/infra/plan.js';
import { parseInfra } from '../../src/core/parser/infra-parser.js';
import { chunkInfra } from '../../src/core/chunker/infra-chunker.js';

let fixture: Awaited<ReturnType<typeof createFixtureGroup>> | undefined;
afterEach(async () => {
  await fixture?.cleanup();
  fixture = undefined;
});
const compose = `services:
  app:
    build: .
    ports: ['8080:80']
    environment:
      REDIS_HOST: redis
      PRIVATE_TOKEN: super-private
    depends_on: [redis]
    volumes: [cache:/cache]
  worker:
    image: worker:1
    environment:
      REDIS_HOST: redis
  redis:
    image: redis:7
volumes:
  cache:
`;
async function setup() {
  fixture = await createFixtureGroup();
  const source = fixture.sources[0];
  const runtime = fixture.runtime.get(source);
  fs.writeFileSync(path.join(source.rootPath, 'docker-compose.yml'), compose);
  fs.writeFileSync(
    path.join(source.rootPath, 'Dockerfile'),
    'FROM node:22\nEXPOSE 80\nENTRYPOINT ["node", "server.js"]\n'
  );
  fs.writeFileSync(
    path.join(source.rootPath, 'infra.tf'),
    'resource "aws_sqs_queue" "jobs" { name = "private" }\n'
  );
  fs.writeFileSync(
    path.join(source.rootPath, 'deployment.yaml'),
    `apiVersion: v1
kind: List
items:
  - apiVersion: apps/v1
    kind: Deployment
    metadata: {name: app}
    spec:
      template:
        spec:
          containers:
            - name: app
              image: node:22
              envFrom:
                - configMapRef: {name: app-config}
                - secretRef: {name: app-secret}
  - apiVersion: v1
    kind: ConfigMap
    metadata: {name: app-config}
    data: {HOST: private}
  - apiVersion: v1
    kind: Secret
    metadata: {name: app-secret}
    stringData: {password: private}
`
  );
  await runtime.index(true);
  return {
    fixture,
    source,
    runtime,
    scope: { home: fixture.registry.home, viewIds: [source.repoId] }
  };
}
function graphRows(home: string, table = 'verified_facts') {
  const db = new Database(path.join(home, 'graph.db'), { readonly: true });
  try {
    return db.prepare(`SELECT id, status, author, payload FROM ${table}`).all() as {
      id: string;
      status: string;
      author: string;
      payload: string;
    }[];
  } finally {
    db.close();
  }
}

describe('indexed infrastructure import', () => {
  it('persists sanitized inventories and exact evidence, and reruns without duplicates', async () => {
    const { scope, source } = await setup();
    const report = await importInfra({ scope });
    expect(report.views[0].facts).toBe(9); // 3 compose + mapped Docker + stage + TF + 3 k8s
    expect(report.views[0].links).toBe(3);
    const facts = graphRows(scope.home);
    expect(facts).toHaveLength(9);
    for (const row of facts) {
      const data = JSON.parse(row.payload);
      expect(row).toMatchObject({ status: 'verified', author: INFRA_AUTHOR });
      expect(data).toMatchObject({ provenance: 'code', scope: 'view', scopeId: source.repoId });
      expect(data.evidence.length).toBeGreaterThan(0);
      expect(
        data.evidence.every(
          (e: { generation: number }) => e.generation === report.views[0].generation
        )
      ).toBe(true);
    }
    const text = JSON.stringify(facts);
    expect(text).not.toContain('super-private');
    expect(text).not.toContain('server.js'); // executable only
    expect(text).toContain('REDIS_HOST');
    expect(
      JSON.parse(
        facts.find((row) => JSON.parse(row.payload).content.includes('aws_sqs_queue'))!.payload
      ).category
    ).toBe('queue');
    const links = graphRows(scope.home, 'verified_links');
    expect(links.every((row) => JSON.parse(row.payload).evidence.length === 2)).toBe(true);
    expect(links.every((row) => JSON.parse(row.payload).provenance.kind === 'code')).toBe(true);
    expect(links.some((row) => JSON.parse(row.payload).rationale.includes('depends_on'))).toBe(
      true
    );
    expect(
      links.filter((row) => JSON.parse(row.payload).rationale.includes('secretRef'))
    ).toHaveLength(1);
    await importInfra({ scope });
    expect(
      graphRows(scope.home)
        .map((r) => r.id)
        .sort()
    ).toEqual(facts.map((r) => r.id).sort());
    expect(
      graphRows(scope.home, 'verified_links')
        .map((r) => r.id)
        .sort()
    ).toEqual(links.map((r) => r.id).sort());
    expect(listInfra(scope)).toHaveLength(12);
    expect(report.skipped.some((s) => s.reason.includes('hosts are redacted'))).toBe(true);
  });

  it('updates service+kind identity in place and retains disappeared evidence as stale', async () => {
    const { scope, source, runtime } = await setup();
    await importInfra({ scope });
    const before = graphRows(scope.home);
    const app = before.find(
      (r) =>
        JSON.parse(r.payload).content.includes('compose-service app') &&
        !JSON.parse(r.payload).content.includes('"stage"')
    )!;
    fs.writeFileSync(
      path.join(source.rootPath, 'docker-compose.yml'),
      compose.replace('8080:80', '9090:80')
    );
    await runtime.index(true);
    await importInfra({ scope });
    const updated = graphRows(scope.home).find((r) => r.id === app.id)!;
    expect(updated.status).toBe('verified');
    expect(JSON.parse(updated.payload).content).toContain('9090:80');
    expect(graphRows(scope.home)).toHaveLength(before.length);
    const linkIds = graphRows(scope.home, 'verified_links')
      .map((row) => row.id)
      .sort();
    fs.writeFileSync(
      path.join(source.rootPath, 'docker-compose.yml'),
      compose
        .replace('8080:80', '9090:80')
        .replace('services:\n', 'services:\n  first: {image: first:1}\n')
    );
    await runtime.index(true);
    await importInfra({ scope });
    expect(graphRows(scope.home)).toHaveLength(before.length + 1);
    expect(
      graphRows(scope.home, 'verified_links')
        .map((row) => row.id)
        .sort()
    ).toEqual(linkIds);
    expect(graphRows(scope.home).find((row) => row.id === app.id)?.status).toBe('verified');
    fs.unlinkSync(path.join(source.rootPath, 'infra.tf'));
    await runtime.index(true);
    await importInfra({ scope });
    const removed = graphRows(scope.home).find((r) =>
      JSON.parse(r.payload).content.includes('terraform-block')
    )!;
    expect(removed.status).toBe('stale');
    expect(JSON.parse(removed.payload).staleReason).toBe('file deleted');
    expect(listInfra(scope).find((r) => r.id === removed.id)?.status).toBe('stale');
    fs.writeFileSync(
      path.join(source.rootPath, 'infra.tf'),
      'resource "aws_sqs_queue" "jobs" { name = "private" }\n'
    );
    await runtime.index(true);
    await importInfra({ scope });
    expect(listInfra(scope).find((row) => row.id === removed.id)?.status).toBe('verified');
  });

  it('dry run leaves graph records and lifecycle timestamps unchanged and respects selected view', async () => {
    const { scope, fixture } = await setup();
    expect(fs.existsSync(path.join(scope.home, 'graph.db'))).toBe(false);
    await importInfra({ scope, dryRun: true });
    expect(fs.existsSync(path.join(scope.home, 'graph.db'))).toBe(false);
    await importInfra({ scope });
    const before = graphRows(scope.home);
    const links = graphRows(scope.home, 'verified_links');
    const plan = await importInfra({ scope, dryRun: true });
    expect(plan.dryRun).toBe(true);
    expect(graphRows(scope.home)).toEqual(before);
    expect(graphRows(scope.home, 'verified_links')).toEqual(links);
    expect(plan.views).toHaveLength(1);
    expect(listInfra({ home: scope.home, viewIds: [fixture.sources[1].repoId] })).toEqual([]);
  });

  it('respects disabled infra and supports group selectors without importing other authors', async () => {
    const { scope, source } = await setup();
    const group = await importInfra({ scope: 'group:foundation-130', dryRun: true });
    expect(group.views).toHaveLength(3);
    fs.mkdirSync(path.join(source.rootPath, '.contextos'), { recursive: true });
    fs.writeFileSync(
      path.join(source.rootPath, '.contextos/config.json'),
      JSON.stringify({ indexing: { infra: false } })
    );
    const disabled = await importInfra({ scope });
    expect(disabled.views).toEqual([]);
    expect(disabled.skipped[0].reason).toContain('disabled');
    expect(listInfra(scope)).toEqual([]);
  });

  it('refuses stale generations and does not recover unindexed filesystem data', async () => {
    const { scope, source } = await setup();
    fs.writeFileSync(
      path.join(source.rootPath, 'docker-compose.yml'),
      compose + '\n# not indexed\n'
    );
    await expect(importInfra({ scope })).rejects.toThrow(/changed since indexing/);
    expect(graphRows(scope.home)).toEqual([]);
  });

  it('runs the compiled CLI and automatically imports a completed generation in its worker', async () => {
    const { scope, source } = await setup();
    const env = { ...process.env, HOME: fixture!.home, CONTEXTOS_EMBEDDINGS: '0' };
    const cli = path.resolve('dist/bin/contextos.js');
    const exec = promisify(execFile);
    const result = await exec(
      process.execPath,
      [cli, 'infra', 'import', '--scope', `view:${source.repoId}`, '--dry-run', '--json'],
      { cwd: source.rootPath, env }
    );
    expect(JSON.parse(result.stdout).dryRun).toBe(true);
    // Exercise the real compiled scheduling hook; the subprocess stays alive until
    // polling sees its saved facts, without coupling assertions to timer duration.
    const module = new URL('../../dist/src/core/infra/scheduler.js', import.meta.url).href;
    const inventoryModule = new URL('../../dist/src/core/infra/index.js', import.meta.url).href;
    const program = `import {listInfra} from ${JSON.stringify(inventoryModule)}; import {scheduleInfraImport} from ${JSON.stringify(module)}; scheduleInfraImport(${JSON.stringify(scope.home)}, ${JSON.stringify(source.repoId)}); scheduleInfraImport(${JSON.stringify(scope.home)}, ${JSON.stringify(source.repoId)}); const end=Date.now()+15000; const t=setInterval(()=>{if(listInfra(${JSON.stringify(scope)}).length === 12){clearInterval(t); process.exit(0)}else if(Date.now()>end)process.exit(1)},100);`;
    await exec(process.execPath, ['--input-type=module', '-e', program], {
      cwd: source.rootPath,
      env
    });
    expect(graphRows(scope.home)).toHaveLength(9);
    const listed = await exec(process.execPath, [cli, 'infra', 'list', '--json'], {
      cwd: source.rootPath,
      env
    });
    expect(JSON.parse(listed.stdout)).toHaveLength(12);
  }, 25000);
});

function structural(file: string, content: string): InfraChunk[] {
  const doc = parseInfra(file, content)!;
  return chunkInfra(file, doc, { layer: 'repo' }).map((c) => ({
    ref: `ref:${c.id}`,
    file: c.sourceFile,
    kind: c.language!,
    name: c.symbolName!,
    content: c.content
  }));
}
describe('conservative planning', () => {
  it('never connects shared host/name coincidences or redacted environment values', () => {
    const plan = planInfra(
      structural('/repo/docker-compose.yml', compose.replace('    depends_on: [redis]\n', ''))
    );
    expect(plan.links).toEqual([]);
    expect(plan.facts).toHaveLength(3);
  });
  it('requires exact compose file scope, rejects invalid JSON, and never imports shell heuristics', () => {
    const chunks = structural('/one/compose.yml', 'services:\n  app: {depends_on: [redis]}\n');
    chunks.push(...structural('/two/compose.yml', 'services:\n  redis: {image: "redis:7"}\n'));
    chunks.push({ ref: 'bad', file: '/bad', kind: 'compose-service', name: 'bad', content: '{' });
    chunks.push(...structural('/repo/run.sh', 'redis-cli --host redis\n'));
    const plan = planInfra(chunks);
    expect(plan.links).toEqual([]);
    expect(plan.facts).toHaveLength(2);
    expect(plan.skipped.map((s) => s.reason)).toContain('invalid structural JSON');
  });
  it('does not connect resource refs across Kubernetes namespaces', () => {
    const chunks = structural(
      '/repo/app.yaml',
      'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: app, namespace: prod}\nspec: {template: {spec: {containers: [{name: app, envFrom: [{configMapRef: {name: config}}]}]}}}\n'
    );
    chunks.push(
      ...structural(
        '/repo/config.yaml',
        'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: config, namespace: dev}\ndata: {HOST: private}\n'
      )
    );
    expect(planInfra(chunks).links).toEqual([]);
    chunks.push(
      ...chunks
        .slice(1)
        .map((c) => ({ ...c, ref: 'other', content: c.content.replace('dev', 'prod') }))
    );
    expect(planInfra(chunks).links).toHaveLength(1);
    chunks.push(...chunks.slice(2).map((c) => ({ ...c, ref: 'duplicate' })));
    expect(planInfra(chunks).links).toEqual([]);
  });
});

it('associates Dockerfile targets only through explicit compose build mappings', () => {
  const chunks = structural(
    '/repo/compose.yml',
    'services:\n  app: {build: {context: ., dockerfile: Dockerfile, target: builder}}\n  unmapped: {image: node:22}\n'
  );
  chunks.push(
    ...structural(
      '/repo/Dockerfile',
      'FROM node:22 AS builder\nEXPOSE 3000\nENTRYPOINT ["node", "secret-argument"]\nFROM alpine:3 AS runtime\nEXPOSE 80\n'
    )
  );
  const plan = planInfra(chunks);
  const mapping = plan.facts.filter((f) => f.refs.length === 2);
  expect(mapping).toHaveLength(1);
  expect(mapping[0].content).toContain('node:22 AS builder');
  expect(mapping[0].content).toContain('3000');
  expect(mapping[0].content).not.toContain('secret-argument');
  expect(mapping[0].content).not.toContain('alpine');
});

it('imports Terraform labels and attribute names without literal values', () => {
  const plan = planInfra(
    structural(
      '/repo/main.tf',
      'resource "aws_db_instance" "main" {\n  password = "private-password"\n  port = 5432\n}\nmodule "worker" { source = "private-source" }\n'
    )
  );
  expect(plan.facts).toHaveLength(2);
  expect(plan.facts[0].category).toBe('database');
  expect(plan.facts[0].content).toContain('aws_db_instance');
  expect(plan.facts[0].content).toContain('password');
  expect(JSON.stringify(plan)).not.toContain('private-password');
  expect(JSON.stringify(plan)).not.toContain('private-source');
  expect(JSON.stringify(plan)).not.toContain('5432');
});
