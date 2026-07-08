import { ChunksRepo } from '../storage/chunks-repo.js';
import { DetectedIntent, ScoredChunk, RetrievalOptions } from './types.js';
import { loadConfig } from '../../config/index.js';

export class KeywordMatcher {
  private chunksRepos: ChunksRepo[];

  constructor(chunksRepo: ChunksRepo | ChunksRepo[]) {
    this.chunksRepos = Array.isArray(chunksRepo) ? chunksRepo : [chunksRepo];
  }

  public matchChunks(intent: DetectedIntent, opts?: RetrievalOptions): ScoredChunk[] {
    const results: Map<string, ScoredChunk> = new Map();

    const addOrUpdate = (chunks: any[], scoreModifier: number) => {
      for (const c of chunks) {
        if (!results.has(c.id)) {
          results.set(c.id, { ...c, score: c.score ? c.score + scoreModifier : scoreModifier });
        } else {
          const existing = results.get(c.id)!;
          existing.score += scoreModifier;
        }
      }
    };

    const config = loadConfig();
    
    const runFTS = (query: string, boost: number) => {
      for (const repo of this.chunksRepos) {
        if (opts?.layers && opts.layers.length > 0) {
          for (const layer of opts.layers) {
            addOrUpdate(repo.searchFTS(query, { layer: layer as any, limit: opts?.limit ?? config.ftsLimit }), boost);
          }
        } else {
          addOrUpdate(repo.searchFTS(query, { limit: opts?.limit ?? config.ftsLimit }), boost);
        }
      }
    };

    // Strategy 0: Exact match for quoted terms
    for (const term of intent.quotedTerms) {
      runFTS(`"${term.replace(/"/g, '""')}"`, 20.0);
    }

    // Strategy 1: FTS5 full-text search (primary)
    // Use up to 15 concepts including bigrams and trigrams
    const searchTerms = intent.concepts.slice(0, 15);
    if (searchTerms.length > 0) {
      const ftsQuery = searchTerms.map(c => `"${c.replace(/"/g, '""')}"`).join(' OR ');
      runFTS(ftsQuery, 0);
    }

    // Strategy 2: Direct match on code identifiers
    for (const identifier of intent.identifiers) {
      // 1. Explicit keyword match
      for (const repo of this.chunksRepos) {
        const keywordHits = repo.findByKeyword(identifier);
        addOrUpdate(keywordHits, 10.0);
      }
      // 2. Full text exact search with massive boost to prioritize exact function/variable matches
      runFTS(`"${identifier.replace(/"/g, '""')}"`, 30.0);
    }

    // Strategy 3: Section title exact match (unigrams only)
    const unigrams = intent.concepts.filter(c => c.split(' ').length === 1);
    for (const concept of unigrams) {
      for (const repo of this.chunksRepos) {
        const titleHits = repo.findByTitleMatch(concept);
        addOrUpdate(titleHits, 10.0); // Strong boost
      }
    }

    // Strategy 4: Intent-aware boosting
    if (intent.intentType === 'fix') {
      runFTS('"error" OR "bug" OR "exception" OR "fix"', 5.0);
    } else if (intent.intentType === 'implement') {
      runFTS('"api" OR "interface" OR "spec" OR "implement"', 5.0);
    } else if (intent.intentType === 'pr') {
      runFTS('"pr" OR "pull request" OR "rules" OR "guidelines"', 5.0);
    }

    return Array.from(results.values());
  }

  public matchForEntities(entities: string[]): ScoredChunk[] {
    // For expanded entities, we do simple keyword queries
    const results: Map<string, ScoredChunk> = new Map();
    for (const entity of entities) {
      for (const repo of this.chunksRepos) {
        const hits = repo.findByKeyword(entity);
        for (const h of hits) {
          if (!results.has(h.id)) {
            results.set(h.id, { ...h, score: 3.0 }); // baseline score for expanded entities
          } else {
            results.get(h.id)!.score += 1.0;
          }
        }
      }
    }
    return Array.from(results.values());
  }
}
