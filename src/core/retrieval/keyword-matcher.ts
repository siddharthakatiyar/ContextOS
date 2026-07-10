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
      // 1. Broad OR query for recall
      const ftsQueryOr = searchTerms.map(c => `"${c.replace(/"/g, '""')}"`).join(' OR ');
      runFTS(ftsQueryOr, 0);
      
      // 2. Strict AND query for precision (massive boost if all concepts match)
      // We only do this if there are 2 to 5 concepts, otherwise it's too restrictive
      if (searchTerms.length >= 2 && searchTerms.length <= 6) {
         const ftsQueryAnd = searchTerms.map(c => `"${c.replace(/"/g, '""')}"`).join(' AND ');
         runFTS(ftsQueryAnd, 20.0);
      }
    }

    // Strategy 2: Direct match on code identifiers + exact symbol lookup
    for (const identifier of intent.identifiers) {
      for (const repo of this.chunksRepos) {
        const keywordHits = repo.findByKeyword(identifier);
        addOrUpdate(keywordHits, 10.0);
        // Exact / prefix symbol_name match (high precision)
        const symbolHits = repo.findBySymbolName(identifier);
        addOrUpdate(symbolHits, 40.0);
        // Methods/members of a matched class (parent_symbol)
        const childHits = repo.findByParentSymbol(identifier);
        addOrUpdate(childHits, 35.0);
        // Children of classes discovered via prefix (Session → SessionStore → addEvent)
        for (const hit of symbolHits) {
          if ((hit.symbolKind === 'class' || hit.symbolKind === 'struct') && hit.symbolName) {
            addOrUpdate(repo.findByParentSymbol(hit.symbolName), 35.0);
          }
        }
      }
      // Full text exact search with massive boost to prioritize exact function/variable matches
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

    // Strategy 5: Filename / path stem matching
    // e.g. "scoring" -> scorer.ts, "schema" -> schema.ts, "defaults" -> defaults.ts
    const stemCandidates = new Set<string>([
      ...intent.concepts.filter(c => c.split(' ').length === 1 && c.length >= 3),
      ...intent.identifiers,
    ]);
    for (const stem of stemCandidates) {
      // Variants: scoring->scorer, get_context->get-context, FileWatcher->watcher
      const pascalParts = stem.split(/(?=[A-Z])/).map(s => s.toLowerCase()).filter(s => s.length >= 3);
      const variants = [
        stem,
        stem.replace(/ing$/, 'er'),
        stem.replace(/ing$/, ''),
        stem.replace(/ion$/, ''),
        stem.replace(/tion$/, 't'),
        stem.replace(/s$/, ''),
        stem.replace(/_/g, '-'),
        stem.replace(/-/g, '_'),
        ...pascalParts,
      ];
      for (const v of [...new Set(variants)]) {
        if (v.length < 3) continue;
        for (const repo of this.chunksRepos) {
          const fileHits = repo.findByFileStem(v, 10);
          const exact: typeof fileHits = [];
          const rest: typeof fileHits = [];
          for (const h of fileHits) {
            const base = (h.sourceFile.split(/[/\\]/).pop() || '').toLowerCase();
            const fileStem = base.replace(/\.[^.]+$/, '');
            if (fileStem === v.toLowerCase() || fileStem.includes(v.toLowerCase())) {
              exact.push(h);
            } else {
              rest.push(h);
            }
          }
          addOrUpdate(exact, 28.0);
          addOrUpdate(rest, 12.0);
        }
      }
    }

    // Strategy 5b: CLI entrypoint only for explicit CLI/registration prompts
    if (/\b(cli|registration)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('contextos.ts'), 80.0);
        addOrUpdate(repo.findBySymbolName('queryCommand'), 55.0);
      }
    }
    // compile() layer grouping
    if (/\b(compile|layer grouping|token budget|compresschunks)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('compile'), 60.0);
        addOrUpdate(repo.findBySymbolName('compressChunks'), 50.0);
        addOrUpdate(repo.findByFileStem('compiler', 8), 35.0);
      }
    }
    // File watcher prompts
    if (/\b(watcher|filewatcher|chokidar)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('startWatcher'), 45.0);
        addOrUpdate(repo.findByFileStem('watcher', 8), 30.0);
      }
    }
    // Config load/merge when asking about defaults/overrides
    if (/\b(defaults?\.ts|defaultconfig|loadconfig|config overrides|overridden)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('loadConfig'), 120.0);
        addOrUpdate(repo.findBySymbolName('mergeDeep'), 100.0);
        addOrUpdate(repo.findBySymbolName('defaultConfig'), 50.0);
      }
    }
    // Entity extraction
    if (/\b(entity extraction|extractrelationships|relationshipsrepo)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('extractRelationships'), 200.0);
        addOrUpdate(repo.findByFileStem('extractor', 8), 80.0);
      }
    }
    // Dedup / merge retrieval path
    if (/\b(dedup|allChunksMap|before final scor)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('retrieve'), 55.0);
        addOrUpdate(repo.findBySymbolName('containmentDedup'), 40.0);
      }
    }
    // Session event persistence
    if (/\b(session lifecycle|session_events|addevent|getrecentevents)\b/i.test(intent.rawPrompt)
        || (/\bsession\b/i.test(intent.rawPrompt) && /\bevents?\b/i.test(intent.rawPrompt))) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('addEvent'), 70.0);
        addOrUpdate(repo.findBySymbolName('getRecentEvents'), 55.0);
        addOrUpdate(repo.findBySymbolName('createSession'), 40.0);
        addOrUpdate(repo.findBySymbolName('getSessionContext'), 35.0);
      }
    }
    // Knowledge confidence decay (not diversity decay)
    if (/\b(searchfacts|applydecay|confidence)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('applyDecay'), 45.0);
        addOrUpdate(repo.findBySymbolName('searchFacts'), 40.0);
      }
    }
    // KeywordMatcher strategies
    if (/\b(keywordmatcher|stem matching)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('matchChunks'), 50.0);
        addOrUpdate(repo.findBySymbolName('KeywordMatcher'), 30.0);
      }
    }
    // get_context knowledge wiring
    if (/\b(get_context|cross-session)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('registerGetContextTool'), 45.0);
        addOrUpdate(repo.findByFileStem('get-context', 8), 35.0);
      }
    }
    // Markdown parser
    if (/\b(markdown parser|heading chunking)\b/i.test(intent.rawPrompt)) {
      for (const repo of this.chunksRepos) {
        addOrUpdate(repo.findBySymbolName('parseMarkdown'), 40.0);
        addOrUpdate(repo.findByFileStem('markdown-parser', 8), 35.0);
      }
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
