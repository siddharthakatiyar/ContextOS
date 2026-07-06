import { ScoredChunk } from '../retrieval/types.js';

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
      // Strip block and line comments (basic approximation)
      chunk.content = chunk.content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '')
        .replace(/^\s*[\r\n]/gm, ''); // remove empty lines
      
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
      const keepLines = Math.max(1, Math.floor(dropped.content.split('\n').length * ratio));
      const truncatedContent = dropped.content.split('\n').slice(0, keepLines).join('\n') + '\n\n[...truncated]';
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
