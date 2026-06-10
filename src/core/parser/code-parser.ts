import { createRequire } from 'module';
import { ParsedCodeDocument, CodeSymbol } from './types.js';

const require = createRequire(import.meta.url);

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
    TreeSitter = require('web-tree-sitter');
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
      const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);
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
    return { filePath, language, symbols };
  }

  const tree = parser.parse(rawContent);

  function traverse(node: any, parentName?: string) {
    if (FUNCTION_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName('name') || node.children.find((c: any) => c.type === 'identifier' || c.type === 'name');
      if (nameNode) {
        symbols.push({
          name: nameNode.text,
          kind: 'function',
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          body: node.text,
          parent: parentName
        });
      }
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
          parent: parentName
        });
        parentName = className;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      traverse(node.child(i)!, parentName);
    }
  }

  traverse(tree.rootNode);

  return {
    filePath,
    language,
    symbols
  };
}
