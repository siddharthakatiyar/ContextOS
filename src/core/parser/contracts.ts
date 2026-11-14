import { createRequire } from 'node:module';
import type { CodeSymbol, ParsedCodeDocument } from './types.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as {
  load: (source: string, options: { schema: unknown }) => unknown;
  JSON_SCHEMA: unknown;
};
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function jsonData(input: unknown): unknown {
  let count = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++count > 20000 || depth > 64) throw new Error('Contract exceeds inspection limits.');
    if (!value || typeof value !== 'object') return value;
    if (ancestors.has(value)) throw new Error('Cyclic YAML aliases are not supported.');
    ancestors.add(value);
    const result = Array.isArray(value)
      ? value.map((item) => copy(item, depth + 1))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, copy(item, depth + 1)])
        );
    ancestors.delete(value);
    return result;
  };
  return copy(input, 0);
}
export interface ContractOperation {
  protocol: 'http' | 'grpc';
  id: string;
  method: string;
  path: string;
  request?: unknown;
  response?: unknown;
  parameters?: unknown;
  clientStreaming?: boolean;
  serverStreaming?: boolean;
  startLine: number;
  endLine: number;
}
export interface ContractDocument {
  format: 'openapi' | 'protobuf';
  operations: ContractOperation[];
  schemas: ObjectValue;
}

/** Parse contracts on demand. External references are retained, never silently fetched. */
export function inspectOpenApi(content: string): ContractDocument | null {
  if (Buffer.byteLength(content) > 2 * 1024 * 1024)
    throw new Error('Contract exceeds the 2 MiB inspection limit.');
  const document = jsonData(yaml.load(content, { schema: yaml.JSON_SCHEMA }));
  if (!object(document)) return null;
  if (
    !(typeof document.openapi === 'string' && /^3\./.test(document.openapi)) &&
    document.swagger !== '2.0'
  )
    return null;
  if (!object(document.paths)) throw new Error('OpenAPI contract has no paths object.');
  const operations: ContractOperation[] = [];
  for (const [route, raw] of Object.entries(document.paths)) {
    if (!route.startsWith('/') || !object(raw)) continue;
    for (const method of ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']) {
      const operation = raw[method];
      if (!object(operation)) continue;
      operations.push({
        protocol: 'http',
        id:
          typeof operation.operationId === 'string'
            ? operation.operationId
            : `${method.toUpperCase()} ${route}`,
        method: method.toUpperCase(),
        path: route,
        request: operation.requestBody,
        response: operation.responses,
        parameters: [
          ...(Array.isArray(raw.parameters) ? raw.parameters : []),
          ...(Array.isArray(operation.parameters) ? operation.parameters : [])
        ],
        startLine: 1,
        endLine: content.split('\n').length
      });
    }
  }
  const components = object(document.components) ? document.components : {};
  return {
    format: 'openapi',
    operations,
    schemas: object(components.schemas)
      ? components.schemas
      : object(document.definitions)
        ? document.definitions
        : {}
  };
}

type Token = { text: string; offset: number };
function protoTokens(source: string): Token[] {
  const tokens: Token[] = [];
  const pattern =
    /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\.?[A-Za-z_][\w.]*|[{}();]|\S/g;
  for (const match of source.matchAll(pattern)) {
    if (match[0].startsWith('//') || match[0].startsWith('/*')) continue;
    tokens.push({ text: match[0], offset: match.index! });
  }
  return tokens;
}
export function inspectProtobuf(content: string): ContractDocument {
  const tokens = protoTokens(content);
  const operations: ContractOperation[] = [];
  let packageName = '';
  let depth = 0;
  const line = (offset: number) => content.slice(0, offset).split('\n').length;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i].text;
    if (token === '{') {
      depth++;
      continue;
    }
    if (token === '}') {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    if (token === 'package' && tokens[i + 2]?.text === ';') {
      packageName = tokens[i + 1].text;
      continue;
    }
    if (token !== 'service' || tokens[i + 2]?.text !== '{') continue;
    const service = `${packageName ? packageName + '.' : ''}${tokens[i + 1].text}`;
    i += 3;
    let serviceDepth = 1;
    for (; i < tokens.length && serviceDepth; i++) {
      const start = i;
      const word = tokens[i].text;
      if (word === '{') {
        serviceDepth++;
        continue;
      }
      if (word === '}') {
        serviceDepth--;
        continue;
      }
      if (word !== 'rpc' || serviceDepth !== 1) continue;
      const method = tokens[++i]?.text;
      if (!method || tokens[++i]?.text !== '(') throw new Error('Malformed protobuf RPC.');
      let clientStreaming = false;
      if (tokens[++i]?.text === 'stream') {
        clientStreaming = true;
        i++;
      }
      const request = tokens[i]?.text;
      if (tokens[++i]?.text !== ')' || tokens[++i]?.text !== 'returns' || tokens[++i]?.text !== '(')
        throw new Error('Malformed protobuf RPC signature.');
      let serverStreaming = false;
      if (tokens[++i]?.text === 'stream') {
        serverStreaming = true;
        i++;
      }
      const response = tokens[i]?.text;
      if (!request || !response || tokens[++i]?.text !== ')')
        throw new Error('Malformed protobuf RPC response.');
      const end = i;
      operations.push({
        protocol: 'grpc',
        id: `/${service}/${method}`,
        method,
        path: `/${service}/${method}`,
        request,
        response,
        clientStreaming,
        serverStreaming,
        startLine: line(tokens[start].offset),
        endLine: line(tokens[end].offset)
      });
    }
    if (serviceDepth) throw new Error('Unclosed protobuf service.');
    i--;
  }
  return { format: 'protobuf', operations, schemas: {} };
}

export function parseProtobuf(filePath: string, content: string): ParsedCodeDocument {
  const contract = inspectProtobuf(content);
  const lines = content.split('\n');
  const symbols: CodeSymbol[] = contract.operations.map((operation) => ({
    name: operation.id,
    kind: 'method',
    startLine: operation.startLine,
    endLine: operation.endLine,
    body: lines.slice(operation.startLine - 1, operation.endLine).join('\n'),
    docstring: `${operation.id}: ${operation.request} -> ${operation.response}`
  }));
  return { filePath, language: 'protobuf', symbols, rawContent: content };
}

export function parseOpenApi(filePath: string, content: string): ParsedCodeDocument | null {
  if (!/["']?(?:openapi|swagger)["']?\s*:/.test(content)) return null;
  const contract = inspectOpenApi(content);
  if (!contract) return null;
  // A normalized operation may reference several distant schema sections. Cite
  // the complete source contract rather than inventing precise YAML line ranges.
  const endLine = content.split('\n').length;
  const symbols: CodeSymbol[] = contract.operations.map((operation) => ({
    name: `${operation.method} ${operation.path} (${operation.id})`,
    kind: 'method',
    startLine: 1,
    endLine,
    body: JSON.stringify(operation, null, 2)
  }));
  for (const [name, schema] of Object.entries(contract.schemas))
    symbols.push({
      name: `schema ${name}`,
      kind: 'type',
      startLine: 1,
      endLine,
      body: JSON.stringify(schema, null, 2)
    });
  return { filePath, language: 'openapi', symbols, rawContent: content };
}
