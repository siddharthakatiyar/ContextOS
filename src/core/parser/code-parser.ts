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

const METHOD_TYPES = new Set(['method_definition', 'method_declaration', 'method_decl']);

const FUNCTION_TYPES = new Set([
  'function_declaration',
  'function_definition',
  'arrow_function',
  'function_item',
  'func_decl'
]);

const INTERFACE_TYPES = new Set([
  'interface_declaration',
  'interface_type',
  'trait_item',
  'type_alias_declaration'
]);

const CLASS_TYPES = new Set([
  'class_declaration',
  'class_definition',
  'type_declaration',
  'type_definition',
  'struct',
  'struct_specifier',
  'type_spec',
  'enum_declaration',
  'enum_specifier'
]);

const IMPORT_TYPES = new Set([
  'import_statement',
  'import_declaration',
  'import_from_statement',
  'use_declaration',
  'import_spec'
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

function extractDocstring(node: any, isExport: boolean): string | undefined {
  const target = isExport ? node.parent : node;
  let prev = target?.previousSibling;

  if (node.type === 'function_definition' || node.type === 'class_definition') {
    const body = node.childForFieldName('body');
    if (body) {
      const firstExpr = body.children?.find((c: any) => c.type === 'expression_statement');
      if (firstExpr && firstExpr.child(0)?.type === 'string') {
        return firstExpr.child(0).text;
      }
    }
  }

  const comments: string[] = [];
  while (prev && prev.type === 'comment') {
    comments.unshift(prev.text);
    prev = prev.previousSibling;
  }

  if (comments.length > 0) {
    const raw = comments.join('\n');
    const lines = raw
      .split('\n')
      .map((l) =>
        l
          .replace(/^\s*\/\*\*?/, '')
          .replace(/\*\/$/, '')
          .replace(/^\s*\*/, '')
          .replace(/^\s*\/\/\/?/, '')
          .trim()
      )
      .filter((l) => l.length > 0);
    return lines.join(' ').replace(/\s+/g, ' ').slice(0, 300) || undefined;
  }
  return undefined;
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
    node.children?.find?.(
      (c: any) =>
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
            parent: currentParent
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
            nameNode =
              p.childForFieldName('name') || p.children?.find((c: any) => c.type === 'identifier');
          }
          // else leave unnamed (anonymous callback) — skipped below
        } else if (!nameNode) {
          nameNode = node.childForFieldName?.('declarator');
          if (!nameNode)
            nameNode = node.children?.find(
              (c: any) =>
                c.type === 'function_declarator' ||
                c.type === 'pointer_declarator' ||
                c.type === 'array_declarator' ||
                c.type === 'init_declarator'
            );
          if (!nameNode)
            nameNode = node.children?.find(
              (c: any) =>
                c.type === 'identifier' || c.type === 'name' || c.type === 'type_identifier'
            );
        }

        // C/C++ AST: function identifier is often inside a nested declarator (e.g. function_declarator)
        if (
          nameNode &&
          (nameNode.type === 'function_declarator' ||
            nameNode.type === 'pointer_declarator' ||
            nameNode.type === 'array_declarator' ||
            nameNode.type === 'init_declarator' ||
            nameNode.type === 'type_definition')
        ) {
          let current = nameNode;
          let iterCount = 0;
          while (
            current &&
            current.type !== 'identifier' &&
            current.type !== 'type_identifier' &&
            current.type !== 'field_identifier'
          ) {
            iterCount++;
            if (iterCount > 50) {
              console.error('INFINITE LOOP in AST parser near', current.type);
              break;
            }
            let next = current.childForFieldName?.('declarator');
            if (!next)
              next = current.children?.find(
                (c: any) =>
                  c.type === 'identifier' ||
                  c.type === 'type_identifier' ||
                  c.type === 'field_identifier'
              );
            if (!next && current.childCount > 0) next = current.child(0);
            if (!next || next === current) break;
            current = next;
          }
          if (
            current &&
            (current.type === 'identifier' ||
              current.type === 'type_identifier' ||
              current.type === 'field_identifier')
          ) {
            nameNode = current;
          }
        }

        // Skip nested helpers inside another function (e.g. const runFTS = () => inside matchChunks)
        if (insideFunction && node.type === 'arrow_function') {
          return;
        }
        if (nameNode) {
          const isExport = node.parent?.type === 'export_statement';
          symbols.push({
            name: nameNode.text,
            kind: symbolKindForNode(node.type),
            startLine: (isExport ? node.parent! : node).startPosition.row + 1,
            endLine: (isExport ? node.parent! : node).endPosition.row + 1,
            body: isExport ? node.parent!.text : node.text,
            parent: currentParent,
            docstring: extractDocstring(node, isExport)
          });
        }
        for (let i = 0; i < node.childCount; i++) {
          traverse(node.child(i)!, currentParent, true);
        }
        return;
      } else if (INTERFACE_TYPES.has(node.type) || CLASS_TYPES.has(node.type)) {
        const nameNode =
          node.childForFieldName('name') ||
          node.children.find(
            (c: any) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name'
          );
        if (nameNode) {
          const className = nameNode.text;
          const isExport = node.parent?.type === 'export_statement';
          symbols.push({
            name: className,
            kind: symbolKindForNode(node.type),
            startLine: (isExport ? node.parent! : node).startPosition.row + 1,
            endLine: (isExport ? node.parent! : node).endPosition.row + 1,
            body: isExport ? node.parent!.text : node.text,
            parent: currentParent,
            docstring: extractDocstring(node, isExport)
          });
          currentParent = className;
        }
      }

      if (
        (node.type === 'lexical_declaration' || node.type === 'variable_declaration') &&
        !parentName &&
        !insideFunction
      ) {
        for (let j = 0; j < node.childCount; j++) {
          const child = node.child(j);
          if (child?.type === 'variable_declarator') {
            const nameNode =
              child.childForFieldName('name') ||
              child.children?.find((c: any) => c.type === 'identifier');
            if (nameNode) {
              const isExport = node.parent?.type === 'export_statement';
              const emitNode = isExport ? node.parent! : node;
              symbols.push({
                name: nameNode.text,
                kind: 'variable',
                startLine: emitNode.startPosition.row + 1,
                endLine: emitNode.endPosition.row + 1,
                body: emitNode.text,
                parent: currentParent,
                docstring: extractDocstring(node, isExport)
              });
            }
          }
        }
      }

      for (let i = 0; i < node.childCount; i++) {
        traverse(node.child(i)!, currentParent, insideFunction);
      }
    }

    traverse(tree.rootNode);
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
    rawContent
  };
}
