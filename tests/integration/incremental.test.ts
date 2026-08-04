import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';

interface ContentRow {
  content: string;
}

vi.mock('../../src/core/embeddings/index.js', () => ({
  isEmbeddingsAvailable: () => false,
  ensureEmbeddingsLoaded: async () => {},
  embedChunks: async () => {}
}));

describe('Incremental Indexing Integration', () => {
  let tmpdir: string;
  let dbPath: string;
  let db: DB;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-integration-incr-'));
    dbPath = path.join(tmpdir, '.contextos', 'index.db');
    fs.mkdirSync(path.join(tmpdir, '.contextos'), { recursive: true });
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

  it('updates chunks properly when a file changes', async () => {
    const file = path.join(tmpdir, 'app.ts');

    // 1. Initial write
    fs.writeFileSync(file, 'export function oldFunc() { return "old"; }');

    const indexer = new Indexer(db);
    await indexer.indexFile(file, 'repo', tmpdir);

    const initialChunks = db
      .getInstance()
      .prepare('SELECT * FROM chunks WHERE source_file = ?')
      .all(file) as ContentRow[];

    expect(initialChunks.length).toBeGreaterThan(0);
    const initialContent = initialChunks.map((c) => c.content).join(' ');
    expect(initialContent).toContain('oldFunc');
    expect(initialContent).not.toContain('newFunc');

    // 2. Modify file
    fs.writeFileSync(file, 'export function newFunc() { return "new"; }');

    await indexer.indexFile(file, 'repo', tmpdir);

    const updatedChunks = db
      .getInstance()
      .prepare('SELECT * FROM chunks WHERE source_file = ?')
      .all(file) as ContentRow[];
    const updatedContent = updatedChunks.map((c) => c.content).join(' ');

    expect(updatedContent).toContain('newFunc');
    expect(updatedContent).not.toContain('oldFunc');

    // Chunk count might differ depending on how TS parses it, but oldFunc should be gone.
  });
});
