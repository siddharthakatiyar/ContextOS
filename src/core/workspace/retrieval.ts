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
import { GraphStore } from '../knowledge/graph-store.js';
import { learnRetrievedImports } from '../knowledge/import-learning.js';
import { parseRef } from './identity.js';
import { entityRef } from './identity.js';
import { loadConfig } from '../../config/index.js';
import { getErrorMessage } from '../../utils/errors.js';

export function qualifyChunk<T extends ScoredChunk>(chunk: T, source: RepositorySource): T {
  return {
    ...chunk,
    id: entityRef(source.repoId, 'chunk', chunk.id),
    localId: chunk.id,
    repoId: source.repoId,
    viewId: source.viewId,
    projectId: source.projectId,
    worktreeId: source.worktreeId,
    branch: source.branch,
    head: source.head,
    worktreePath: source.rootPath,
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
      await repo.prepareRead();
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
      repo.assertReadable();
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
  const knowledgeLinks: NonNullable<RetrievalResult['knowledgeLinks']> = [];
  let learnedLinks: NonNullable<RetrievalResult['learnedLinks']> = [];
  let linkSuggestions: NonNullable<RetrievalResult['linkSuggestions']> = [];
  if (
    (!opts.layers || opts.layers.includes('repo')) &&
    (scope.sources.length > 1 || fs.existsSync(path.join(runtime.registry.home, 'graph.db')))
  ) {
    const graph = new GraphStore({
      home: runtime.registry.home,
      resolve: (id) => {
        const source = runtime.registry.resolve(id);
        return { source, db: runtime.get(source).db.getInstance() };
      }
    });
    try {
      const permitted = scope.sources
        .filter((source) => !unavailableSources.some((failed) => failed.repoId === source.repoId))
        .map((source) => source.repoId);
      const learned = await learnRetrievedImports(
        graph,
        scope.sources.filter((source) => permitted.includes(source.repoId)),
        (id) => {
          const source = runtime.registry.resolve(id);
          return { source, db: runtime.get(source).db.getInstance() };
        },
        chunks,
        signal
      );
      learnedLinks = learned.learnedLinks;
      linkSuggestions = learned.linkSuggestions;
      const seen = new Set(chunks.map((chunk) => chunk.id));
      let frontier = chunks
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, 10)
        .map((chunk) => chunk.id);
      frontier = [...new Set([...frontier, ...learned.sourceRefs])];
      const seedScore = Math.max(1, ...chunks.map((chunk) => chunk.score));
      const seenLinks = new Set<string>();
      for (let depth = 1; depth <= 2 && frontier.length; depth++) {
        const expanded = graph.expand(frontier, permitted, 12, seenLinks);
        for (const link of expanded.links)
          if (!seenLinks.has(link.id)) {
            seenLinks.add(link.id);
            knowledgeLinks.push(link);
          }
        const next: string[] = [];
        for (const ref of expanded.refs) {
          if (seen.has(ref)) continue;
          const parsed = parseRef(ref);
          const source = scope.sources.find((view) => view.repoId === parsed?.repoId);
          if (!parsed || !source || parsed.kind !== 'chunk') continue;
          const row = new ChunksRepo(runtime.get(source).db.getInstance()).getByIds([
            parsed.localId
          ])[0];
          if (!row || (opts.layers?.length && !opts.layers.includes(row.layer))) continue;
          const chunk = qualifyChunk({ ...row, score: seedScore * Math.pow(0.6, depth) }, source);
          chunks.push(chunk);
          seen.add(ref);
          next.push(ref);
          if (explanation)
            explanation.chunks[ref] = {
              finalScore: chunk.score,
              graph: { matchedEntities: [row.symbolName ?? row.sourceFile] }
            };
        }
        frontier = next;
      }
      const facts = graph.searchFacts(prompt, {
        viewIds: permitted,
        projectIds: [...new Set(scope.sources.map((view) => view.projectId))],
        groupId: scope.groupId ?? scope.workspaceId,
        limit: 5
      });
      for (const fact of facts) {
        const source =
          fact.provenance === 'user' && fact.scope === 'project'
            ? scope.sources.find((view) => view.projectId === fact.scopeId)
            : fact.provenance === 'user' && fact.scope === 'group'
              ? (scope.sources.find((view) => view.repoId === scope.activeRepoId) ??
                scope.sources[0])
              : scope.sources.find((view) => view.repoId === fact.viewIds[0]);
        if (!source) continue;
        const factChunk: ScoredChunk = {
          id: entityRef(source.repoId, 'fact', fact.id),
          localId: fact.id,
          repoId: source.repoId,
          viewId: source.viewId,
          projectId: source.projectId,
          worktreeId: source.worktreeId,
          worktreePath: source.rootPath,
          repoName: source.name,
          branch: source.branch,
          head: source.head,
          relativePath: 'memory.fact',
          sourceFile: 'memory.fact',
          layer: 'repo',
          workspaceName: null,
          sectionTitle: 'Verified knowledge',
          sectionDepth: 0,
          content:
            fact.content +
            (fact.evidence.length
              ? '\nEvidence: ' + fact.evidence.map((e) => e.ref).join(', ')
              : '\nProvenance: explicit user statement'),
          summary: null,
          keywords: null,
          hash: fact.id,
          importance: 8,
          tokenCount: Math.ceil(fact.content.length / 4),
          score: seedScore * 0.8,
          createdAt: fact.createdAt,
          updatedAt: fact.updatedAt
        };
        chunks.push(factChunk);
      }
    } finally {
      graph.close();
    }
  }
  chunks.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    knowledgeLinks,
    learnedLinks,
    linkSuggestions,
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
