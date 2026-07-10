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

/**
 * When a class chunk and its method chunks (same sourceFile, parentSymbol == class name)
 * both survive: never drop method bodies for a compact outline; keep cheap outlines so
 * `class Foo` markers survive. Only drop oversized class bodies (pure duplication).
 * Avoid cumulative parent-score inflation across loop iterations.
 */
function containmentDedup(chunks: ScoredChunk[]): ScoredChunk[] {
  const drop = new Set<string>();

  const classes = chunks.filter(c => c.symbolKind === 'class' || c.symbolKind === 'struct');
  const methods = chunks.filter(c => c.parentSymbol && (c.symbolKind === 'function' || c.symbolKind === 'method'));

  for (const parent of classes) {
    if (drop.has(parent.id)) continue;

    const childMethods = methods.filter(
      m =>
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
    const bestMethodScore = Math.max(...childMethods.map(m => m.score || 0));
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

  return chunks.filter(c => !drop.has(c.id));
}

export class RetrievalEngine {
  private matcher: KeywordMatcher;
  private expander: GraphExpander;
  private primaryChunksRepo: ChunksRepo;

  constructor(chunksRepos: ChunksRepo | ChunksRepo[], relsRepos: RelationshipsRepo | RelationshipsRepo[]) {
    this.matcher = new KeywordMatcher(chunksRepos);
    this.expander = new GraphExpander(relsRepos);
    this.primaryChunksRepo = Array.isArray(chunksRepos) ? chunksRepos[0] : chunksRepos;
  }

  public async retrieve(prompt: string, opts?: RetrievalOptions): Promise<RetrievalResult> {
    const startTime = Date.now();
    const config = loadConfig();

    // Step 1: Detect intent
    const intent = detectIntent(prompt);

    // Step 2: Keyword matching (FTS + direct) → RRF-fused
    let directMatches = this.matcher.matchChunks(intent, opts);

    // Step 2b: Optional embedding hybrid — agreement boost only (no emb-only inserts).
    // Appending emb-only hits / equal RRF diluted keyword precision after full backfill.
    try {
      if (
          isEmbeddingsAvailable() &&
          this.primaryChunksRepo &&
          (loadConfig().embeddingsRetrieval === true ||
            process.env.CONTEXTOS_EMBEDDINGS_RETRIEVAL === '1')
        ) {
        const embHits = await searchEmbeddingChunks(
          this.primaryChunksRepo.getDatabase(),
          prompt,
          15
        );
        if (embHits.length > 0) {
          const embRank = new Map(embHits.map((c, i) => [c.id, i]));
          for (const c of directMatches) {
            const rank = embRank.get(c.id);
            if (rank !== undefined && rank < 10) {
              c.score = (c.score || 0) * (1.03 + 0.08 * (1 / (1 + rank)));
            }
          }
        }
      }
    } catch {
      // keyword-only path must keep working
    }

    // Step 3: Relationship expansion — ONLY use actual code identifiers as seeds
    const seedEntities = new Set<string>([...intent.identifiers, ...intent.quotedTerms]);
    const isIdentifier = (k: string) => /^[a-z]+(?:[A-Z][a-z]+)+$|^[a-z]+(?:_[a-z]+)+$|^[a-z]+(?:\.[a-z]+)+$/.test(k);

    // Only extract identifier-shaped keywords from top matches (not generic words)
    directMatches.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const match of directMatches.slice(0, 5)) {
      if (match.keywords) {
        match.keywords.split(', ').map((k: string) => k.trim()).filter(isIdentifier).forEach((k: string) => seedEntities.add(k));
      }
      if (match.symbolName && match.symbolName.length > 2) {
        seedEntities.add(match.symbolName);
      }
    }

    const expandedEntities = this.expander.expand(Array.from(seedEntities), config.graphExpansionDepth || 2, config.graphExpansionMaxNodes || 20);

    // Step 4: Retrieve chunks for expanded entities
    const expandedEntityNames = expandedEntities.map(e => e.entity);
    const expandedChunks = this.matcher.matchForEntities(expandedEntityNames);

    // Step 5: Merge + Score
    // deduplicate and sum scores
    const allChunksMap = new Map();
    for (const c of directMatches) allChunksMap.set(c.id, c);
    for (const c of expandedChunks) {
      if (!allChunksMap.has(c.id)) {
        allChunksMap.set(c.id, c);
      } else {
        allChunksMap.get(c.id).score += (c.score || 0);
      }
    }

    let allChunks = Array.from(allChunksMap.values()) as ScoredChunk[];
    const chunkIds = allChunks.map(c => c.id);

    // Fetch feedback adjustments if not provided in opts
    let adjustments = opts?.feedbackAdjustments;
    if (!adjustments && this.primaryChunksRepo) {
      adjustments = this.primaryChunksRepo.getFeedbackAdjustments(chunkIds);
    }

    const matchTokens = expandMatchTokens([
      ...intent.identifiers,
      ...intent.concepts.filter(c => !c.includes(' ')),
      ...intent.quotedTerms,
    ]);

    let scored = scoreChunks(allChunks, expandedEntities, adjustments || {}, {
      repoRoot: opts?.repoRoot,
      matchTokens,
      identifiers: intent.identifiers,
    });
    // Containment dedup after scoring so we keep the higher-scoring class or method
    scored = containmentDedup(scored);
    scored.sort((a, b) => (b.score || 0) - (a.score || 0));

    // Step 6: Cap and return
    const topChunks = scored.slice(0, opts?.maxChunks ?? config.maxRetrievalResults);

    return {
      chunks: topChunks,
      intent,
      expandedEntities,
      latencyMs: Date.now() - startTime,
    };
  }
}
