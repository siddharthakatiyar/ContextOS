import { ChunksRepo } from '../storage/chunks-repo.js';
import { RelationshipsRepo } from '../storage/relationships-repo.js';
import { GraphExpander, ExpandedEntity } from '../graph/expander.js';
import { detectIntent } from './intent-detector.js';
import { KeywordMatcher } from './keyword-matcher.js';
import { scoreChunks } from './scorer.js';
import { RetrievalOptions, RetrievalResult, ScoredChunk } from './types.js';
import { loadConfig } from '../../config/index.js';

export * from './types.js';

/**
 * When a class chunk and its method chunks (same sourceFile, parentSymbol == class name)
 * both survive, keep whichever scored higher — but always prefer methods over an
 * oversized class body (which duplicates every method and blows the token budget).
 */
function containmentDedup(chunks: ScoredChunk[]): ScoredChunk[] {
  const drop = new Set<string>();

  const classes = chunks.filter(c => c.symbolKind === 'class' || c.symbolKind === 'struct');
  const methods = chunks.filter(c => c.parentSymbol && (c.symbolKind === 'function' || c.symbolKind === 'method'));

  for (const parent of classes) {
    const childMethods = methods.filter(
      m => m.sourceFile === parent.sourceFile && m.parentSymbol === parent.symbolName
    );
    if (childMethods.length === 0) continue;

    // Oversized class bodies are pure duplication — always drop in favor of methods
    if ((parent.tokenCount || 0) > 500) {
      const boost = (parent.score || 0) * 0.15;
      for (const m of childMethods) {
        m.score = (m.score || 0) + boost / childMethods.length;
      }
      drop.add(parent.id);
      continue;
    }

    for (const method of childMethods) {
      if (drop.has(method.id) || drop.has(parent.id)) continue;
      const methodScore = method.score || 0;
      const parentScore = parent.score || 0;
      if (parentScore >= methodScore) {
        parent.score = parentScore + methodScore * 0.25;
        drop.add(method.id);
      } else {
        method.score = methodScore + parentScore * 0.25;
        drop.add(parent.id);
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
    
    // Step 2: Keyword matching (FTS + direct)
    const directMatches = this.matcher.matchChunks(intent, opts);
    
    // Step 3: Relationship expansion — ONLY use actual code identifiers as seeds
    const seedEntities = new Set<string>([...intent.identifiers, ...intent.quotedTerms]);
    const isIdentifier = (k: string) => /^[a-z]+(?:[A-Z][a-z]+)+$|^[a-z]+(?:_[a-z]+)+$|^[a-z]+(?:\.[a-z]+)+$/.test(k);
    
    // Only extract identifier-shaped keywords from top matches (not generic words)
    directMatches.sort((a, b) => (b.score || 0) - (a.score || 0));
    for (const match of directMatches.slice(0, 5)) {
      if (match.keywords) {
        match.keywords.split(', ').map((k: string) => k.trim()).filter(isIdentifier).forEach((k: string) => seedEntities.add(k));
      }
      // Also seed with symbol names from matched chunks
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
    
    let scored = scoreChunks(allChunks, expandedEntities, adjustments || {});
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
