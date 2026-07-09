import { ScoredChunk } from '../retrieval/types.js';

function stripComments(code: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  while (i < code.length) {
    const char = code[i];
    const nextChar = code[i + 1] || '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      i++;
    } else if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
    } else if (inString) {
      if (char === '\\') {
        out += char + nextChar;
        i += 2;
      } else if (char === stringChar) {
        inString = false;
        out += char;
        i++;
      } else {
        out += char;
        i++;
      }
    } else {
      if (char === '"' || char === "'" || char === '`') {
        inString = true;
        stringChar = char;
        out += char;
        i++;
      } else if (char === '/' && nextChar === '/') {
        inLineComment = true;
        i += 2;
      } else if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        i += 2;
      } else {
        out += char;
        i++;
      }
    }
  }
  return out.replace(/^\s*[\r\n]/gm, '');
}

export function compressChunks(chunks: ScoredChunk[], maxTokens: number): ScoredChunk[] {
  // Strategy 0: Deduplicate by content hash
  const uniqueHashes = new Set<string>();
  const deduped: ScoredChunk[] = [];
  for (const c of chunks) {
    if (!uniqueHashes.has(c.hash)) {
      uniqueHashes.add(c.hash);
      deduped.push(c);
    }
  }

  let currentTokens = deduped.reduce((sum, c) => sum + c.tokenCount, 0);
  if (currentTokens <= maxTokens) return deduped;

  const compressed = [...deduped];
  
  // Strategy 1: Strip internal comments for code chunks
  for (let i = compressed.length - 1; i >= 0 && currentTokens > maxTokens; i--) {
    const chunk = compressed[i];
    if (chunk.language && chunk.fileType !== 'markdown') {
      const originalLen = chunk.content.length;
      // Strip block and line comments while ignoring string literals
      chunk.content = stripComments(chunk.content);
      
      const newTokens = Math.floor(chunk.tokenCount * (chunk.content.length / originalLen));
      currentTokens -= (chunk.tokenCount - newTokens);
      chunk.tokenCount = newTokens;
    }
  }

  if (currentTokens <= maxTokens) return compressed;

  // Strategy 2: Structural Fallback (swap with summary if available)
  for (let i = compressed.length - 1; i >= 0 && currentTokens > maxTokens; i--) {
    const chunk = compressed[i];
    if (chunk.summary && chunk.summary.length < chunk.content.length / 2) {
      chunk.content = `[CODE OMITTED - SUMMARY] ${chunk.summary}`;
      const newTokens = Math.floor(chunk.tokenCount * 0.2); // Approximation
      currentTokens -= (chunk.tokenCount - newTokens);
      chunk.tokenCount = newTokens;
    }
  }

  if (currentTokens <= maxTokens) return compressed;

  // Strategy 3: Truncate / Drop lowest scored chunks
  while (currentTokens > maxTokens && compressed.length > 0) {
    const dropped = compressed.pop()!;
    const diff = currentTokens - maxTokens;
    
    // Partial truncation
    if (diff < dropped.tokenCount && diff > 0) {
      const ratio = 1 - (diff / dropped.tokenCount);
      const lines = dropped.content.split('\n');
      const keepLines = Math.max(1, Math.floor(lines.length * ratio));
      let truncatedContent = lines.slice(0, keepLines).join('\n');
      
      // Fallback: If chunk has extremely long lines (minified), force char truncation
      const expectedCharLen = Math.max(100, dropped.content.length * ratio);
      if (truncatedContent.length > expectedCharLen * 1.5) {
        truncatedContent = dropped.content.slice(0, Math.floor(expectedCharLen));
      }
      
      truncatedContent += '\n\n[...truncated]';
      const keepTokens = Math.floor(dropped.tokenCount * ratio);
      compressed.push({
        ...dropped,
        content: truncatedContent,
        tokenCount: keepTokens
      });
      currentTokens -= (dropped.tokenCount - keepTokens);
      break;
    } else {
      currentTokens -= dropped.tokenCount;
    }
  }

  return compressed;
}
