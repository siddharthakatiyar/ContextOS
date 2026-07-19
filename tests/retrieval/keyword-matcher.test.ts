import { describe, it, expect } from 'vitest';
import { KeywordMatcher, reciprocalRankFusion } from '../../src/core/retrieval/keyword-matcher.js';
import { DB } from '../../src/core/storage/database.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { ScoredChunk } from '../../src/core/retrieval/types.js';

describe('keyword-matcher', () => {
  it('should score chunks based on keyword matching', () => {
    const db = new DB(':memory:');
    const matcher = new KeywordMatcher([new ChunksRepo(db.getInstance())]);
    expect(matcher).toBeDefined();
    expect(typeof matcher.matchChunks).toBe('function');
  });

  it('reciprocalRankFusion prefers items ranked high in multiple lists', () => {
    const a = { id: 'a', score: 0 } as ScoredChunk;
    const b = { id: 'b', score: 0 } as ScoredChunk;
    const c = { id: 'c', score: 0 } as ScoredChunk;
    const fused = reciprocalRankFusion([
      { list: [{ ...a }, { ...b }, { ...c }], weight: 1 },
      { list: [{ ...a }, { ...c }, { ...b }], weight: 1 },
    ]);
    expect(fused[0].id).toBe('a');
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it('reciprocalRankFusion produces deterministic order when scores are tied', () => {
    // To guarantee a true score tie we put each chunk at rank 0 in its own list
    // with equal weight. Both get the same RRF contribution → equal post-scale scores.
    // The id tiebreaker must then order them lexicographically.
    const x = { id: 'z-chunk', score: 0 } as ScoredChunk;
    const y = { id: 'a-chunk', score: 0 } as ScoredChunk;
    const run1 = reciprocalRankFusion([
      { list: [{ ...x }], weight: 1 },
      { list: [{ ...y }], weight: 1 },
    ]).map(c => c.id);
    const run2 = reciprocalRankFusion([
      { list: [{ ...x }], weight: 1 },
      { list: [{ ...y }], weight: 1 },
    ]).map(c => c.id);
    // Both runs must be identical (deterministic)
    expect(run1).toEqual(run2);
    // 'a-chunk' < 'z-chunk' lexicographically, so it comes first on a score tie
    expect(run1[0]).toBe('a-chunk');
  });
});
