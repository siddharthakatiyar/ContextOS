import { ChunksRepo } from '../storage/chunks-repo.js';
import { RelationshipsRepo } from '../storage/relationships-repo.js';
import { GraphExpander, ExpandedEntity } from '../graph/expander.js';
import { detectIntent } from './intent-detector.js';
import { KeywordMatcher, expandMatchTokens } from './keyword-matcher.js';
import { scoreChunks } from './scorer.js';
import { RetrievalOptions, RetrievalResult, ScoredChunk } from './types.js';
import { loadConfig } from '../../config/index.js';
import { isEmbeddingsAvailable, searchEmbeddingChunks } from '../embeddings/index.js';

export * from './types.js';

export function deduplicateChunks(scored: ScoredChunk[]): ScoredChunk[] {
  scored.sort((a, b) => (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id));
  const uniqueChunks: ScoredChunk[] = [];
  const seenHashes = new Set<string>();
  for (const c of scored) {
    if (c.hash) {
      if (seenHashes.has(c.hash)) continue;
      seenHashes.add(c.hash);
    }
    uniqueChunks.push(c);
  }
  return uniqueChunks;
}

/**
 * When a class chunk and its method chunks (same sourceFile, parentSymbol == class name)
 * both survive: never drop method bodies for a compact outline; keep cheap outlines so
 * `class Foo` markers survive. Only drop oversized class bodies (pure duplication).
 * Avoid cumulative parent-score inflation across loop iterations.
 *
 * Also: function/method parents vs additive `segment` children — keep parent when it is
 * an exact identifier hit; otherwise prefer matched segments and drop the giant parent.
 */
export function containmentDedup(chunks: ScoredChunk[], identifiers: string[] = []): ScoredChunk[] {
  const drop = new Set<string>();
  const idSet = new Set(identifiers.map((id) => id.toLowerCase()));

  const classes = chunks.filter((c) => c.symbolKind === 'class' || c.symbolKind === 'struct');
  const methods = chunks.filter(
    (c) => c.parentSymbol && (c.symbolKind === 'function' || c.symbolKind === 'method')
  );

  for (const parent of classes) {
    if (drop.has(parent.id)) continue;

    const childMethods = methods.filter(
      (m) =>
        !drop.has(m.id) &&
        m.sourceFile === parent.sourceFile &&
        m.parentSymbol === parent.symbolName
    );
    if (childMethods.length === 0) continue;

    const parentTokens = parent.tokenCount || 0;
    const parentScore = parent.score || 0;
    const isCompactOutline = parentTokens < 80;
    const isOversized = parentTokens > 500;

    // Compact outlines: NEVER drop methods in favor of the outline. Keep both
    // (outline is cheap) so class-declaration markers remain available.
    if (isCompactOutline) {
      continue;
    }

    // Oversized class bodies are pure duplication — always drop in favor of methods
    if (isOversized) {
      const share = (parentScore * 0.15) / childMethods.length;
      for (const m of childMethods) {
        m.score = (m.score || 0) + share;
      }
      drop.add(parent.id);
      continue;
    }

    // Medium-sized class: decide once (no per-method parent inflation)
    const bestMethodScore = Math.max(...childMethods.map((m) => m.score || 0));
    if (bestMethodScore >= parentScore) {
      // Prefer methods — drop parent body (duplicative), keep methods
      const share = (parentScore * 0.15) / childMethods.length;
      for (const m of childMethods) {
        m.score = (m.score || 0) + share;
      }
      drop.add(parent.id);
    } else {
      // Parent wins — drop methods once (no cumulative inflation)
      const methodSum = childMethods.reduce((s, m) => s + (m.score || 0), 0);
      parent.score = parentScore + (methodSum * 0.25) / childMethods.length;
      for (const m of childMethods) {
        drop.add(m.id);
      }
    }
  }

  // Function/method parents vs additive segment children
  // Accuracy-first: NEVER drop the parent (E2E relies on full bodies when the
  // prompt names or needs the whole function). Only drop segments when the
  // parent is an exact identifier hit (full body will be compiled).
  // All functions/methods that were retrieved
  const fnParents = chunks.filter(
    (c) => (c.symbolKind === 'function' || c.symbolKind === 'method') && c.symbolName
  );
  const segments = chunks.filter((c) => c.symbolKind === 'segment' && c.parentSymbol);

  for (const parent of fnParents) {
    if (drop.has(parent.id)) continue;
    const kids = segments.filter(
      (s) =>
        !drop.has(s.id) &&
        s.sourceFile === parent.sourceFile &&
        s.parentSymbol === parent.symbolName
    );
    if (kids.length === 0) continue;

    const exactId = !!parent.symbolName && idSet.has(parent.symbolName.toLowerCase());
    const isGiant = (parent.tokenCount || 0) > 1200;

    if (exactId || !isGiant) {
      // Keep full parent body
      // If it's a generic query (!exactId), the parent might have a terrible BM25 score
      // compared to its dense segments. Let it inherit the best segment score.
      if (!exactId) {
        const bestSegScore = Math.max(...kids.map((k) => k.score || 0));
        if (bestSegScore > (parent.score || 0)) {
          parent.score = bestSegScore * 0.95;
        }
      }
      // Drop all segments since we're keeping the parent
      for (const s of kids) drop.add(s.id);
    } else {
      // Prompt did NOT name this giant function exactly — drop the giant parent
      // and distribute its score among the retrieved segments.
      const parentScore = parent.score || 0;
      for (const s of kids) {
        s.score = Math.max(s.score || 0, parentScore * 0.9);
        (s as any).parentDropped = true;
      }
      drop.add(parent.id);
    }
  }

  return chunks.filter((c) => !drop.has(c.id));
}

export class RetrievalEngine {
  private matcher: KeywordMatcher;
  private expander: GraphExpander;
  private primaryChunksRepo: ChunksRepo;

  constructor(
    chunksRepos: ChunksRepo | ChunksRepo[],
    relsRepos: RelationshipsRepo | RelationshipsRepo[]
  ) {
    this.matcher = new KeywordMatcher(chunksRepos);
    this.expander = new GraphExpander(relsRepos);
    this.primaryChunksRepo = Array.isArray(chunksRepos) ? chunksRepos[0] : chunksRepos;
  }

  public async retrieve(
    prompt: string,
    opts?: RetrievalOptions,
    signal?: AbortSignal
  ): Promise<RetrievalResult> {
    const startTime = Date.now();
    const config = loadConfig();
    const pipeline = config.pipeline ?? {};

    // Step 1: Detect intent
    signal?.throwIfAborted();
    const intent = detectIntent(prompt);

    // Step 2: Keyword matching (FTS + direct) → RRF-fused
    let directMatches = this.matcher.matchChunks(intent, opts);
    directMatches.sort((a, b) => (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id));

    // Keyword confidence: top-score margin + hit count (gates emb fallback)
    const topScore = directMatches[0]?.score || 0;
    const secondScore = directMatches[1]?.score || 0;
    const margin = topScore > 0 ? (topScore - secondScore) / topScore : 0;
    const hasExactId =
      intent.identifiers.length > 0 &&
      directMatches
        .slice(0, 5)
        .some(
          (c) =>
            c.symbolName &&
            intent.identifiers.some((id) => id.toLowerCase() === c.symbolName!.toLowerCase())
        );
    const lowConfidence =
      directMatches.length === 0 ||
      (!hasExactId && (topScore < 8 || (directMatches.length >= 2 && margin < 0.15)));

    // Step 2b: Embeddings (helper keeps `retrieve` body under the segment threshold)
    // The pipeline.embeddingFusion flag overrides embeddingsRetrieval when explicitly set.
    const embFusionEnabled =
      pipeline.embeddingFusion !== undefined ? pipeline.embeddingFusion : undefined; // undefined → applyEmbeddingFusion uses its own logic
    directMatches = await this.applyEmbeddingFusion(
      prompt,
      directMatches,
      lowConfidence,
      embFusionEnabled
    );

    // Step 3: Relationship expansion — ONLY use actual code identifiers as seeds
    signal?.throwIfAborted();
    const seedEntities = new Set<string>([...intent.identifiers, ...intent.quotedTerms]);
    const isIdentifier = (k: string) =>
      /^[a-z]+(?:[A-Z][a-z]+)+$|^[a-z]+(?:_[a-z]+)+$|^[a-z]+(?:\.[a-z]+)+$/.test(k);

    // Only extract identifier-shaped keywords from top matches (not generic words)
    directMatches.sort((a, b) => (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id));
    // Step 3 (cont.): Graph expansion
    let expandedEntities: ExpandedEntity[] = [];
    if (pipeline.graphExpansion !== false) {
      for (const match of directMatches.slice(0, 5)) {
        if (match.keywords) {
          match.keywords
            .split(', ')
            .map((k: string) => k.trim())
            .filter(isIdentifier)
            .forEach((k: string) => seedEntities.add(k));
        }
        if (match.symbolName && match.symbolName.length > 2) {
          seedEntities.add(match.symbolName);
        }
      }
      expandedEntities = this.expander.expand(
        Array.from(seedEntities),
        config.graphExpansionDepth || 2,
        config.graphExpansionMaxNodes || 20
      );
    }

    // Step 4: Retrieve chunks for expanded entities
    signal?.throwIfAborted();
    const expandedEntityNames = expandedEntities.map((e) => e.entity);
    const expandedChunks = this.matcher.matchForEntities(expandedEntityNames);

    // Step 5: Merge + Score
    // deduplicate and sum scores
    const allChunksMap = new Map();
    for (const c of directMatches) allChunksMap.set(c.id, c);
    for (const c of expandedChunks) {
      if (!allChunksMap.has(c.id)) {
        allChunksMap.set(c.id, c);
      } else {
        // Rank Fusion graph-walk overlap: if chunk is found via keyword/semantic AND
        // relationship expansion, this is a strong relevance signal for generic queries.
        allChunksMap.get(c.id).score = (allChunksMap.get(c.id).score || 0) + (c.score || 0) * 1.5;
      }
    }

    let allChunks = Array.from(allChunksMap.values()) as ScoredChunk[];

    // Step 5b: Ensure parents of all retrieved segments are present
    // If a parent function fell just below the FTS limit but its segments made it,
    // containmentDedup needs the parent to correctly inherit scores and drop the segments.
    const missingParents = new Set<string>();
    for (const c of allChunks) {
      if (c.symbolKind === 'segment' && c.parentSymbol) {
        missingParents.add(c.parentSymbol);
      }
    }
    for (const c of allChunks) {
      if (c.symbolName && c.symbolKind !== 'segment') {
        missingParents.delete(c.symbolName);
      }
    }
    for (const parentSymbol of missingParents) {
      const pChunks = this.primaryChunksRepo
        ? this.primaryChunksRepo.findBySymbolName(parentSymbol)
        : [];
      for (const p of pChunks) {
        if (p.symbolKind !== 'segment' && !allChunksMap.has(p.id)) {
          allChunksMap.set(p.id, p);
        }
      }
    }
    allChunks = Array.from(allChunksMap.values()) as ScoredChunk[];
    const chunkIds = allChunks.map((c) => c.id);

    // Fetch feedback adjustments if not provided in opts
    let adjustments = opts?.feedbackAdjustments;
    if (!adjustments && this.primaryChunksRepo) {
      adjustments = this.primaryChunksRepo.getFeedbackAdjustments(chunkIds);
    }

    const matchTokens = expandMatchTokens([
      ...intent.identifiers,
      ...intent.concepts.filter((c) => !c.includes(' ')),
      ...intent.quotedTerms
    ]);

    signal?.throwIfAborted();
    let scored = scoreChunks(allChunks, expandedEntities, adjustments || {}, {
      repoRoot: opts?.repoRoot,
      matchTokens,
      identifiers: intent.identifiers,
      diversityFilter: pipeline.diversityFilter !== false
    });
    // Containment dedup after scoring so we keep the higher-scoring class or method
    if (pipeline.containmentDedup !== false) {
      scored = containmentDedup(scored, intent.identifiers);
    }
    scored = deduplicateChunks(scored);

    // Soft segment cap: keep at most 2 naturally-matched segments so they don't
    // crowd out other symbols. Exact-id parents already dropped their segments in dedup.
    // Prefer segments whose parent is also in the result set and that hit prompt terms.
    const maxChunks = opts?.maxChunks ?? config.maxRetrievalResults;
    const parentNames = new Set(
      scored.filter((c) => c.symbolName).map((c) => c.symbolName!.toLowerCase())
    );
    const promptTerms = [
      ...intent.identifiers,
      ...intent.concepts.filter((c) => !c.includes(' '))
    ].map((t) => t.toLowerCase());
    const segs = scored
      .filter((c) => c.symbolKind === 'segment')
      .sort((a, b) => {
        // Treat intentionally dropped parents (via containmentDedup) as present so we don't punish their segments
        const aParent =
          (a as any).parentDropped || parentNames.has((a.parentSymbol || '').toLowerCase()) ? 1 : 0;
        const bParent =
          (b as any).parentDropped || parentNames.has((b.parentSymbol || '').toLowerCase()) ? 1 : 0;
        if (aParent !== bParent) return bParent - aParent;
        const aHits = promptTerms.filter(
          (t) => t.length >= 5 && a.content.toLowerCase().includes(t)
        ).length;
        const bHits = promptTerms.filter(
          (t) => t.length >= 5 && b.content.toLowerCase().includes(t)
        ).length;
        if (aHits !== bHits) return bHits - aHits;
        return (b.score || 0) - (a.score || 0);
      })
      .slice(0, 4);
    const segIds = new Set(segs.map((s) => s.id));
    const limited: ScoredChunk[] = [];
    for (const c of scored) {
      if (c.symbolKind === 'segment' && !segIds.has(c.id)) continue;
      limited.push(c);
      if (limited.length >= maxChunks) break;
    }

    // Step 6: Cap and return
    const topChunks = limited;

    return {
      chunks: topChunks,
      intent,
      expandedEntities,
      latencyMs: Date.now() - startTime
    };
  }

  /**
   * Optional embedding fusion: agreement-boost keyword hits; on low confidence,
   * insert a few emb-only candidates. Kept out of `retrieve` so that method's
   * body stays under maxSymbolChunkTokens (E2E can show the full pipeline).
   *
   * @param forceEnabled When explicitly set by pipeline config, overrides embeddingsRetrieval.
   *                     When undefined, falls back to config + env-var logic.
   */
  private async applyEmbeddingFusion(
    prompt: string,
    directMatches: ScoredChunk[],
    lowConfidence: boolean,
    forceEnabled?: boolean
  ): Promise<ScoredChunk[]> {
    try {
      const embRetrievalOn =
        forceEnabled !== undefined
          ? forceEnabled
          : loadConfig().embeddingsRetrieval === true ||
            process.env.CONTEXTOS_EMBEDDINGS_RETRIEVAL === '1';
      if (
        !isEmbeddingsAvailable() ||
        !this.primaryChunksRepo ||
        !(embRetrievalOn || lowConfidence)
      ) {
        return directMatches;
      }
      const embHits = await searchEmbeddingChunks(this.primaryChunksRepo.getDatabase(), prompt, 15);
      if (embHits.length === 0) return directMatches;

      const embRank = new Map(embHits.map((c, i) => [c.id, i]));
      for (const c of directMatches) {
        const rank = embRank.get(c.id);
        if (rank !== undefined && rank < 10) {
          // Strong multiplicative boost for semantic + keyword overlap
          c.score = (c.score || 0) * (1.2 + 0.5 * (1 / (1 + rank)));
        }
      }
      if (lowConfidence) {
        const seen = new Set(directMatches.map((c) => c.id));
        let inserted = 0;
        for (let i = 0; i < embHits.length && inserted < 5; i++) {
          const hit = embHits[i];
          if (seen.has(hit.id)) continue;
          seen.add(hit.id);
          // Stronger base score for backfills to ensure they actually surface
          const base = Math.max(8, 14 - i * 1.5);
          directMatches.push({ ...hit, score: base });
          inserted++;
        }
      }
    } catch {
      // keyword-only path must keep working
    }
    return directMatches;
  }
}
