import { ChunksRepo } from '../storage/chunks-repo.js';
import { RelationshipsRepo } from '../storage/relationships-repo.js';
import { GraphExpander, ExpandedEntity } from '../graph/expander.js';
import { detectIntent } from './intent-detector.js';
import { KeywordMatcher } from './keyword-matcher.js';
import { scoreChunks } from './scorer.js';
import { RetrievalOptions, RetrievalResult } from './types.js';

export * from './types.js';

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
    
    // Step 1: Detect intent
    const intent = detectIntent(prompt);
    
    // Step 2: Keyword matching (FTS + direct)
    const directMatches = this.matcher.matchChunks(intent, opts);
    
    // Step 3: Relationship expansion — ONLY use actual code identifiers as seeds
    const seedEntities = new Set<string>([...intent.identifiers, ...intent.quotedTerms]);
    const isIdentifier = (k: string) => /^[a-z]+(?:[A-Z][a-z]+)+$|^[a-z]+(?:_[a-z]+)+$|^[a-z]+(?:\.[a-z]+)+$/.test(k);
    
    // Only extract identifier-shaped keywords from top matches (not generic words)
    for (const match of directMatches.slice(0, 5)) {
      if (match.keywords) {
        match.keywords.split(', ').map((k: string) => k.trim()).filter(isIdentifier).forEach((k: string) => seedEntities.add(k));
      }
      // Also seed with symbol names from matched chunks
      if (match.symbolName && match.symbolName.length > 2) {
        seedEntities.add(match.symbolName);
      }
    }
    
    const expandedEntities = this.expander.expand(Array.from(seedEntities), 2, 20);
    
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
    
    const allChunks = Array.from(allChunksMap.values());
    const chunkIds = allChunks.map(c => c.id);
    
    // Fetch feedback adjustments if not provided in opts
    let adjustments = opts?.feedbackAdjustments;
    if (!adjustments && this.primaryChunksRepo) {
      adjustments = this.primaryChunksRepo.getFeedbackAdjustments(chunkIds);
    }
    
    const scored = scoreChunks(allChunks, expandedEntities, adjustments || {});
    
    // Step 6: Cap and return
    const topChunks = scored.slice(0, opts?.maxChunks ?? 15);
    
    return {
      chunks: topChunks,
      intent,
      expandedEntities,
      latencyMs: Date.now() - startTime,
    };
  }
}
