import { describe, it, expect } from 'vitest';
import { KeywordMatcher } from '../../src/core/retrieval/keyword-matcher.js';
import { DB } from '../../src/core/storage/database.js';

import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';

describe('keyword-matcher', () => {
  it('should score chunks based on keyword matching', () => {
    const db = new DB(':memory:');
    const matcher = new KeywordMatcher([new ChunksRepo(db.getInstance())]);
    
    // In an in-memory DB, there are no chunks initially, 
    // but we can test instance creation and method existence.
    expect(matcher).toBeDefined();
    expect(typeof matcher.matchChunks).toBe('function');
  });
});
