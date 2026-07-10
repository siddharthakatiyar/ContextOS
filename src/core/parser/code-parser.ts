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

const FUNCTION_TYPES = new Set([
  'function_declaration', 
  'function_definition', 
  'method_definition', 
  'method_declaration', 
  'arrow_function', 
  'function_item', 
  'func_decl',
  'method_decl'
]);

const CLASS_TYPES = new Set([
  'class_declaration', 
  'class_definition', 
  'type_declaration', 
  'struct', 
  'interface_declaration', 
  'trait_item',
  'type_spec'
]);

export async function parseCode(filePath: string, rawContent: string): Promise<ParsedCodeDocument> {
  const language = detectLanguage(filePath);
  const symbols: CodeSymbol[] = [];

  const parser = await getParser(language);
  if (!parser) {
    return { filePath, language, symbols, rawContent };
  }

  parser.reset();
  const tree = parser.parse(rawContent);

  function traverse(node: any, parentName?: string, insideFunction = false) {
    let currentParent = parentName;
    if (FUNCTION_TYPES.has(node.type)) {
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
          kind: 'function',
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
    } else if (CLASS_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName('name') || node.children.find((c: any) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name');
      if (nameNode) {
        const className = nameNode.text;
        symbols.push({
          name: className,
          kind: 'class',
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

  return {
    filePath,
    language,
    symbols,
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
