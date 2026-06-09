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
  
  // Strategy 1: Truncate lowest scored chunks
  while (currentTokens > maxTokens && compressed.length > 0) {
    const dropped = compressed.pop()!;
    const diff = currentTokens - maxTokens;
    
    // Strategy 2: Partial truncation
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
