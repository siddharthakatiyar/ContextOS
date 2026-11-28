import fs from 'node:fs';
import path from 'node:path';
import { inspectOpenApi, inspectProtobuf, type ContractDocument } from '../parser/contracts.js';
import { applyHunks, gitText, type ChangedFile } from './diff.js';

export interface ContractChange {
  kind: 'operation' | 'schema' | 'message';
  name: string;
  change: 'added' | 'removed' | 'changed';
}

function inspect(file: string, content: string): ContractDocument | null {
  if (!content.trim())
    return {
      format: file.endsWith('.proto') ? 'protobuf' : 'openapi',
      operations: [],
      schemas: {}
    };
  return file.endsWith('.proto') ? inspectProtobuf(content) : inspectOpenApi(content);
}
function entries(document: ContractDocument, content: string): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const operation of document.operations) {
    const signature = Object.fromEntries(
      Object.entries(operation).filter(([key]) => key !== 'startLine' && key !== 'endLine')
    );
    result.set('operation:' + operation.method + ' ' + operation.path, signature);
  }
  for (const [name, schema] of Object.entries(document.schemas))
    result.set('schema:' + name, schema);
  if (document.format === 'protobuf') {
    // Reuse the inspector for RPCs; tokenize message bodies to preserve field changes,
    // nested identities and braces inside string literals without inventing field semantics.
    const tokens = [
      ...content.matchAll(
        /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_][\w.]*|[^\s]/g
      )
    ]
      .map((match) => match[0])
      .filter((token) => !token.startsWith('//') && !token.startsWith('/*'));
    const packageIndex = tokens.indexOf('package');
    const prefix = packageIndex >= 0 ? tokens[packageIndex + 1] + '.' : '';
    const messages: { name: string; start: number; end: number }[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== 'message' || !/^\w+$/.test(tokens[i + 1] ?? '') || tokens[i + 2] !== '{')
        continue;
      let end = i + 3,
        depth = 1;
      for (; end < tokens.length && depth; end++) {
        if (tokens[end] === '{') depth++;
        if (tokens[end] === '}') depth--;
      }
      if (depth) throw new Error('Unclosed protobuf message.');
      const parent = messages.filter((message) => message.start < i && message.end > i).at(-1);
      const name = (parent ? parent.name + '.' : prefix) + tokens[i + 1];
      messages.push({ name, start: i, end });
      result.set('message:' + name, tokens.slice(i, end).join(' '));
    }
  }
  return result;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)])
      )
    );
  return JSON.stringify(value) ?? 'undefined';
}
export function diffContracts(
  file: string,
  before: string,
  after: string
): ContractChange[] | null {
  if ([before, after].some((content) => Buffer.byteLength(content) > 2 * 1024 * 1024))
    throw new Error('Contract exceeds 2 MiB.');
  const old = inspect(file, before),
    next = inspect(file, after);
  if (!old || !next) return null;
  const a = entries(old, before),
    b = entries(next, after);
  return [...new Set([...a.keys(), ...b.keys()])].sort().flatMap((key) => {
    if (a.has(key) && b.has(key) && canonical(a.get(key)) === canonical(b.get(key))) return [];
    const colon = key.indexOf(':');
    return [
      {
        kind: key.slice(0, colon) as ContractChange['kind'],
        name: key.slice(colon + 1),
        change: !a.has(key)
          ? ('added' as const)
          : !b.has(key)
            ? ('removed' as const)
            : ('changed' as const)
      }
    ];
  });
}

export function contractVersions(
  root: string,
  file: ChangedFile,
  base?: string,
  head?: string
): [string, string] | undefined {
  try {
    let before: string | undefined;
    if (file.status === 'added') before = '';
    else {
      try {
        before = gitText(root, ['show', `${base ?? 'HEAD'}:${file.oldPath ?? file.path}`]);
      } catch {
        // A supplied patch may describe an uncommitted contract absent from HEAD.
        // Its on-disk content is usable only if the patch matches exactly below.
      }
    }
    if (base && head) {
      if (before === undefined) return undefined;
      return [
        before,
        file.status === 'deleted' ? '' : gitText(root, ['show', `${head}:${file.path}`])
      ];
    }
    if (file.status === 'deleted' && before !== undefined) return [before, ''];
    if (file.hunks?.length) {
      const reversed = file.hunks.map((hunk) => ({
        oldStart: hunk.newStart,
        newStart: hunk.oldStart,
        oldCount: hunk.newCount,
        newCount: hunk.oldCount,
        lines: hunk.lines.map((line) =>
          line[0] === '+' ? '-' + line.slice(1) : line[0] === '-' ? '+' + line.slice(1) : line
        )
      }));
      if (before !== undefined) {
        const after = applyHunks(before, file.hunks);
        if (after !== undefined) return [before, after];
        const previous = applyHunks(before, reversed);
        if (previous !== undefined) return [previous, before];
      }
      const current = fs.readFileSync(path.join(root, file.path), 'utf8');
      const old = applyHunks(current, reversed);
      if (old !== undefined) return [old, current];
      const next = applyHunks(current, file.hunks);
      if (next !== undefined) return [current, next];
    }
    return undefined;
  } catch {
    return undefined;
  }
}
