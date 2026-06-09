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

  constructor(chunksRepos: ChunksRepo | ChunksRepo[], relsRepos: RelationshipsRepo | RelationshipsRepo[]) {
    this.matcher = new KeywordMatcher(chunksRepos);
    this.expander = new GraphExpander(relsRepos);
  }

  public async retrieve(prompt: string, opts?: RetrievalOptions): Promise<RetrievalResult> {
    const startTime = Date.now();
    
    // Step 1: Detect intent
    const intent = detectIntent(prompt);
    
    // Step 2: Keyword matching (FTS + direct)
    const directMatches = this.matcher.matchChunks(intent, opts);
    
    // Step 3: Relationship expansion
    const seedEntities = new Set<string>([...intent.identifiers, ...intent.quotedTerms]);
    const isIdentifier = (k: string) => /^[a-z]+(?:[A-Z][a-z]+)+$|^[a-z]+(?:_[a-z]+)+$|^[a-z]+(?:\.[a-z]+)+$/.test(k);
    
    for (const match of directMatches.slice(0, 5)) {
      if (match.keywords) {
        match.keywords.split(', ').map(k => k.trim()).filter(isIdentifier).forEach(k => seedEntities.add(k));
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
    const scored = scoreChunks(allChunks, expandedEntities);
    
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
