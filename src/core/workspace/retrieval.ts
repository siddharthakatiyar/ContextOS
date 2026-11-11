import path from 'node:path';
import fs from 'node:fs';
import { DB, getContextOSHome } from '../storage/database.js';
import {
  RetrievalEngine,
  type RetrievalOptions,
  type RetrievalResult,
  type ScoredChunk
} from '../retrieval/index.js';
import { ChunksRepo } from '../storage/chunks-repo.js';
import { RelationshipsRepo } from '../storage/relationships-repo.js';
import { detectIntent } from '../retrieval/intent-detector.js';
import { WorkspaceRuntime } from './runtime.js';
import type { RepositorySource, RetrievalScope } from './registry.js';
import { entityRef } from './identity.js';
import { loadConfig } from '../../config/index.js';
import { getErrorMessage } from '../../utils/errors.js';

export function qualifyChunk<T extends ScoredChunk>(chunk: T, source: RepositorySource): T {
  return {
    ...chunk,
    id: entityRef(source.repoId, 'chunk', chunk.id),
    localId: chunk.id,
    repoId: source.repoId,
    repoName: source.name,
    relativePath: path.relative(source.rootPath, chunk.sourceFile).split(path.sep).join('/')
  };
}

/** Each source runs the established strategy/RRF/scoring pipeline in its own corpus.
 * Merge comparable fused scores, never raw BM25 values from separate databases. */
export async function retrieveWorkspace(
  runtime: WorkspaceRuntime,
  scope: RetrievalScope,
  prompt: string,
  opts: RetrievalOptions = {},
  signal?: AbortSignal
): Promise<RetrievalResult> {
  const started = Date.now();
  const chunks: ScoredChunk[] = [];
  const unavailableSources: NonNullable<RetrievalResult['unavailableSources']> = [];
  const expandedEntities: RetrievalResult['expandedEntities'] = [];
  let explanation: RetrievalResult['explanation'];
  for (const source of scope.sources) {
    signal?.throwIfAborted();
    try {
      const repo = runtime.get(source);
      if (
        repo.db
          .getInstance()
          .prepare("SELECT value FROM repository_metadata WHERE key='needs_reindex'")
          .get()
      )
        throw new Error('Copied index requires reindexing before it can be searched.');
      const engine = new RetrievalEngine(
        new ChunksRepo(repo.db.getInstance()),
        new RelationshipsRepo(repo.db.getInstance()),
        repo.config
      );
      const result = await engine.retrieve(
        prompt,
        { ...opts, repoRoot: source.rootPath, selectedRepo: true },
        signal
      );
      const locality = scope.sources.length > 1 && source.repoId === scope.activeRepoId ? 1.1 : 1;
      chunks.push(
        ...result.chunks
          .filter((chunk) => !opts.layers?.length || opts.layers.includes(chunk.layer))
          .map((chunk) => ({ ...qualifyChunk(chunk, source), score: chunk.score * locality }))
      );
      expandedEntities.push(
        ...result.expandedEntities.map((entity) => ({ ...entity, repoId: source.repoId }))
      );
      if (result.explanation) {
        explanation ??= { ...result.explanation, chunks: {} };
        for (const [id, detail] of Object.entries(result.explanation.chunks)) {
          explanation.chunks[entityRef(source.repoId, 'chunk', id)] = {
            ...detail,
            finalScore: detail.finalScore * locality,
            repository: { repoId: source.repoId, name: source.name, localityMultiplier: locality }
          };
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      unavailableSources.push({
        repoId: source.repoId,
        name: source.name,
        error: getErrorMessage(error)
      });
    }
  }
  if (unavailableSources.length === scope.sources.length)
    throw new Error(
      `All selected repositories failed: ${unavailableSources.map((s) => `${s.name}: ${s.error}`).join('; ')}`
    );
  const config = loadConfig({ cwd: opts.repoRoot });
  const globalPath = path.join(getContextOSHome(), 'index.db');
  if (
    (!opts.layers || opts.layers.includes('global')) &&
    fs.existsSync(globalPath) &&
    !scope.sources.some((source) => source.dbPath === globalPath)
  ) {
    let globalDb: DB | undefined;
    try {
      globalDb = new DB(globalPath);
      const engine = new RetrievalEngine(
        new ChunksRepo(globalDb.getInstance()),
        new RelationshipsRepo(globalDb.getInstance()),
        config
      );
      const global = await engine.retrieve(prompt, { ...opts, layers: ['global'] }, signal);
      chunks.push(
        ...global.chunks.map((chunk) => ({
          ...chunk,
          id: entityRef('global', 'chunk', chunk.id),
          localId: chunk.id
        }))
      );
    } catch (error) {
      signal?.throwIfAborted();
      unavailableSources.push({ repoId: 'global', name: 'global', error: getErrorMessage(error) });
    } finally {
      globalDb?.close();
    }
  }
  chunks.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    chunks: chunks.slice(0, opts.maxChunks ?? config.maxRetrievalResults),
    intent: detectIntent(prompt),
    expandedEntities,
    latencyMs: Date.now() - started,
    scope,
    unavailableSources,
    partial: unavailableSources.length > 0,
    explanation
  };
}
