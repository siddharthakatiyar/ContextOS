import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';

vi.mock('../../src/core/embeddings/index.js', () => ({
  isEmbeddingsAvailable: () => false,
  ensureEmbeddingsLoaded: async () => {},
  embedChunks: async () => {}
}));

describe('Transactional file indexing', () => {
  let tmpdir: string;
  let db: DB;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-transactional-'));
    fs.mkdirSync(path.join(tmpdir, '.contextos'), { recursive: true });
    db = new DB(path.join(tmpdir, '.contextos', 'index.db'));
  });

  afterEach(() => {
    try {
      db.close();
    } catch {}
    try {
      fs.rmSync(tmpdir, { recursive: true, force: true });
    } catch {}
  });

  it('rolls back the whole file replacement when chunk persistence fails', async () => {
    const file = path.join(tmpdir, 'app.ts');
    const v1 = [
      'export function oldFunc() {',
      '  const marker = "v1";',
      '  return marker;',
      '}'
    ].join('\n');

    fs.writeFileSync(file, v1);
    const indexer = new Indexer(db);
    await indexer.indexFile(file, 'repo', tmpdir);

    const before = (
      db.getInstance().prepare('SELECT hash FROM files WHERE path = ?').get(file) as {
        hash: string;
      }
    ).hash;
    expect(before).toBeDefined();

    // Force a failure between the file-row upsert and chunk re-insertion
    const spy = vi.spyOn(ChunksRepo.prototype, 'deleteBySource').mockImplementation(() => {
      throw new Error('boom mid-transaction');
    });

    const v2 = v1.replace('v1', 'v2');
    fs.writeFileSync(file, v2);
    await expect(indexer.indexFile(file, 'repo', tmpdir)).rejects.toThrow('boom mid-transaction');
    spy.mockRestore();

    // Nothing may have leaked through: old chunks intact, file hash unchanged,
    // so the next successful index still sees the file as changed.
    const after = (
      db.getInstance().prepare('SELECT hash FROM files WHERE path = ?').get(file) as {
        hash: string;
      }
    ).hash;
    expect(after).toBe(before);

    const contents = (
      db.getInstance().prepare('SELECT content FROM chunks WHERE source_file = ?').all(file) as {
        content: string;
      }[]
    )
      .map((r) => r.content)
      .join('\n');
    expect(contents).toContain('oldFunc');

    // And a retry without the fault converges to the new state
    await indexer.indexFile(file, 'repo', tmpdir);
    const retryContents = (
      db.getInstance().prepare('SELECT content FROM chunks WHERE source_file = ?').all(file) as {
        content: string;
      }[]
    )
      .map((r) => r.content)
      .join('\n');
    expect(retryContents).toContain('"v2"');
  });
});
