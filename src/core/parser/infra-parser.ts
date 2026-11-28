import path from 'node:path';
import { createRequire } from 'node:module';

const yaml = createRequire(import.meta.url)('js-yaml') as {
  loadAll(source: string, iterator: (value: unknown) => void, options: { schema: unknown }): void;
  JSON_SCHEMA: unknown;
};
export const INFRA_PARSER_VERSION = 1;
export type InfraKind =
  | 'compose-service'
  | 'dockerfile'
  | 'k8s-resource'
  | 'helm-values'
  | 'terraform-block'
  | 'shell-script'
  | 'env-example';
export interface InfraSection {
  name: string;
  content: string;
  startLine: number;
  endLine: number;
}
export interface InfraDocument {
  kind: InfraKind;
  sections: InfraSection[];
}
const REDACTED = '[REDACTED]';
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const keyName = (v: string): string => (/^[\w./-]+$/.test(v) ? v : REDACTED);
const secretKey = /password|secret|token|key|credential|dsn/i;

/** No raw command arguments, interpolation defaults, URLs with credentials or secret assignments. */
export function safeInfraLiteral(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(safeInfraLiteral);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(obj(v)).map(([k, value]) => [
        keyName(k),
        secretKey.test(k) ? REDACTED : safeInfraLiteral(value)
      ])
    );
  if (typeof v !== 'string') return v;
  if (secretKey.test(v) && /[=:\s]/.test(v)) return REDACTED;
  return v
    .replace(/\$\{[^}]*\}/g, REDACTED)
    .replace(/\b[\w+.-]+:\/\/[^\s]+/g, REDACTED)
    .replace(
      /[^\s,;]*?(?:password|secret|token|key|credential|dsn)[^\s,;]*\s*[=:]\s*[^\n]*/gi,
      REDACTED
    );
}
function keys(v: unknown): unknown {
  const names = Array.isArray(v) ? v.map((x) => String(x).split(/[=:\s]/)[0]) : Object.keys(obj(v));
  return Object.fromEntries(names.map((k) => [keyName(k), REDACTED]));
}
function dockerEnvKeys(arg: string): unknown {
  const tokens = arg.match(/(?:[^\s"'\\]|\\.|"(?:\\.|[^"\\])*"|'[^']*')+/g) ?? [];
  return keys(
    tokens[0]?.includes('=')
      ? tokens.filter((t) => /^[\w]+=/.test(t)).map((t) => t.split('=')[0])
      : tokens.slice(0, 1)
  );
}
function command(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try {
      return command(JSON.parse(v));
    } catch {
      return REDACTED;
    }
  }
  const first = Array.isArray(v) ? v[0] : String(v).trim().split(/\s/)[0];
  return [
    typeof first === 'string' && /^[a-z./][a-z0-9_./-]*$/.test(first)
      ? safeInfraLiteral(first)
      : REDACTED,
    REDACTED
  ];
}
function section(name: string, value: unknown, startLine: number, endLine: number): InfraSection {
  return { name: keyName(name), content: JSON.stringify(value, null, 2), startLine, endLine };
}
function yamlDocs(content: string): unknown[] {
  const docs: unknown[] = [];
  yaml.loadAll(content, (v) => docs.push(v), { schema: yaml.JSON_SCHEMA });
  // Bound alias expansion / recursion before any traversal or JSON serialization.
  let count = 0;
  const ancestors = new Set<object>();
  const check = (v: unknown, depth: number) => {
    if (++count > 20000 || depth > 48)
      throw new Error('Infrastructure YAML exceeds inspection limits');
    if (!v || typeof v !== 'object') return;
    if (ancestors.has(v)) throw new Error('Cyclic infrastructure YAML');
    ancestors.add(v);
    for (const item of Object.values(v)) check(item, depth + 1);
    ancestors.delete(v);
  };
  check(docs, 0);
  return docs;
}
/** Filename classification also covers malformed YAML: it must never fall back to raw indexing. */
export function infraKind(file: string, content?: string): InfraKind | undefined {
  const base = path.basename(file).toLowerCase();
  if (/^(docker-compose.*|compose)\.ya?ml$/.test(base)) return 'compose-service';
  if (base.startsWith('dockerfile')) return 'dockerfile';
  if (base.endsWith('.sh')) return 'shell-script';
  if (base.endsWith('.tf')) return 'terraform-block';
  if (base === '.env.example') return 'env-example';
  if (/^values(?:[.-].*)?\.ya?ml$/.test(base)) return 'helm-values';
  if (
    /\.ya?ml$/.test(base) &&
    content &&
    /(?:^|[\s{,])["']?(?:apiVersion|kind)["']?\s*:\s*\S+/m.test(content)
  )
    return 'k8s-resource';
  return undefined;
}

export function parseInfra(file: string, content: string): InfraDocument | undefined {
  const kind = infraKind(file, content);
  if (!kind) return undefined;
  const lines = content.split(/\r?\n/);
  const sections: InfraSection[] = [];
  try {
    if (kind === 'compose-service') {
      const root = obj(yamlDocs(content)[0]);
      for (const [name, value] of Object.entries(obj(root.services))) {
        const service = obj(value);
        const build =
          typeof service.build === 'string'
            ? service.build
            : Object.fromEntries(
                ['context', 'dockerfile', 'target']
                  .filter((k) => k in obj(service.build))
                  .map((k) => [k, obj(service.build)[k]])
              );
        const data = {
          name: keyName(name),
          image: service.image,
          build,
          ports: service.ports,
          depends_on: Array.isArray(service.depends_on)
            ? service.depends_on
            : Object.keys(obj(service.depends_on)),
          environment: keys(service.environment),
          volumes: service.volumes,
          networks: Array.isArray(service.networks)
            ? service.networks
            : Object.keys(obj(service.networks)),
          command: command(service.command),
          entrypoint: command(service.entrypoint)
        };
        sections.push(section(name, safeInfraLiteral(data), 1, lines.length));
      }
    } else if (kind === 'k8s-resource') {
      const resources = yamlDocs(content).flatMap((v) =>
        obj(v).kind === 'List'
          ? Array.isArray(obj(v).items)
            ? (obj(v).items as unknown[])
            : []
          : [v]
      );
      for (const value of resources) {
        const resource = obj(value),
          metadata = obj(resource.metadata);
        if (typeof resource.kind !== 'string' || typeof metadata.name !== 'string') continue;
        const containers: unknown[] = [],
          refs: unknown[] = [];
        const walk = (v: unknown) => {
          if (!v || typeof v !== 'object') return;
          if (Array.isArray(v)) {
            v.forEach(walk);
            return;
          }
          const o = obj(v);
          if ('image' in o)
            containers.push({
              name: o.name,
              image: o.image,
              ports: o.ports,
              env: Array.isArray(o.env)
                ? o.env.map((e) => ({ name: obj(e).name, value: REDACTED }))
                : undefined,
              command: command(o.command),
              args: o.args ? REDACTED : undefined
            });
          for (const [k, item] of Object.entries(o)) {
            if (/^(configMapKeyRef|secretKeyRef|configMapRef|secretRef|configMap|secret)$/.test(k))
              refs.push({ type: k, name: obj(item).name ?? obj(item).secretName });
            walk(item);
          }
        };
        walk(resource.spec);
        sections.push(
          section(
            `${resource.kind}/${metadata.name}`,
            safeInfraLiteral({
              kind: resource.kind,
              name: metadata.name,
              namespace: metadata.namespace,
              containers,
              refs,
              data: keys(resource.data),
              stringData: keys(resource.stringData)
            }),
            1,
            lines.length
          )
        );
      }
    } else if (kind === 'helm-values') {
      // Values files contain arbitrary application schemas: retain structure and keys only.
      const scrub = (v: unknown): unknown =>
        Array.isArray(v)
          ? v.map(scrub)
          : v && typeof v === 'object'
            ? Object.fromEntries(
                Object.entries(obj(v)).map(([k, value]) => [keyName(k), scrub(value)])
              )
            : REDACTED;
      sections.push(section('values', scrub(yamlDocs(content)), 1, lines.length));
    } else if (kind === 'env-example') {
      const names: string[] = [];
      let quote: string | undefined;
      let continuation = false;
      for (const line of lines) {
        const continuedLine = continuation;
        continuation = /\\$/.test(line);
        if (!quote && !continuedLine) {
          const assignment = /^\s*(?:export\s+)?([\w]+)\s*=/.exec(line);
          if (!assignment) continue;
          names.push(assignment[1]);
        }
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '\\') {
            i++;
            continue;
          }
          if (!quote && line[i] === '#') break;
          if (line[i] === quote) quote = undefined;
          else if (!quote && (line[i] === "'" || line[i] === '"')) quote = line[i];
        }
      }
      sections.push(section('environment', keys(names), 1, lines.length));
    } else if (kind === 'terraform-block') {
      // Lex quoted strings, comments and heredocs before locating balanced top-level blocks.
      const blank = (text: string) => text.replace(/[^\n]/g, ' ');
      const masked = content
        .replace(/<<-?\s*(\w+)[^\n]*\n[\s\S]*?\n\s*\1\b/g, blank)
        .replace(/\/\*[\s\S]*?\*\/|#[^\n]*|\/\/[^\n]*|"(?:\\.|[^"\\])*"/g, blank);
      const starts = [
        ...masked.matchAll(
          /^[ \t]*(resource|module|data|variable|output|provider|terraform|locals)\b[^\n{]*\{/gm
        )
      ];
      let previousEnd = 0;
      for (const match of starts) {
        if (match.index! < previousEnd) continue;
        let depth = 1,
          end = match.index! + match[0].length;
        const begin = end;
        while (end < masked.length && depth) {
          if (masked[end] === '{') depth++;
          if (masked[end] === '}') depth--;
          end++;
        }
        if (depth) return { kind, sections: [] };
        previousEnd = end;
        const header = content.slice(match.index, begin);
        const labels = [...header.matchAll(/"([\w.-]+)"/g)].map((m) => m[1]);
        const name = [match[1], ...labels].join('.');
        const attributes = [...masked.slice(begin, end).matchAll(/\b([\w-]+)\s*=/g)].map(
          (m) => m[1]
        );
        sections.push(
          section(
            name,
            { block: match[1], labels, attributes: keys(attributes) },
            content.slice(0, match.index).split('\n').length,
            content.slice(0, end).split('\n').length
          )
        );
      }
    } else {
      // Scripts can embed arbitrary credentials in arguments, comments, heredocs and assignments.
      // Retain only syntax-derived names; never copy raw lines into evidence.
      let name = kind === 'dockerfile' ? 'stage-0' : 'script';
      let start = 1,
        records: unknown[] = [];
      const flush = (end: number) => {
        if (records.length) sections.push(section(name, records, start, end));
        records = [];
      };
      const heredocs: string[] = [];
      let quote: string | undefined;
      let substitutionDepth = 0;
      let continuation = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (heredocs.length) {
          if (line === heredocs[0]) heredocs.shift();
          continue;
        }
        const continuedLine = continuation;
        continuation = /\\$/.test(line);
        const continuedString = !!quote || substitutionDepth > 0;
        for (let j = 0; j < line.length; j++) {
          if (line[j] === '\\') {
            j++;
            continue;
          }
          if (!quote && line[j] === '#') break;
          if (!quote && line[j] === '$' && line[j + 1] === '(') {
            substitutionDepth++;
            j++;
            continue;
          }
          if (!quote && substitutionDepth > 0) {
            if (line[j] === '(') substitutionDepth++;
            if (line[j] === ')') substitutionDepth--;
          }
          if (line[j] === quote) quote = undefined;
          else if (!quote && (line[j] === "'" || line[j] === '"' || line[j] === '`'))
            quote = line[j];
        }
        for (const hd of line.matchAll(/<<-?\s*['"]?(\w+)/g)) heredocs.push(hd[1]);
        if (continuedString || continuedLine) continue;
        if (kind === 'dockerfile') {
          const instruction =
            /^(FROM|EXPOSE|ENTRYPOINT|CMD|ARG|ENV|RUN|WORKDIR|COPY|ADD|USER|LABEL|SHELL|HEALTHCHECK)\s+(.*)$/i.exec(
              line
            );
          if (!instruction) continue;
          const op = instruction[1].toUpperCase(),
            arg = instruction[2];
          if (op === 'FROM') {
            flush(i);
            name = `stage-${sections.length}`;
            start = i + 1;
          }
          records.push({
            instruction: op,
            value:
              op === 'ENV' || op === 'ARG'
                ? dockerEnvKeys(arg)
                : op === 'FROM' || op === 'EXPOSE'
                  ? safeInfraLiteral(arg.replace(/\s+#.*$/, ''))
                  : command(arg)
          });
        } else {
          if (/^#\s*(?:[-=]{3,}|region\b)/i.test(line)) {
            flush(i);
            name = `section-${sections.length}`;
            start = i + 1;
            continue;
          }
          const fn = /^(?:function\s+)?([\w]+)\s*\(\s*\)\s*\{|^function\s+([\w]+)\s*\{/.exec(line);
          if (fn) {
            flush(i);
            name = fn[1] || fn[2];
            start = i + 1;
            records.push({ function: name });
            continue;
          }
          const assignment = /^(?:export\s+)?([\w]+)=/.exec(line);
          if (assignment) records.push({ environment: { [assignment[1]]: REDACTED } });
          else if (/^[\w./-]+(?:\s|$)/.test(line)) records.push({ command: command(line) });
        }
      }
      flush(lines.length);
    }
  } catch {
    // Fail closed: malformed infrastructure must not enter generic/raw parsers.
    return { kind, sections: [] };
  }
  return { kind, sections };
}
