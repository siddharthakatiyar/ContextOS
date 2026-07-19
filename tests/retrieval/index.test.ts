import { describe, it, expect } from 'vitest';
import { deduplicateChunks } from '../../src/core/retrieval/index.js';
import { ScoredChunk } from '../../src/core/retrieval/types.js';

describe('deduplicateChunks', () => {
  it('drops lower-scoring exact duplicate chunks based on hash', () => {
    const chunkA = { id: 'chunk-a', hash: 'abc-123', score: 10 } as ScoredChunk;
    const chunkB = { id: 'chunk-b', hash: 'abc-123', score: 5 } as ScoredChunk;
    const chunkC = { id: 'chunk-c', hash: 'def-456', score: 7 } as ScoredChunk;
    const chunkD = { id: 'chunk-d', hash: 'abc-123', score: 12 } as ScoredChunk;
    
    // Pass in random order
    const result = deduplicateChunks([chunkA, chunkB, chunkC, chunkD]);
    
    // chunkD has the highest score for 'abc-123'
    expect(result.length).toBe(2);
    
    // Result should be sorted by score descending
    expect(result[0].id).toBe('chunk-d');
    expect(result[0].score).toBe(12);
    
    expect(result[1].id).toBe('chunk-c');
    expect(result[1].score).toBe(7);
  });

  it('keeps chunks without a hash', () => {
    const chunkA = { id: 'chunk-a', hash: null, score: 10 } as unknown as ScoredChunk;
    const chunkB = { id: 'chunk-b', hash: null, score: 10 } as unknown as ScoredChunk;
    
    const result = deduplicateChunks([chunkA, chunkB]);
    expect(result.length).toBe(2);
  });
  
  it('uses id localeCompare as a tiebreaker for equal scores', () => {
    const chunkA = { id: 'chunk-a', hash: 'abc-123', score: 10 } as ScoredChunk;
    const chunkB = { id: 'chunk-b', hash: 'abc-123', score: 10 } as ScoredChunk;
    
    const result = deduplicateChunks([chunkB, chunkA]);
    expect(result.length).toBe(1);
    // 'chunk-a' is lexicographically before 'chunk-b'
    expect(result[0].id).toBe('chunk-a');
  });
});
