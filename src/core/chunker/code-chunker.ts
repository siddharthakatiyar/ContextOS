import crypto from 'crypto';
import { ParsedCodeDocument, CodeSymbol } from '../parser/types.js';
import { Chunk } from '../storage/types.js';
import { ChunkCreationOptions } from './types.js';
import { estimateTokens } from '../../utils/tokens.js';
import { loadConfig } from '../../config/index.js';
import { hashContent } from '../../utils/hash.js';
import { extractKeywords } from './index.js';

export function chunkCode(doc: ParsedCodeDocument, options: ChunkCreationOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const config = loadConfig();
  const maxTokens = options.maxChunkTokens || config.maxChunkTokens;

  for (const symbol of doc.symbols) {
    // Only chunk meaningful symbols, skipping basic variable declarations if we had them
    if (['import', 'variable'].includes(symbol.kind) && doc.symbols.length > 50) {
      // In large files, maybe skip individual imports, but for now we keep them
    }

    const titleContext = symbol.parent ? `${symbol.parent} > ${symbol.name}` : symbol.name;
    let tokens = estimateTokens(`File: ${doc.filePath}\n` + symbol.body);

    // If body is huge (e.g. large struct), we'd split it, but for V1 we keep it as one
    chunks.push(createCodeChunk(symbol, titleContext, doc.filePath, doc.language, options));
  }

  // Also create a "File Summary" chunk that lists all symbols for high-level graph
  const summaryContent = doc.symbols.map(s => `- [${s.kind}] ${s.name}`).join('\n');
  if (summaryContent.trim().length > 0) {
    const summaryHashVal = hashContent(summaryContent);
    const idStr = `${doc.filePath}:File Summary:${summaryHashVal}`;
    const id = crypto.createHash('md5').update(idStr).digest('hex');
    
    chunks.push({
      id,
      sourceFile: doc.filePath,
      layer: options.layer,
      workspaceName: options.workspaceName || null,
      sectionTitle: 'File Structure',
      sectionDepth: 1,
      content: `File: ${doc.filePath}\nLanguage: ${doc.language}\n\nSymbols:\n${summaryContent}`,
      summary: null,
      keywords: extractKeywords(summaryContent, 'File Structure').join(', '),
      hash: summaryHashVal,
      importance: options.importance ?? 5,
      tokenCount: estimateTokens(summaryContent),
      fileType: 'code',
      language: doc.language,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  return chunks;
}

function createCodeChunk(symbol: CodeSymbol, titleContext: string, filePath: string, language: string, options: ChunkCreationOptions): Chunk {
  const keywords = extractKeywords(symbol.body, titleContext);
  // Add full symbol name itself as a keyword
  if (symbol.name.length > 2) keywords.push(symbol.name.toLowerCase());
  // And also its parts
  keywords.push(...symbol.name.split(/(?=[A-Z])|_|-|\./).map(s => s.toLowerCase()).filter(s => s.length > 2));
  
  const contentHashVal = hashContent(symbol.body);
  const idStr = `${filePath}:${titleContext}:${contentHashVal}`;
  const id = crypto.createHash('md5').update(idStr).digest('hex');
  
  return {
    id,
    sourceFile: filePath,
    layer: options.layer,
    workspaceName: options.workspaceName || null,
    sectionTitle: titleContext || null,
    sectionDepth: 2, // code symbols are usually nested under file
    content: symbol.body,
    summary: symbol.docstring || null,
    keywords: Array.from(new Set(keywords)).join(', '),
    hash: contentHashVal,
    importance: options.importance ?? 5,
    tokenCount: estimateTokens(`File: ${filePath}\n` + symbol.body),
    fileType: 'code',
    language,
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
