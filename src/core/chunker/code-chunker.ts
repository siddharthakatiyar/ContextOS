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

function tokenizeName(name: string): string[] {
  return name
    .split(/_|-|\./)
    .flatMap((p) =>
      p.toUpperCase() === p ? [p.toLowerCase()] : p.split(/(?=[A-Z])/).map((s) => s.toLowerCase())
    )
    .filter((s) => s.length > 2);
}

/** Stable chunk ID: survives content edits (B7). Hash field still tracks content changes. */
function stableChunkId(filePath: string, symbolPathOrTitle: string): string {
  return crypto.createHash('md5').update(`${filePath}:${symbolPathOrTitle}`).digest('hex');
}

function isJunkSymbol(symbol: CodeSymbol): boolean {
  // Anonymous / trivial lambdas pollute ranking (e.g. function c, function w)
  if (!symbol.name || symbol.name.length <= 2) return true;
  const lines = symbol.body.split('\n').filter((l) => l.trim().length > 0);
  // Require both tiny line count AND tiny token count to drop — avoids
  // discarding short-but-real helpers that are still useful to retrieve.
  if (lines.length < 3 && estimateTokens(symbol.body) < 30) return true;
  return false;
}

/** Prefer splitting before blank lines, comment blocks, and branch headers. */
function isSegmentBoundary(line: string, prevNonEmpty: string | null): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^\/\*\*/.test(t) || /^\/\//.test(t)) return true;
  if (/^(?:}?\s*)?(?:else\s+if|else|case\s|default\s*:|catch\s*\(|finally\s*\{)/.test(t))
    return true;
  if (
    /^(?:if|switch|for|while|try)\b/.test(t) &&
    prevNonEmpty &&
    !/[{,]$/.test(prevNonEmpty.trim())
  ) {
    return true;
  }
  // Blank line already consumed — treat next non-empty as soft boundary when prev ended a block
  if (
    prevNonEmpty &&
    /[;}]$/.test(prevNonEmpty.trim()) &&
    /^(?:const|let|var|return|await|this\.|export)/.test(t)
  ) {
    return true;
  }
  return false;
}

export interface SymbolSegment {
  content: string;
  startLine: number;
  endLine: number;
  label: string;
}

/**
 * Split a large symbol body into contiguous segments (~250–400 tokens).
 * Segments cover the full body with no gaps/overlap. Line numbers are absolute
 * (parent.startLine + 0-based offset within body).
 */
export function segmentLargeSymbol(
  symbol: CodeSymbol,
  targetTokens: number = 320
): SymbolSegment[] {
  const lines = symbol.body.split('\n');
  if (lines.length === 0) return [];

  const parentStart = symbol.startLine || 1;
  const segments: SymbolSegment[] = [];
  let buf: string[] = [];
  let bufStartIdx = 0;
  let prevNonEmpty: string | null = null;
  let sawBlank = false;

  const flush = (endIdx: number) => {
    if (buf.length === 0) return;
    const content = buf.join('\n');
    // Prefer nearest preceding comment block for semantic FTS titles
    // (e.g. "Prefer repo-local source files over foreign workspace pollution")
    const commentLabel = (() => {
      const commentLines: string[] = [];
      let started = false;
      // Scan early lines: skip signature/boilerplate until first comment, then collect it
      for (let i = 0; i < Math.min(buf.length, 24); i++) {
        const t = buf[i].trim();
        if (!t) {
          if (started) break;
          continue;
        }
        if (/^\/\//.test(t)) {
          started = true;
          commentLines.push(t.replace(/^\/\/\s?/, ''));
          continue;
        }
        if (/^\/\*/.test(t) || (started && /^\*/.test(t))) {
          started = true;
          commentLines.push(
            t
              .replace(/^\/\*+\s?/, '')
              .replace(/\*\/\s*$/, '')
              .replace(/^\*\s?/, '')
          );
          if (/\*\//.test(t)) break;
          continue;
        }
        if (started) break;
        // Skip one-line function/signature boilerplate before the first comment
        if (
          /^(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|if|for|while|switch|return|}\s*else)\b/.test(
            t
          ) ||
          /^[{}()[\];,]*$/.test(t)
        ) {
          continue;
        }
        // Non-comment code before any comment — no semantic title
        break;
      }
      const joined = commentLines
        .map((c) => c.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ');
      return joined.length >= 8 ? joined.slice(0, 72) : null;
    })();
    const firstUseful =
      buf.find((l) => {
        const t = l.trim();
        return t.length > 0 && !/^[{}()[\];,]*$/.test(t) && !/^\/[/*]/.test(t);
      }) ||
      buf.find((l) => {
        const t = l.trim();
        return t.length > 0 && !/^[{}()[\];,]*$/.test(t);
      }) ||
      buf[0];
    const label = commentLabel || firstUseful.trim().replace(/\s+/g, ' ').slice(0, 72);
    segments.push({
      content,
      startLine: parentStart + bufStartIdx,
      endLine: parentStart + endIdx,
      label
    });
    buf = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      sawBlank = true;
      if (buf.length > 0) buf.push(line);
      continue;
    }

    const tok = estimateTokens(buf.join('\n'));
    const atBoundary =
      buf.length > 0 &&
      tok >= Math.floor(targetTokens * 0.55) &&
      (sawBlank || isSegmentBoundary(line, prevNonEmpty));

    if (atBoundary && tok >= Math.floor(targetTokens * 0.7)) {
      flush(i - 1);
      bufStartIdx = i;
      sawBlank = false;
    } else if (tok >= targetTokens * 1.35 && buf.length > 0) {
      // Hard cap — split even mid-block to avoid giant segments
      flush(i - 1);
      bufStartIdx = i;
      sawBlank = false;
    }

    if (buf.length === 0) bufStartIdx = i;
    buf.push(line);
    prevNonEmpty = line;
    sawBlank = false;
  }
  flush(lines.length - 1);

  // Merge a trailing tiny segment into the previous one
  if (segments.length >= 2) {
    const last = segments[segments.length - 1];
    if (estimateTokens(last.content) < 80) {
      const prev = segments[segments.length - 2];
      prev.content = prev.content + '\n' + last.content;
      prev.endLine = last.endLine;
      segments.pop();
    }
  }

  return segments;
}

function createSegmentChunks(
  symbol: CodeSymbol,
  titleContext: string,
  filePath: string,
  language: string,
  options: ChunkCreationOptions,
  stem: string,
  maxSymbolTokens: number
): Chunk[] {
  const bodyTokens = estimateTokens(symbol.body);
  if (bodyTokens <= maxSymbolTokens) return [];
  if (symbol.kind !== 'function' && symbol.kind !== 'method') return [];

  const segs = segmentLargeSymbol(symbol);
  if (segs.length < 2) return [];

  return segs.map((seg, i) => {
    const sectionTitle = `${symbol.name} › ${seg.label}`;
    const keywords = extractKeywords(seg.content, sectionTitle);
    if (symbol.name.length > 2) keywords.push(symbol.name.toLowerCase());
    keywords.push(...tokenizeName(symbol.name));
    const contentHashVal = hashContent(seg.content);
    const id = stableChunkId(filePath, `${titleContext}#seg${i}`);

    return {
      id,
      sourceFile: filePath,
      layer: options.layer,
      workspaceName: options.workspaceName || null,
      sectionTitle,
      sectionDepth: 3,
      content: seg.content,
      summary: null,
      keywords: Array.from(new Set(keywords)).join(', '),
      hash: contentHashVal,
      importance: options.importance ?? 5,
      tokenCount: estimateTokens(seg.content),
      fileType: 'code' as const,
      language,
      symbolName: null,
      symbolKind: 'segment',
      parentSymbol: symbol.name,
      startLine: seg.startLine,
      endLine: seg.endLine,
      fileStem: stem,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  });
}

export function chunkCode(doc: ParsedCodeDocument, options: ChunkCreationOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const config = loadConfig();
  const maxSymbolTokens = options.maxSymbolChunkTokens ?? config.maxSymbolChunkTokens ?? 900;
  const stem = fileStemFromPath(doc.filePath);

  for (const symbol of doc.symbols) {
    if (['import', 'variable'].includes(symbol.kind) && doc.symbols.length > 50) {
      // In large files, maybe skip individual imports, but for now we keep them
    }

    if ((symbol.kind === 'function' || symbol.kind === 'method') && isJunkSymbol(symbol)) {
      continue;
    }

    // All top-level variables (even small constants) are now indexed

    // Import symbols are used for graph edges; skip as content chunks
    if (symbol.kind === 'import') {
      continue;
    }

    let emitSymbol = symbol;
    // Avoid double-indexing: class body duplicates all methods. Emit a compact
    // outline (declaration + member list) when the class has nested symbols.
    if (symbol.kind === 'class' || symbol.kind === 'struct' || symbol.kind === 'interface') {
      const children = doc.symbols.filter((s) => s.parent === symbol.name);
      if (children.length > 0) {
        const firstLine =
          symbol.body.split('\n').find((l) => l.trim().length > 0) ||
          `${symbol.kind} ${symbol.name}`;
        const memberList = children.map((s) => `  ${s.kind} ${s.name}`).join('\n');
        emitSymbol = {
          ...symbol,
          body: `${firstLine}\n${memberList}\n}`
        };
      }
    }

    const titleContext = emitSymbol.parent
      ? `${emitSymbol.parent} > ${emitSymbol.name}`
      : emitSymbol.name;
    chunks.push(
      createCodeChunk(emitSymbol, titleContext, doc.filePath, doc.language, options, stem)
    );

    // Additive segments for oversized function/method bodies (parent kept)
    if (emitSymbol === symbol) {
      chunks.push(
        ...createSegmentChunks(
          symbol,
          titleContext,
          doc.filePath,
          doc.language,
          options,
          stem,
          maxSymbolTokens
        )
      );
    }
  }

  // Also create a "File Summary" chunk that lists all symbols for high-level graph
  // Exclude segment chunks from the summary (they are not top-level symbols)
  const meaningful = doc.symbols.filter(
    (s) =>
      s.kind !== 'import' && !((s.kind === 'function' || s.kind === 'method') && isJunkSymbol(s))
  );
  const summaryContent = meaningful.map((s) => `- [${s.kind}] ${s.name}`).join('\n');
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
      keywords: Array.from(
        new Set([
          ...extractKeywords(summaryContent, 'File Structure'),
          ...tokenizeName(path.basename(doc.filePath))
        ])
      ).join(', '),
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
  const realSymbolChunks = chunks.filter(
    (c) => c.sectionTitle !== 'File Structure' && c.symbolKind !== 'segment'
  );
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
  keywords.push(...tokenizeName(symbol.name));

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
