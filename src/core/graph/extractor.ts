import { Chunk, Relationship } from '../storage/types.js';
import { STOPWORDS as ENTITY_STOPWORDS } from '../../utils/stopwords.js';

// Common ALL_CAPS words that are NOT meaningful code entities
const ENTITY_BLOCKLIST = new Set([
  'license', 'readme', 'todo', 'note', 'fixme', 'hack', 'warning',
  'http', 'https', 'html', 'json', 'yaml', 'toml', 'xml', 'csv', 'sql',
  'true', 'false', 'null', 'none', 'undefined', 'nan',
  'desc', 'args', 'argv', 'type', 'self', 'this', 'void', 'auto',
  'then', 'else', 'case', 'enum', 'from', 'into', 'char', 'bool',
  'uint', 'byte', 'long', 'warn', 'info', 'data', 'body', 'head',
  'post', 'file', 'name', 'path', 'done', 'stop', 'exit', 'open',
  'close', 'push', 'pull', 'send', 'node', 'test', 'mock', 'skip',
  'pass', 'fail', 'socks', 'proxy', 'cert', 'utf8', 'ascii',
  'with', 'that', 'have', 'will', 'props', 'also', 'does', 'copy',
  'free', 'above', 'below', 'used', 'uses', 'using', 'shall',
  'must', 'each', 'form', 'work', 'make', 'like', 'just', 'only',
  'made', 'find', 'give', 'tell', 'call', 'take', 'come', 'want',
  'look', 'help', 'turn', 'show', 'part', 'over', 'such', 'good',
  'year', 'them', 'some', 'time', 'very', 'when', 'here', 'know',
  'left', 'right', 'back', 'much', 'well', 'down', 'even', 'last',
  'next', 'more', 'most', 'first', 'still', 'could', 'would', 'should',
  'mit', 'bsd', 'isc', 'gpl', 'mpl', 'apache',
  'ejson', 'bson', 'tdd', 'dom', 'api', 'url', 'uri',
  'npm', 'cli', 'git', 'ssh', 'ftp', 'wss', 'tcp', 'udp',
  // SQL / schema keywords that leak into Related Entities
  'select', 'insert', 'update', 'delete', 'create', 'alter', 'drop',
  'table', 'index', 'where', 'order', 'group', 'limit', 'offset',
  'values', 'join', 'inner', 'outer', 'asc', 'and', 'or', 'not',
  'set', 'as', 'on', 'in', 'exists', 'between', 'having', 'union',
  'distinct', 'primary', 'foreign', 'key', 'references', 'cascade',
  'virtual', 'trigger', 'begin', 'end', 'pragma', 'conflict',
  'constructor', 'destructor', 'prototype', 'super', 'extends',
  'implements', 'interface', 'class', 'function', 'return', 'await',
  'async', 'export', 'import', 'require', 'module', 'package',
]);

const ENTITY_PATTERNS = [
  /queue:[\w-]+/g,
  /\b[\w]+-service\b/gi,
  /\bapi\/[\w/]+/g,
  /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, // ENV_VAR_NAME with underscore
  /\b[A-Z][A-Z0-9]{4,}\b/g,             // 5+ chars ALL_CAPS
  /\btable:[\w]+/g,
  /redis:[\w:]+/g,
];

/** Weight for co-occurrence CamelCase "uses" edges (lower than imports). */
const USES_WEIGHT = 0.8;
/** Weight for explicit import-based edges. */
const IMPORTS_WEIGHT = 2.0;

/**
 * Build import relationships from parser-extracted import targets.
 * Source is the file stem or primary symbol; targets are module paths / imported names.
 */
export function extractImportRelationships(
  chunk: Chunk,
  imports: string[],
  sourceEntity?: string
): Relationship[] {
  if (!imports || imports.length === 0) return [];
  const source = sourceEntity || chunk.symbolName || chunk.fileStem || chunk.sourceFile;
  if (!source) return [];

  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  for (const target of imports) {
    const key = `${source}→${target}`;
    if (seen.has(key) || target === source) continue;
    seen.add(key);
    relationships.push({
      source,
      target,
      relationshipType: 'imports',
      weight: IMPORTS_WEIGHT,
      sourceChunkId: chunk.id,
      layer: chunk.layer,
      createdAt: Date.now(),
    });
  }
  return relationships;
}

export function extractRelationships(chunk: Chunk): Relationship[] {
  const relationships: Relationship[] = [];
  const content = chunk.content;
  const title = chunk.sectionTitle || '';

  // Skip node_modules and other junk sources entirely
  if (chunk.sourceFile && /node_modules|\.git\/|dist\/|build\/|\.next\/|coverage\//.test(chunk.sourceFile)) {
    return relationships;
  }

  // Helper to extract entities
  const extractEntities = (text: string): string[] => {
    const entities = new Set<string>();
    for (const pattern of ENTITY_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        for (const m of matches) {
          const lower = m.toLowerCase();
          if (lower.length < 3) continue;           // too short
          if (ENTITY_STOPWORDS.has(lower)) continue; // natural language stopword
          if (ENTITY_BLOCKLIST.has(lower)) continue;  // known noise entity
          if (/^\d+$/.test(lower)) continue;          // pure number
          entities.add(lower);
        }
      }
    }
    return Array.from(entities);
  };

  // Sort entities by length descending (longer entities are usually more specific)
  // and cap them to prevent combinatorial explosion.
  const contentEntities = extractEntities(content).sort((a, b) => b.length - a.length).slice(0, 10);
  const titleEntities = extractEntities(title).sort((a, b) => b.length - a.length).slice(0, 5);

  // 1. Title entities reference content entities
  for (const tEntity of titleEntities) {
    for (const cEntity of contentEntities) {
      if (tEntity !== cEntity) {
        relationships.push({
          source: tEntity,
          target: cEntity,
          relationshipType: 'references',
          weight: 1.0,
          sourceChunkId: chunk.id,
          layer: chunk.layer,
          createdAt: Date.now()
        });
      }
    }
  }

  // 2. Regex based explicit relationships
  const explicitPatterns = [
    { regex: /([a-z0-9:-]+(?:\s+service)?)\s+(?:→|->|produces)\s+([a-z0-9:-]+)/gi, type: 'produces' },
    { regex: /([a-z0-9:-]+(?:\s+service)?)\s+consumes\s+([a-z0-9:-]+)/gi, type: 'consumes' },
    { regex: /([a-z0-9:-]+(?:\s+service)?)\s+depends\s*on\s+([a-z0-9:-]+)/gi, type: 'depends_on' },
    { regex: /([a-z0-9:-]+(?:\s+service)?)\s+calls\s+([a-z0-9:-]+)/gi, type: 'calls' },
  ];

  for (const { regex, type } of explicitPatterns) {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const source = match[1].toLowerCase().replace(/\s+/g, '-');
      const target = match[2].toLowerCase().replace(/\s+/g, '-');
      if (source !== target) {
        relationships.push({
          source,
          target,
          relationshipType: type,
          weight: 2.0, // explicit relationships have higher weight
          sourceChunkId: chunk.id,
          layer: chunk.layer,
          createdAt: Date.now()
        });
      }
    }
  }

  // 3. Code-specific relationships (co-occurrence CamelCase → lower-weight "uses")
  if (chunk.fileType === 'code' && chunk.symbolName) {
    // Extract potential symbol references (CamelCase or PascalCase names)
    const codeWords = (content + ' ' + title).match(/\b[A-Z][a-zA-Z0-9_]*\b|\b[a-z]+[A-Z][a-zA-Z0-9_]*\b/g) || [];
    const uniqueSymbols = Array.from(new Set(codeWords)).filter(w => w !== chunk.symbolName && w.length > 3 && !ENTITY_STOPWORDS.has(w.toLowerCase()));
    
    for (const sym of uniqueSymbols) {
      const isImport = chunk.symbolKind === 'import';
      relationships.push({
        source: chunk.symbolName,
        target: sym,
        relationshipType: isImport ? 'imports' : 'uses',
        weight: isImport ? IMPORTS_WEIGHT : USES_WEIGHT,
        sourceChunkId: chunk.id,
        layer: chunk.layer,
        createdAt: Date.now()
      });
    }
  }

  // 4. Regex fallback for import statements in content (when parser imports not attached)
  const importRegex = /(?:import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|from\s+([.\w]+)(?:\s+import)|require\s*\(\s*['"]([^'"]+)['"]\s*\))/g;
  let importMatch;
  const regexImports: string[] = [];
  while ((importMatch = importRegex.exec(content)) !== null) {
    const target = importMatch[1] || importMatch[2] || importMatch[3];
    if (target) regexImports.push(target);
  }
  if (regexImports.length > 0) {
    relationships.push(...extractImportRelationships(chunk, regexImports));
  }

  return relationships;
}
