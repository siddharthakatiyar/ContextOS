import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import {
  EmbeddingsStore,
  _resetVecStateForTests
} from '../../src/core/embeddings/embeddings-store.js';

const DIMS = 384;

function unitVec(hotIndex: number): Float32Array {
  const v = new Float32Array(DIMS);
  v[hotIndex] = 1;
  return v;
}

/**
 * Regression tests for orphaned sqlite-vec vectors: the vec0 virtual table has
 * no FK support, so chunk deletion must garbage-collect vectors explicitly.
 * Embedding model inference is disabled via CONTEXTOS_EMBEDDINGS=0; vectors are
 * seeded manually to simulate a previously-indexed state.
 */
describe('Vector garbage collection', () => {
  let tmpdir: string;
  let db: DB;
  let prevEmbeddingsEnv: string | undefined;

  // Multi-line bodies so the parser emits real symbol chunks
  const V1 = ['export function alpha() {', '  const x = 1;', '  return x;', '}', ''].join('\n');
  const V2 = ['export function beta() {', '  const y = 2;', '  return y * 3;', '}', ''].join('\n');

  beforeEach(() => {
    _resetVecStateForTests();
    prevEmbeddingsEnv = process.env.CONTEXTOS_EMBEDDINGS;
    process.env.CONTEXTOS_EMBEDDINGS = '0';
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-vector-gc-'));
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
    if (prevEmbeddingsEnv === undefined) {
      delete process.env.CONTEXTOS_EMBEDDINGS;
    } else {
      process.env.CONTEXTOS_EMBEDDINGS = prevEmbeddingsEnv;
    }
  });

  function instance() {
    return db.getInstance();
  }

  function hasVecTable(): boolean {
    return !!instance()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vec_chunk_embeddings'")
      .get();
  }

  function count(table: 'chunk_embeddings' | 'vec_chunk_embeddings'): number | null {
    if (table === 'vec_chunk_embeddings' && !hasVecTable()) return null;
    return (instance().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
  }

  function chunkIdsBySymbol(symbol: string): string[] {
    return (
      instance()
        .prepare('SELECT id FROM chunks WHERE source_file = ? AND symbol_name = ?')
        .all(path.join(tmpdir, 'app.ts'), symbol) as { id: string }[]
    ).map((row) => row.id);
  }

  function seedVectors(): void {
    const ids = (
      instance()
        .prepare('SELECT id FROM chunks WHERE source_file = ?')
        .all(path.join(tmpdir, 'app.ts')) as {
        id: string;
      }[]
    ).map((row) => row.id);
    expect(ids.length).toBeGreaterThan(0);
    const store = new EmbeddingsStore(instance());
    ids.forEach((id, i) => store.upsertEmbedding(id, unitVec(i % DIMS), 'test'));
  }

  it('removes stale vectors when a file is re-indexed with changed symbols', async () => {
    const file = path.join(tmpdir, 'app.ts');
    fs.writeFileSync(file, V1);

    const indexer = new Indexer(db);
    await indexer.indexFile(file, 'repo', tmpdir);

    expect(chunkIdsBySymbol('alpha').length).toBe(1);
    seedVectors();
    expect(count('chunk_embeddings')).toBeGreaterThan(0);
    const vecBefore = count('vec_chunk_embeddings');
    if (vecBefore !== null) expect(vecBefore).toBeGreaterThan(0);

    fs.writeFileSync(file, V2);
    await indexer.indexFile(file, 'repo', tmpdir);

    // New chunks receive no embeddings (model disabled): every stale vector
    // must have been garbage-collected, leaving none behind.
    expect(chunkIdsBySymbol('alpha')).toHaveLength(0);
    expect(chunkIdsBySymbol('beta')).toHaveLength(1);
    expect(count('chunk_embeddings')).toBe(0);
    const vecAfter = count('vec_chunk_embeddings');
    if (vecAfter !== null) expect(vecAfter).toBe(0);
  });

  it('removes vectors when a file is removed', async () => {
    const file = path.join(tmpdir, 'app.ts');
    fs.writeFileSync(file, V1);

    const indexer = new Indexer(db);
    await indexer.indexFile(file, 'repo', tmpdir);

    seedVectors();
    expect(count('chunk_embeddings')).toBeGreaterThan(0);
    const vecBefore = count('vec_chunk_embeddings');
    if (vecBefore !== null) expect(vecBefore).toBeGreaterThan(0);

    await indexer.removeFile(file);

    expect(count('chunk_embeddings')).toBe(0);
    const vecAfter = count('vec_chunk_embeddings');
    if (vecAfter !== null) expect(vecAfter).toBe(0);
    expect(
      (
        instance().prepare('SELECT COUNT(*) AS c FROM chunks WHERE source_file = ?').get(file) as {
          c: number;
        }
      ).c
    ).toBe(0);
  });

  it('leaves no orphaned vectors for the File Structure chunk either', async () => {
    const file = path.join(tmpdir, 'app.ts');
    fs.writeFileSync(file, V1);

    const indexer = new Indexer(db);
    await indexer.indexFile(file, 'repo', tmpdir);
    seedVectors();

    await indexer.removeFile(file);

    expect(count('chunk_embeddings')).toBe(0);
    const vecAfter = count('vec_chunk_embeddings');
    if (vecAfter !== null) expect(vecAfter).toBe(0);
  });
});
