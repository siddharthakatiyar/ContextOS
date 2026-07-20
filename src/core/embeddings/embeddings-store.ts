import type Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { getEmbeddingDims } from './embedder.js';

export interface EmbeddingHit {
  chunkId: string;
  score: number;
}

const VEC_TABLE = 'vec_chunk_embeddings';
const require = createRequire(import.meta.url);

const loadedDbs = new WeakSet<object>();
let vecExtensionOk: boolean | null = null;
let loggedVecOnce = false;

function logVecOnce(msg: string): void {
  if (loggedVecOnce) return;
  loggedVecOnce = true;
  console.error(`[contextos] sqlite-vec: ${msg}`);
}

function float32ToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function bufferToFloat32(buf: Buffer): Float32Array {
  const copy = Buffer.from(buf);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Try to load sqlite-vec and ensure vec0 virtual table exists.
 * Returns false on any failure (graceful degradation to brute-force).
 */
function ensureVecTable(db: Database.Database): boolean {
  if (vecExtensionOk === false) return false;

  try {
    if (!loadedDbs.has(db)) {
      // Prefer static-style API: import * as sqliteVec from 'sqlite-vec'; sqliteVec.load(db)
      const sqliteVec = require('sqlite-vec') as { load: (db: Database.Database) => void };
      sqliteVec.load(db);
      loadedDbs.add(db);
      vecExtensionOk = true;
    }

    const dims = getEmbeddingDims();
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
      .get(VEC_TABLE);

    if (!exists) {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS ${VEC_TABLE} USING vec0(
          chunk_id TEXT PRIMARY KEY,
          embedding float[${dims}]
        );
      `);
    }
    return true;
  } catch (e: any) {
    vecExtensionOk = false;
    logVecOnce(e?.message || String(e));
    return false;
  }
}

/** Reset vec load state (tests). */
export function _resetVecStateForTests(): void {
  vecExtensionOk = null;
  loggedVecOnce = false;
}

export class EmbeddingsStore {
  constructor(private db: Database.Database) {}

  public upsertEmbedding(chunkId: string, vector: Float32Array, model: string): void {
    const now = Date.now();
    const blob = float32ToBuffer(vector);
    this.db
      .prepare(
        `
      INSERT INTO chunk_embeddings (chunk_id, embedding, dims, model, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(chunk_id) DO UPDATE SET
        embedding = excluded.embedding,
        dims = excluded.dims,
        model = excluded.model,
        updated_at = excluded.updated_at
    `
      )
      .run(chunkId, blob, vector.length, model, now);

    if (ensureVecTable(this.db)) {
      try {
        this.db.prepare(`DELETE FROM ${VEC_TABLE} WHERE chunk_id = ?`).run(chunkId);
        this.db
          .prepare(`INSERT INTO ${VEC_TABLE} (chunk_id, embedding) VALUES (?, ?)`)
          .run(chunkId, blob);
      } catch (e: any) {
        logVecOnce(`vec upsert failed: ${e?.message || e}`);
      }
    }
  }

  public deleteByChunkIds(chunkIds: string[]): void {
    if (!chunkIds.length) return;
    const placeholders = chunkIds.map(() => '?').join(',');
    this.db
      .prepare(`DELETE FROM chunk_embeddings WHERE chunk_id IN (${placeholders})`)
      .run(...chunkIds);

    if (vecExtensionOk !== false && ensureVecTable(this.db)) {
      try {
        this.db
          .prepare(`DELETE FROM ${VEC_TABLE} WHERE chunk_id IN (${placeholders})`)
          .run(...chunkIds);
      } catch {
        // ignore vec delete failures
      }
    }
  }

  /**
   * kNN search. Prefers sqlite-vec when available; otherwise brute-force cosine over BLOBs.
   */
  public searchSimilar(queryVec: Float32Array, limit: number = 15): EmbeddingHit[] {
    if (ensureVecTable(this.db)) {
      try {
        const blob = float32ToBuffer(queryVec);
        const rows = this.db
          .prepare(
            `
          SELECT chunk_id AS chunkId, distance
          FROM ${VEC_TABLE}
          WHERE embedding MATCH ?
            AND k = ?
        `
          )
          .all(blob, limit) as { chunkId: string; distance: number }[];

        return rows.map((r) => ({
          chunkId: r.chunkId,
          score: 1 / (1 + (r.distance ?? 0))
        }));
      } catch (e: any) {
        logVecOnce(`vec search failed, using brute-force: ${e?.message || e}`);
      }
    }

    return this.bruteForceSearch(queryVec, limit);
  }

  private bruteForceSearch(queryVec: Float32Array, limit: number): EmbeddingHit[] {
    try {
      const rows = this.db.prepare(`SELECT chunk_id, embedding FROM chunk_embeddings`).all() as {
        chunk_id: string;
        embedding: Buffer;
      }[];

      const scored: EmbeddingHit[] = [];
      for (const row of rows) {
        const vec = bufferToFloat32(row.embedding);
        scored.push({
          chunkId: row.chunk_id,
          score: cosineSimilarity(queryVec, vec)
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, limit);
    } catch {
      return [];
    }
  }
}
