import type Database from 'better-sqlite3';
import type { Chunk } from '../storage/types.js';
import { ChunksRepo, type ScoredChunk } from '../storage/chunks-repo.js';
import { embedTexts, getEmbeddingModelId, isEmbeddingsAvailable } from './embedder.js';
import { EmbeddingsStore } from './embeddings-store.js';

export {
  embedTexts,
  isEmbeddingsAvailable,
  getEmbeddingModelId,
  getEmbeddingDims,
  _resetEmbedderForTests
} from './embedder.js';
export { EmbeddingsStore, _resetVecStateForTests } from './embeddings-store.js';
export type { EmbeddingHit } from './embeddings-store.js';

const EMBED_CONTENT_CHAR_CAP = 500;
const EMBED_CONTENT_LINE_CAP = 40;
const EMBED_BATCH_SIZE = 16;

/**
 * Build a compact text representation of a chunk for embedding.
 * summary + keywords + first ~40 lines of content (capped ~500 chars).
 */
export function embedChunkText(chunk: Chunk): string {
  const parts: string[] = [];
  if (chunk.summary) parts.push(chunk.summary);
  if (chunk.keywords) parts.push(chunk.keywords);
  if (chunk.symbolName) parts.push(chunk.symbolName);
  if (chunk.sectionTitle) parts.push(chunk.sectionTitle);

  const lines = (chunk.content || '').split('\n').slice(0, EMBED_CONTENT_LINE_CAP);
  let content = lines.join('\n');
  if (content.length > EMBED_CONTENT_CHAR_CAP) {
    content = content.slice(0, EMBED_CONTENT_CHAR_CAP);
  }
  if (content) parts.push(content);

  return parts.join('\n').trim();
}

/**
 * Batch-embed chunks and upsert into chunk_embeddings.
 * No-op if embeddings are unavailable. Never throws.
 */
export async function indexChunkEmbeddings(
  db: Database.Database,
  chunks: Chunk[],
  signal?: AbortSignal
): Promise<void> {
  if (!chunks.length || !isEmbeddingsAvailable()) return;

  try {
    const store = new EmbeddingsStore(db);
    const model = getEmbeddingModelId();

    for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
      signal?.throwIfAborted();
      const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
      const texts = batch.map(embedChunkText);
      const vectors = await embedTexts(texts);
      if (!vectors.length) return; // model failed — stop quietly

      const n = Math.min(batch.length, vectors.length);
      for (let j = 0; j < n; j++) {
        try {
          store.upsertEmbedding(batch[j].id, vectors[j], model);
        } catch (e: any) {
          console.error(
            `[contextos] embedding upsert failed for ${batch[j].id}: ${e?.message || e}`
          );
        }
      }
    }
  } catch (e: any) {
    console.error(`[contextos] indexChunkEmbeddings failed: ${e?.message || e}`);
  }
}

/**
 * Embed the prompt, run kNN over stored embeddings, return scored chunks.
 * Returns [] if embeddings unavailable or on any error.
 */
export async function searchEmbeddingChunks(
  db: Database.Database,
  prompt: string,
  limit: number = 15
): Promise<ScoredChunk[]> {
  if (!prompt || !isEmbeddingsAvailable()) return [];

  try {
    const vectors = await embedTexts([prompt]);
    if (!vectors.length) return [];

    const store = new EmbeddingsStore(db);
    const hits = store.searchSimilar(vectors[0], limit);
    if (!hits.length) return [];

    const repo = new ChunksRepo(db);
    const chunks = repo.getByIds(hits.map((h) => h.chunkId));
    const byId = new Map(chunks.map((c) => [c.id, c]));

    const scored: ScoredChunk[] = [];
    for (const hit of hits) {
      const chunk = byId.get(hit.chunkId);
      if (!chunk) continue;
      scored.push({ ...chunk, score: hit.score });
    }
    return scored;
  } catch (e: any) {
    console.error(`[contextos] searchEmbeddingChunks failed: ${e?.message || e}`);
    return [];
  }
}

/**
 * Backfill embeddings for every chunk in the database.
 * Used by `contextos reindex --embeddings`.
 */
export async function backfillAllEmbeddings(
  db: Database.Database,
  signal?: AbortSignal
): Promise<number> {
  if (!isEmbeddingsAvailable()) return 0;
  try {
    const rows = db.prepare(`SELECT * FROM chunks`).all() as any[];
    if (!rows.length) return 0;

    const repo = new ChunksRepo(db);
    // Re-map via getByIds to get camelCase Chunk objects
    const ids = rows.map((r) => r.id as string);
    const chunks: Chunk[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      signal?.throwIfAborted();
      chunks.push(...repo.getByIds(ids.slice(i, i + 200)));
    }
    await indexChunkEmbeddings(db, chunks, signal);
    return chunks.length;
  } catch (e: any) {
    console.error(`[contextos] backfillAllEmbeddings failed: ${e?.message || e}`);
    return 0;
  }
}
