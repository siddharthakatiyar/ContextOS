import { describe, it, expect, beforeEach } from 'vitest';
import { DB } from '../../src/core/storage/database.js';
import { EmbeddingsStore, _resetVecStateForTests } from '../../src/core/embeddings/embeddings-store.js';

function unitVec(dims: number, hotIndex: number): Float32Array {
  const v = new Float32Array(dims);
  v[hotIndex] = 1;
  return v;
}

describe('EmbeddingsStore brute-force', () => {
  beforeEach(() => {
    _resetVecStateForTests();
    // Force brute-force by pretending vec extension failed
    process.env.CONTEXTOS_EMBEDDINGS = process.env.CONTEXTOS_EMBEDDINGS || '0';
  });

  it('upserts and finds nearest by cosine', () => {
    const db = new DB(':memory:');
    const instance = db.getInstance();

    // Satisfy FK: need a file + chunk
    instance.prepare(`
      INSERT INTO files (path, layer, hash, last_indexed, importance, chunk_count)
      VALUES ('a.ts', 'repo', 'h', 0, 5, 1)
    `).run();
    instance.prepare(`
      INSERT INTO chunks (
        id, source_file, layer, section_depth, content, hash, importance, token_count, created_at, updated_at
      ) VALUES
        ('c1', 'a.ts', 'repo', 1, 'alpha', 'h1', 5, 1, 0, 0),
        ('c2', 'a.ts', 'repo', 1, 'beta', 'h2', 5, 1, 0, 0)
    `).run();

    const store = new EmbeddingsStore(instance);
    const dims = 8;
    store.upsertEmbedding('c1', unitVec(dims, 0), 'test');
    store.upsertEmbedding('c2', unitVec(dims, 1), 'test');

    const hits = store.searchSimilar(unitVec(dims, 0), 2);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].chunkId).toBe('c1');
    expect(hits[0].score).toBeGreaterThan(0.9);

    store.deleteByChunkIds(['c1']);
    const after = store.searchSimilar(unitVec(dims, 0), 2);
    expect(after.every(h => h.chunkId !== 'c1')).toBe(true);

    db.close();
  });
});
