import { createRequire } from 'module';
import { ParsedCodeDocument, CodeSymbol } from './types.js';

const localRequire = createRequire(import.meta.url);

const LANGUAGE_EXT_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.cs': 'c_sharp',
  '.rb': 'ruby',
  '.swift': 'swift',
  '.kt': 'kotlin',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp'
};

let TreeSitter: any = null;
let parserInstance: any = null;
let parserInitPromise: Promise<void> | null = null;
const languageCache = new Map<string, any>();

async function getParser(langName: string): Promise<any> {
  if (langName === 'unknown') return null;

  if (!TreeSitter) {
    TreeSitter = localRequire('web-tree-sitter');
  }

  if (!parserInitPromise) {
    parserInitPromise = TreeSitter.init();
  }
  await parserInitPromise;
  
  if (!parserInstance) {
    parserInstance = new TreeSitter();
  }

  if (!languageCache.has(langName)) {
    try {
      const wasmPath = localRequire.resolve(`tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);
      const lang = await TreeSitter.Language.load(wasmPath);
      languageCache.set(langName, lang);
    } catch (e) {
      console.error(`Failed to load tree-sitter language: ${langName}`, e);
      return null;
    }
  }

  parserInstance.setLanguage(languageCache.get(langName)!);
  return parserInstance;
}

export function detectLanguage(filePath: string): string {
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  return LANGUAGE_EXT_MAP[ext] || 'unknown';
}

const METHOD_TYPES = new Set([
  'method_definition',
  'method_declaration',
  'method_decl',
]);

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'arrow_function',
  'function_item',
  'func_decl',
]);

const INTERFACE_TYPES = new Set([
  'interface_declaration',
  'interface_type',
  'trait_item',
]);

const CLASS_TYPES = new Set([
  'class_declaration',
  'class_definition',
  'type_declaration',
  'struct',
  'type_spec',
]);

const IMPORT_TYPES = new Set([
  'import_statement',
  'import_declaration',
  'import_from_statement',
  'use_declaration',
  'import_spec',
]);

function symbolKindForNode(nodeType: string): CodeSymbol['kind'] {
  if (METHOD_TYPES.has(nodeType)) return 'method';
  if (FUNCTION_TYPES.has(nodeType)) return 'function';
  if (INTERFACE_TYPES.has(nodeType)) return 'interface';
  if (CLASS_TYPES.has(nodeType)) {
    if (nodeType === 'struct' || nodeType === 'type_spec') return 'struct';
    return 'class';
  }
  return 'function';
}

/** Extract module/path targets from an import AST node. */
function extractImportTargets(node: any): string[] {
  const targets: string[] = [];
  const seen = new Set<string>();

  function add(text: string | undefined) {
    if (!text) return;
    const cleaned = text.replace(/^['"]|['"]$/g, '').trim();
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    targets.push(cleaned);
  }

  function walk(n: any) {
    if (!n) return;
    // JS/TS: string after `from` or bare `import 'x'`
    if (n.type === 'string' || n.type === 'string_fragment') {
      add(n.text);
      return;
    }
    // Python: dotted_name / relative_import under import_from_statement
    if (n.type === 'dotted_name' || n.type === 'relative_import') {
      add(n.text);
      return;
    }
    // Go: import_spec with path
    if (n.type === 'interpreted_string_literal' || n.type === 'raw_string_literal') {
      add(n.text);
      return;
    }
    // Rust use_declaration path
    if (n.type === 'scoped_identifier' || n.type === 'identifier') {
      // Only take top-level path-ish identifiers inside use/import, not every child id
      return;
    }
    for (let i = 0; i < n.childCount; i++) {
      walk(n.child(i));
    }
  }

  // Also collect named imports as secondary targets (e.g. { ChunksRepo })
  // Prefer field-named source/path when available
  const sourceField =
    node.childForFieldName?.('source') ||
    node.childForFieldName?.('path') ||
    node.children?.find?.((c: any) =>
      c.type === 'string' ||
      c.type === 'interpreted_string_literal' ||
      c.type === 'raw_string_literal'
    );
  if (sourceField) {
    add(sourceField.text);
  }

  // Fallback walk for string literals if no source field
  if (targets.length === 0) {
    walk(node);
  }

  // For JS/TS import { Foo } from './bar' — also note PascalCase imported bindings
  if (node.type === 'import_statement' || node.type === 'import_declaration') {
    const collectIds = (n: any) => {
      if (!n) return;
      if (n.type === 'identifier') {
        const t = n.text;
        if (t && t !== 'from' && t !== 'import' && t !== 'as' && t.length > 1 && /^[A-Z]/.test(t)) {
          if (!seen.has(t)) {
            seen.add(t);
            targets.push(t);
          }
        }
      }
      for (let i = 0; i < (n.childCount || 0); i++) collectIds(n.child(i));
    };
    collectIds(node);
  }

  return targets;
}

export async function parseCode(filePath: string, rawContent: string): Promise<ParsedCodeDocument> {
  const language = detectLanguage(filePath);
  const symbols: CodeSymbol[] = [];
  const imports: string[] = [];

  const parser = await getParser(language);
  if (!parser) {
    return { filePath, language, symbols, imports, rawContent };
  }

  parser.reset();
  const tree = parser.parse(rawContent);

  try {
    function traverse(node: any, parentName?: string, insideFunction = false) {
      let currentParent = parentName;

      if (IMPORT_TYPES.has(node.type)) {
        const targets = extractImportTargets(node);
        for (const target of targets) {
          imports.push(target);
          symbols.push({
            name: target,
            kind: 'import',
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            body: node.text,
            parent: currentParent,
          });
        }
        // Don't recurse into import children as functions/classes
        return;
      }

      if (METHOD_TYPES.has(node.type) || FUNCTION_TYPES.has(node.type)) {
        let nameNode = node.childForFieldName('name');
        // arrow_function has no name field — only name it when it is the direct
        // initializer of a variable (const foo = () => {}), never when nested in .map().
        if (!nameNode && node.type === 'arrow_function') {
          let p = node.parent;
          if (p?.type === 'parenthesized_expression') p = p.parent;
          if (p?.type === 'variable_declarator') {
            nameNode = p.childForFieldName('name')
              || p.children?.find((c: any) => c.type === 'identifier');
          }
          // else leave unnamed (anonymous callback) — skipped below
        } else if (!nameNode) {
          nameNode = node.children?.find((c: any) => c.type === 'identifier' || c.type === 'name');
        }
        // Skip nested helpers inside another function (e.g. const runFTS = () => inside matchChunks)
        if (insideFunction && node.type === 'arrow_function') {
          return;
        }
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: symbolKindForNode(node.type),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            body: node.text,
            parent: currentParent
          });
        }
        for (let i = 0; i < node.childCount; i++) {
          traverse(node.child(i)!, currentParent, true);
        }
        return;
      } else if (INTERFACE_TYPES.has(node.type) || CLASS_TYPES.has(node.type)) {
        const nameNode = node.childForFieldName('name') || node.children.find((c: any) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name');
        if (nameNode) {
          const className = nameNode.text;
          symbols.push({
            name: className,
            kind: symbolKindForNode(node.type),
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            body: node.text,
            parent: currentParent
          });
          currentParent = className;
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        traverse(node.child(i)!, currentParent, insideFunction);
      }
    }

    traverse(tree.rootNode);

    // Index top-level template-literal / large string constants (e.g. SQL DDL schemas)
    // that tree-sitter would otherwise leave as unchunked lexical content.
    extractTopLevelStringConsts(tree.rootNode, rawContent, symbols);
  } finally {
    // Free WASM tree memory (B13)
    try {
      tree.delete();
    } catch {
      // ignore if delete unsupported
    }
  }

  return {
    filePath,
    language,
    symbols,
    imports: Array.from(new Set(imports)),
    rawContent,
  };
}

/**
 * Emit variable symbols for top-level const/let/var declarations whose
 * initializer is a large template literal or string (>~200 chars).
 */
function extractTopLevelStringConsts(root: any, rawContent: string, symbols: CodeSymbol[]) {
  const existing = new Set(symbols.map(s => s.name));
  for (let i = 0; i < root.childCount; i++) {
    const node = root.child(i);
    if (!node) continue;
    // lexical_declaration / variable_declaration / export_statement wrapping them
    let decl = node;
    if (node.type === 'export_statement') {
      decl = node.children?.find((c: any) =>
        c.type === 'lexical_declaration' || c.type === 'variable_declaration'
      );
      if (!decl) continue;
    }
    if (decl.type !== 'lexical_declaration' && decl.type !== 'variable_declaration') continue;

    for (let j = 0; j < decl.childCount; j++) {
      const child = decl.child(j);
      if (!child || child.type !== 'variable_declarator') continue;
      const nameNode = child.childForFieldName('name')
        || child.children?.find((c: any) => c.type === 'identifier');
      const valueNode = child.childForFieldName('value')
        || child.children?.find((c: any) =>
          c.type === 'template_string' || c.type === 'string' || c.type === 'string_fragment'
        );
      if (!nameNode || !valueNode) continue;
      const name = nameNode.text;
      if (!name || existing.has(name)) continue;
      const body = valueNode.text || '';
      if (body.length < 200) continue;
      // Prefer template strings / multi-line strings
      const isTemplate = valueNode.type === 'template_string' || body.includes('\n');
      if (!isTemplate && body.length < 400) continue;
      symbols.push({
        name,
        kind: 'variable',
        startLine: (node.type === 'export_statement' ? node : decl).startPosition.row + 1,
        endLine: (node.type === 'export_statement' ? node : decl).endPosition.row + 1,
        // Prefer full export_statement text so markers like `export const X` survive
        body: (node.type === 'export_statement' ? node.text : null) || decl.text || child.text,
      });
      existing.add(name);
    }
  }
}
