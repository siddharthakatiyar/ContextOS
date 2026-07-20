import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { RetrievalEngine } from '../../src/core/retrieval/index.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../src/core/storage/relationships-repo.js';

// We mock the embeddings so it doesn't need to load the transformer models
vi.mock('../../src/core/embeddings/index.js', () => ({
  isEmbeddingsAvailable: () => false,
  ensureEmbeddingsLoaded: async () => {},
  embedChunks: async () => {}
}));

describe('Full Index and Retrieve Integration', () => {
  let tmpdir: string;
  let dbPath: string;
  let db: DB;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-integration-'));
    dbPath = path.join(tmpdir, '.contextos', 'index.db');
    fs.mkdirSync(path.join(tmpdir, '.contextos'), { recursive: true });

    // Create actual real database
    db = new DB(dbPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch {}
  });

  it('indexes multiple files, constructs a graph, and retrieves relevant chunks', async () => {
    // 1. Setup Files
    const file1 = path.join(tmpdir, 'utils.ts');
    fs.writeFileSync(file1, 'export function add(a: number, b: number) { return a + b; }');

    const file2 = path.join(tmpdir, 'math.ts');
    fs.writeFileSync(
      file2,
      'import { add } from "./utils.js"; export function compute() { return add(2, 2); }'
    );

    const file3 = path.join(tmpdir, 'unrelated.ts');
    fs.writeFileSync(file3, 'export const completelyUnrelated = 42;');

    // 2. Index Files
    const indexer = new Indexer(db);

    await indexer.indexFile(file1, 'repo');
    await indexer.indexFile(file2, 'repo');
    await indexer.indexFile(file3, 'repo');

    // Wait for the async parser queues to drain (if any background indexing happens)
    // In our synchronous test setup with mock embeddings, indexFile handles DB insertion directly.

    // 3. Verify DB state
    const chunksRepo = new ChunksRepo(db.getInstance());
    const relsRepo = new RelationshipsRepo(db.getInstance());

    const chunks = db.getInstance().prepare('SELECT * FROM chunks').all();
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    // 4. Retrieve
    const engine = new RetrievalEngine([chunksRepo], [relsRepo]);
    // Fuzzy search for "add function"
    const result = await engine.retrieve('add function');

    // "add" is in utils.ts and math.ts
    // unrelated.ts doesn't have it
    expect(result.chunks.length).toBeGreaterThan(0);

    const sourceFiles = result.chunks.map((c) => c.sourceFile);
    expect(sourceFiles).toContain(file1); // utils.ts
    // We should not retrieve unrelated.ts since it has no relevance
    expect(sourceFiles).not.toContain(file3);
  });
});
