import { describe, it, expect } from 'vitest';
import { deduplicateChunks } from '../../src/core/retrieval/index.js';
import { ScoredChunk } from '../../src/core/retrieval/types.js';
import { RetrievalEngine } from '../../src/core/retrieval/index.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../src/core/storage/relationships-repo.js';
import { DB } from '../../src/core/storage/database.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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

describe('RetrievalEngine', () => {
  it('throws AbortError if signal is aborted', async () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-retrieval-'));
    const dbPath = path.join(tmpdir, '.contextos', 'index.db');
    fs.mkdirSync(path.join(tmpdir, '.contextos'), { recursive: true });

    const db = new DB(dbPath);
    const repo = new ChunksRepo(db.getInstance());
    const relsRepo = new RelationshipsRepo(db.getInstance());
    const engine = new RetrievalEngine(repo, relsRepo);

    const controller = new AbortController();
    controller.abort();

    await expect(engine.retrieve('test query', undefined, controller.signal)).rejects.toThrow(
      'This operation was aborted'
    );

    try {
      db.close();
    } catch {}
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
});
