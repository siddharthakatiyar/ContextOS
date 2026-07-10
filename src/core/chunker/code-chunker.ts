import crypto from 'crypto';
import path from 'path';
import { ParsedCodeDocument, CodeSymbol } from '../parser/types.js';
import { Chunk } from '../storage/types.js';
import { ChunkCreationOptions } from './types.js';
import { estimateTokens } from '../../utils/tokens.js';
import { loadConfig } from '../../config/index.js';
import { hashContent } from '../../utils/hash.js';
import { extractKeywords } from './index.js';

function fileStemFromPath(filePath: string): string {
  const base = path.basename(filePath);
  return base.includes('.') ? base.replace(/\.[^.]+$/, '') : base;
}

/** Stable chunk ID: survives content edits (B7). Hash field still tracks content changes. */
function stableChunkId(filePath: string, symbolPathOrTitle: string): string {
  return crypto.createHash('md5').update(`${filePath}:${symbolPathOrTitle}`).digest('hex');
}

function isJunkSymbol(symbol: CodeSymbol): boolean {
  // Anonymous / trivial lambdas pollute ranking (e.g. function c, function w)
  if (!symbol.name || symbol.name.length <= 2) return true;
  const lines = symbol.body.split('\n').filter(l => l.trim().length > 0);
  // Require both tiny line count AND tiny token count to drop — avoids
  // discarding short-but-real helpers that are still useful to retrieve.
  if (lines.length < 3 && estimateTokens(symbol.body) < 30) return true;
  return false;
}

export function chunkCode(doc: ParsedCodeDocument, options: ChunkCreationOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const config = loadConfig();
  const maxTokens = options.maxChunkTokens || config.maxChunkTokens;
  const stem = fileStemFromPath(doc.filePath);

  for (const symbol of doc.symbols) {
    if (['import', 'variable'].includes(symbol.kind) && doc.symbols.length > 50) {
      // In large files, maybe skip individual imports, but for now we keep them
    }

    if ((symbol.kind === 'function' || symbol.kind === 'method') && isJunkSymbol(symbol)) {
      continue;
    }

    // Skip tiny variable symbols unless they are large template literals (DDL etc.)
    if (symbol.kind === 'variable' && estimateTokens(symbol.body) < 50) {
      continue;
    }

    // Import symbols are used for graph edges; skip as content chunks
    if (symbol.kind === 'import') {
      continue;
    }

    let emitSymbol = symbol;
    // Avoid double-indexing: class body duplicates all methods. Emit a compact
    // outline (declaration + member list) when the class has nested symbols.
    if (symbol.kind === 'class' || symbol.kind === 'struct' || symbol.kind === 'interface') {
      const children = doc.symbols.filter(s => s.parent === symbol.name);
      if (children.length > 0) {
        const firstLine = symbol.body.split('\n').find(l => l.trim().length > 0) || `${symbol.kind} ${symbol.name}`;
        const memberList = children.map(s => `  ${s.kind} ${s.name}`).join('\n');
        emitSymbol = {
          ...symbol,
          body: `${firstLine}\n${memberList}\n}`,
        };
      }
    }

    const titleContext = emitSymbol.parent ? `${emitSymbol.parent} > ${emitSymbol.name}` : emitSymbol.name;
    chunks.push(createCodeChunk(emitSymbol, titleContext, doc.filePath, doc.language, options, stem));
  }

  // Also create a "File Summary" chunk that lists all symbols for high-level graph
  const meaningful = doc.symbols.filter(s =>
    s.kind !== 'import' &&
    !((s.kind === 'function' || s.kind === 'method') && isJunkSymbol(s))
  );
  const summaryContent = meaningful.map(s => `- [${s.kind}] ${s.name}`).join('\n');
  if (summaryContent.trim().length > 0) {
    const storedContent = `File: ${doc.filePath}\nLanguage: ${doc.language}\n\nSymbols:\n${summaryContent}`;
    const summaryHashVal = hashContent(storedContent);
    const id = stableChunkId(doc.filePath, 'File Summary');

    chunks.push({
      id,
      sourceFile: doc.filePath,
      layer: options.layer,
      workspaceName: options.workspaceName || null,
      sectionTitle: 'File Structure',
      sectionDepth: 1,
      content: storedContent,
      summary: null,
      keywords: extractKeywords(summaryContent, 'File Structure').join(', '),
      hash: summaryHashVal,
      importance: options.importance ?? 5,
      tokenCount: estimateTokens(storedContent),
      fileType: 'code',
      language: doc.language,
      parentSymbol: null,
      fileStem: stem,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  // Whole-file fallback only when no real symbol chunks exist (B26)
  const realSymbolChunks = chunks.filter(c => c.sectionTitle !== 'File Structure');
  if (realSymbolChunks.length === 0 && doc.rawContent && doc.rawContent.trim().length > 40) {
    const body = doc.rawContent.length > 8000 ? doc.rawContent.slice(0, 8000) : doc.rawContent;
    const contentHashVal = hashContent(body);
    const id = stableChunkId(doc.filePath, 'whole');
    chunks.push({
      id,
      sourceFile: doc.filePath,
      layer: options.layer,
      workspaceName: options.workspaceName || null,
      sectionTitle: path.basename(doc.filePath),
      sectionDepth: 1,
      content: body,
      summary: null,
      keywords: extractKeywords(body, path.basename(doc.filePath)).join(', '),
      hash: contentHashVal,
      importance: options.importance ?? 5,
      tokenCount: estimateTokens(body),
      fileType: 'code',
      language: doc.language,
      symbolName: path.basename(doc.filePath),
      symbolKind: 'file',
      parentSymbol: null,
      fileStem: stem,
      startLine: 1,
      endLine: body.split('\n').length,
      createdAt: Date.now(),
      updatedAt: Date.now()
    });
  }

  return chunks;
}

function createCodeChunk(
  symbol: CodeSymbol,
  titleContext: string,
  filePath: string,
  language: string,
  options: ChunkCreationOptions,
  stem: string
): Chunk {
  const keywords = extractKeywords(symbol.body, titleContext);
  // Add full symbol name itself as a keyword
  if (symbol.name.length > 2) keywords.push(symbol.name.toLowerCase());
  // And also its parts
  keywords.push(...symbol.name.split(/(?=[A-Z])|_|-|\./).map(s => s.toLowerCase()).filter(s => s.length > 2));

  const contentHashVal = hashContent(symbol.body);
  const id = stableChunkId(filePath, titleContext);

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
    tokenCount: estimateTokens(symbol.body),
    fileType: 'code',
    language,
    symbolName: symbol.name,
    symbolKind: symbol.kind,
    parentSymbol: symbol.parent || null,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    fileStem: stem,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}
