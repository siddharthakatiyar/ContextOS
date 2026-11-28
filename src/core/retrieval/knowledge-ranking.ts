import { compactKnowledgeMetadata } from '../knowledge/write-context.js';
import type { GraphStore, Evidence } from '../knowledge/graph-store.js';
import type { KnowledgeFact } from '../memory/knowledge-store.js';
import type { WorkspaceRuntime } from '../workspace/runtime.js';
import { entityRef, parseRef } from '../workspace/identity.js';
import { estimateTokens } from '../../utils/tokens.js';
import type { RetrievalResult, ScoredChunk } from './types.js';
import { ChunksRepo } from '../storage/chunks-repo.js';

const STOP = new Set(
  'a an and are as at be by do does for from how in is it of on or repo repos repository repositories should the to use uses what when where which who with all'.split(
    ' '
  )
);
export function knowledgeTerms(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu) ?? []).filter(
        (term) => term.length >= 3 && !STOP.has(term)
      )
    )
  ];
}

/** Exact words/entities avoid substring matches such as billing -> rebilling. */
export function knowledgeRelevance(prompt: string, text: string): number {
  const terms = knowledgeTerms(prompt);
  const words = new Set(knowledgeTerms(text));
  const hits = terms.filter((term) => words.has(term));
  if (!hits.length || (hits.length === 1 && hits[0].length < 4)) return 0;
  return hits.length + hits.length / Math.max(1, terms.length);
}

export { rawChunkMultiplier } from './ranking-signals.js';

interface Candidate {
  chunk: ScoredChunk;
  status: string;
  relevance: number;
  evidence: Evidence[];
}

/**
 * Read-only ranking/assembly for get_context. GraphStore reads retain its evidence
 * freshness and scope guards. At most three verified matches reserve leading slots;
 * lower lifecycle states never receive that reservation or an evidence boost.
 */
export function rankSavedKnowledge(
  result: RetrievalResult,
  runtime: WorkspaceRuntime,
  graph: GraphStore,
  legacyFacts: Map<string, KnowledgeFact[]> = new Map(),
  options: { includeStale?: boolean; includeProposed?: boolean } = { includeProposed: true }
): void {
  const scope = result.scope;
  if (!scope) return;
  const prompt = result.intent.rawPrompt;
  const failed = new Set(result.unavailableSources?.map((s) => s.repoId));
  const sources = scope.sources.filter((s) => !failed.has(s.repoId));
  if (!sources.length) return;
  const viewIds = sources.map((s) => s.repoId);
  const broad = /\b(what does|overview|responsibilit\w*|purpose|role)\b/i.test(prompt);
  const namedSources = sources.filter((s) => knowledgeTerms(prompt).includes(s.name.toLowerCase()));
  const candidates: Candidate[] = [];
  const hiddenStale = new Set<string>();
  const make = (
    id: string,
    text: string,
    owner: string,
    status: string,
    relevance: number,
    evidence: Evidence[],
    title: string,
    meta: Record<string, unknown> = {}
  ) => {
    const source = sources.find((s) => s.repoId === owner);
    if (!source || !relevance) return;
    if (status === 'stale' && !options.includeStale) {
      hiddenStale.add(id);
      return;
    }
    if (status === 'proposed' && options.includeProposed === false) return;
    candidates.push({
      status,
      relevance,
      evidence,
      chunk: {
        ...meta,
        id,
        localId: parseRef(id)?.localId,
        repoId: owner,
        viewId: source.viewId,
        projectId: source.projectId,
        worktreeId: source.worktreeId,
        branch: source.branch,
        head: source.head,
        worktreePath: source.rootPath,
        repoName: source.name,
        relativePath: 'memory.fact',
        sourceFile: 'memory.fact',
        layer: 'repo',
        workspaceName: null,
        sectionTitle: title,
        sectionDepth: 0,
        content: text,
        summary: null,
        keywords: null,
        hash: id,
        importance: 8,
        tokenCount: estimateTokens(text),
        score: 0,
        createdAt: 0,
        updatedAt: 0
      }
    });
  };
  const facts = graph.searchFacts(prompt, {
    viewIds,
    projectIds: [...new Set(sources.map((s) => s.projectId))],
    groupId: scope.groupId ?? scope.workspaceId,
    includeStale: true,
    limit: Number.MAX_SAFE_INTEGER
  });
  // Role text need not repeat its repository name. Keep per-repository anchors
  // discoverable by ownership on broad questions without widening the scope.
  if (broad) {
    const seen = new Set(facts.map((fact) => fact.id));
    for (const fact of graph.exportKnowledge(viewIds, true).facts) {
      if (seen.has(fact.id) || !['role', 'overview'].includes(fact.category ?? '')) continue;
      const allowed =
        fact.scope === 'view'
          ? viewIds.includes(fact.scopeId)
          : fact.scope === 'project'
            ? sources.some((s) => s.projectId === fact.scopeId)
            : fact.scopeId === (scope.groupId ?? scope.workspaceId);
      if (allowed && fact.viewIds.some((id) => namedSources.some((s) => s.repoId === id)))
        facts.push(fact);
    }
  }
  for (const fact of facts) {
    if (!options.includeProposed && fact.status === 'proposed') continue;
    const source =
      fact.scope === 'project' && fact.provenance === 'user'
        ? sources.find((s) => s.projectId === fact.scopeId)
        : fact.scope === 'group' && fact.provenance === 'user'
          ? (sources.find((s) => s.repoId === scope.activeRepoId) ?? sources[0])
          : sources.find((s) => s.repoId === fact.viewIds[0]);
    if (!source) continue;
    const status = fact.status ?? 'verified';
    const anchor =
      broad &&
      ['role', 'overview'].includes(fact.category ?? '') &&
      namedSources.some((s) => s.repoId === source.repoId);
    make(
      entityRef(source.repoId, 'fact', fact.id),
      fact.content +
        (fact.evidence.length ? '\nEvidence: ' + fact.evidence.map((e) => e.ref).join(', ') : ''),
      source.repoId,
      status,
      (anchor ? 6 : 0) + knowledgeRelevance(prompt, fact.content),
      fact.evidence,
      `${status} knowledge`,
      compactKnowledgeMetadata({
        namespace: fact.namespace,
        expiresAt: fact.expiresAt,
        author: fact.author ?? undefined,
        taskId: fact.taskId ?? undefined,
        status
      })
    );
  }
  for (const source of sources) {
    for (const fact of legacyFacts.get(source.repoId) ?? []) {
      if (!options.includeProposed && fact.status === 'proposed') continue;
      const role = fact.category === 'role' || fact.category === 'overview';
      if (fact.confidence < 0.6 && runtime.get(source).config.memoryInjection !== 'always')
        continue;
      const relevance =
        knowledgeRelevance(prompt, fact.fact + (role ? ' ' + source.name : '')) +
        (broad && role && namedSources.some((s) => s.repoId === source.repoId) ? 6 : 0);
      make(
        entityRef(source.repoId, 'memory', fact.id),
        `**[${fact.category.toUpperCase()}]**: ${fact.fact}`,
        source.repoId,
        fact.status,
        relevance,
        [],
        `${fact.status} knowledge`,
        compactKnowledgeMetadata({
          namespace: fact.namespace,
          expiresAt: fact.expires_at,
          author: fact.author ?? undefined,
          taskId: fact.task_id ?? undefined,
          status: fact.status
        })
      );
    }
  }
  const links = graph.listLinks({ viewIds, includeStale: true });
  const matchedLinks = [];
  const labels = new Map<string, string>();
  const endpointLabel = (ref: string) => {
    if (labels.has(ref)) return labels.get(ref)!;
    const parsed = parseRef(ref);
    const source = sources.find((s) => s.repoId === parsed?.repoId);
    if (!source || !parsed || parsed.kind !== 'chunk') return '';
    const chunk = new ChunksRepo(runtime.get(source).db.getInstance()).getByIds([
      parsed.localId
    ])[0];
    const label = chunk
      ? `${source.name} ${chunk.symbolName ?? ''} ${chunk.sourceFile.split('/').at(-1) ?? ''}`
      : '';
    labels.set(ref, label);
    return label;
  };
  for (const link of links) {
    if (!options.includeProposed && link.status === 'proposed') continue;
    const owner = parseRef(link.source)?.repoId;
    if (!owner) continue;
    const relevance = knowledgeRelevance(
      prompt,
      `${link.rationale} ${endpointLabel(link.source)} ${endpointLabel(link.target)}`
    );
    if (!relevance) continue;
    const status = link.status ?? 'verified';
    if (
      (status !== 'stale' || options.includeStale) &&
      (status !== 'proposed' || options.includeProposed !== false)
    )
      matchedLinks.push(link);
    make(
      entityRef(owner, 'link', link.id),
      `${link.rationale}\n${link.type}: ${link.source} -> ${link.target}`,
      owner,
      status,
      relevance,
      link.evidence,
      `${status} relationship`,
      compactKnowledgeMetadata(link)
    );
  }
  if (hiddenStale.size)
    result.knowledgeHealth = `${hiddenStale.size} stale knowledge item${hiddenStale.size === 1 ? '' : 's'} hidden; run ctx_links include_stale or contextos verify --fix`;
  const state = (s: string) => (s === 'verified' ? 0 : s === 'proposed' ? 1 : 2);
  candidates.sort(
    (a, b) =>
      state(a.status) - state(b.status) ||
      b.relevance - a.relevance ||
      a.chunk.id.localeCompare(b.chunk.id)
  );
  const raw = result.chunks.filter((c) => c.sourceFile !== 'memory.fact');
  const maxRaw = Math.max(10, ...raw.map((c) => c.score));
  const evidence = new Set(
    candidates
      .filter((c) => c.status === 'verified')
      .slice(0, 3)
      .flatMap((c) => c.evidence.map((e) => e.ref))
  );
  for (const chunk of raw) chunk.score *= evidence.has(chunk.id) ? 1.3 : 1;
  let reserved = 0;
  for (const candidate of candidates) {
    candidate.chunk.score =
      candidate.status === 'verified'
        ? maxRaw * (reserved++ < 3 ? 8 : 1.5) + candidate.relevance
        : maxRaw * (candidate.status === 'proposed' ? 0.15 : 0.05) + candidate.relevance * 0.01;
  }
  result.chunks = [...candidates.map((c) => c.chunk), ...raw]
    .sort(
      (a, b) =>
        Number(a.status === 'stale') - Number(b.status === 'stale') ||
        b.score - a.score ||
        a.id.localeCompare(b.id)
    )
    .slice(0, runtime.get(sources[0]).config.maxRetrievalResults);
  result.knowledgeLinks = [
    ...new Map([...(result.knowledgeLinks ?? []), ...matchedLinks].map((l) => [l.id, l])).values()
  ].sort(
    (a, b) =>
      state(a.status ?? 'verified') - state(b.status ?? 'verified') ||
      knowledgeRelevance(prompt, b.rationale) - knowledgeRelevance(prompt, a.rationale) ||
      a.id.localeCompare(b.id)
  );
  if (result.explanation)
    for (const chunk of result.chunks) {
      result.explanation.chunks[chunk.id] = {
        ...result.explanation.chunks[chunk.id],
        finalScore: chunk.score
      };
    }
}
