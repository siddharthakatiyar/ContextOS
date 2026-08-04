import { ChunksRepo } from '../storage/chunks-repo.js';
import { DetectedIntent, ScoredChunk, RetrievalOptions } from './types.js';
import { loadConfig } from '../../config/index.js';
import path from 'path';
import type { Chunk } from '../storage/types.js';

const RRF_K = 60;
/** Max classes whose children are expanded per identifier (Strategy 2). */
const MAX_CLASS_EXPAND_PER_ID = 3;
type CandidateChunk = Chunk & { score?: number };

export interface WeightedList {
  list: ScoredChunk[];
  weight: number;
}

/**
 * Reciprocal Rank Fusion across per-strategy ranked lists.
 * score(d) = Σ (weight_i * 1/(k + rank_i(d)))
 */
export function reciprocalRankFusion(
  weightedLists: WeightedList[],
  k: number = RRF_K
): ScoredChunk[] {
  const fused = new Map<string, ScoredChunk>();

  for (const { list, weight } of weightedLists) {
    if (weight <= 0) continue;
    list.forEach((chunk, rank) => {
      const contrib = weight * (1 / (k + rank + 1));
      const existing = fused.get(chunk.id);
      if (existing) {
        existing.score += contrib;
      } else {
        fused.set(chunk.id, { ...chunk, score: contrib });
      }
    });
  }

  // Scale RRF into ~1–10 range so post-fusion absolute adds don't wash out ranking.
  // Use chunk ID as a stable tiebreaker so equal-score chunks sort consistently.
  return Array.from(fused.values())
    .map((c) => ({ ...c, score: c.score * 100 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function rankByBm25(chunks: CandidateChunk[]): ScoredChunk[] {
  const scored = chunks.map((c, i) => ({
    ...c,
    score: typeof c.score === 'number' ? c.score : chunks.length - i
  })) as ScoredChunk[];
  scored.sort((a, b) => (b.score || 0) - (a.score || 0) || a.id.localeCompare(b.id));
  return scored;
}

function mergeUnique(chunks: CandidateChunk[]): CandidateChunk[] {
  const map = new Map<string, CandidateChunk>();
  for (const c of chunks) {
    if (!map.has(c.id)) {
      map.set(c.id, c);
    } else {
      const existing = map.get(c.id)!;
      const s = (existing.score || 0) + (c.score || 0);
      map.set(c.id, { ...existing, score: s });
    }
  }
  return Array.from(map.values());
}

function pushList(lists: WeightedList[], hits: CandidateChunk[], weight: number = 1): void {
  if (hits.length === 0 || weight <= 0) return;
  const ranked = rankByBm25(mergeUnique(hits));
  lists.push({ list: ranked, weight });
}

function stemVariants(stem: string): string[] {
  const pascalParts = stem
    .split(/(?=[A-Z])/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length >= 3);
  return [
    ...new Set([
      stem,
      stem.replace(/ing$/, 'er'),
      stem.replace(/ing$/, ''),
      stem.replace(/ion$/, ''),
      stem.replace(/tion$/, 't'),
      stem.replace(/s$/, ''),
      stem.replace(/_/g, '-'),
      stem.replace(/-/g, '_'),
      ...pascalParts
    ])
  ].filter((v) => v.length >= 3);
}

/** Expand concept tokens with simple English stems for fuzzy symbol match. */
export function expandMatchTokens(tokens: string[]): string[] {
  const out = new Set<string>();
  for (const raw of tokens) {
    const t = raw.toLowerCase().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
    if (t.length < 3) continue;
    out.add(t);
    out.add(t.replace(/_/g, '-'));
    out.add(t.replace(/-/g, '_'));
    out.add(t.replace(/[_-]/g, '')); // get_context → getcontext for symbol match
    if (t.endsWith('ion') && t.length > 6) out.add(t.slice(0, -3)); // extraction → extract
    if (t.endsWith('ing') && t.length > 5) {
      out.add(t.slice(0, -3));
      out.add(t.slice(0, -3) + 'er');
    }
    if (t.endsWith('ed') && t.length > 5) out.add(t.slice(0, -2));
    if (t.endsWith('ies') && t.length > 5) out.add(t.slice(0, -3) + 'y');
    if (t.endsWith('es') && t.length > 5) out.add(t.slice(0, -2));
    if (t.endsWith('s') && t.length > 4) out.add(t.slice(0, -1));
    // Split camelCase / PascalCase / snake into segments
    for (const part of t.split(/[_-]+|(?=[A-Z])/)) {
      const p = part.toLowerCase();
      if (p.length >= 4) out.add(p);
    }
  }
  return [...out];
}

export class KeywordMatcher {
  private chunksRepos: ChunksRepo[];

  constructor(chunksRepo: ChunksRepo | ChunksRepo[]) {
    this.chunksRepos = Array.isArray(chunksRepo) ? chunksRepo : [chunksRepo];
  }

  private runFTS(query: string, opts?: RetrievalOptions, ftsLimit?: number): ScoredChunk[] {
    const hits: ScoredChunk[] = [];
    for (const repo of this.chunksRepos) {
      if (opts?.layers && opts.layers.length > 0) {
        hits.push(...repo.searchFTS(query, { layers: opts.layers, limit: ftsLimit }));
      } else {
        hits.push(...repo.searchFTS(query, { limit: ftsLimit }));
      }
    }
    return rankByBm25(mergeUnique(hits));
  }

  /** Strategy 0: Exact match for quoted terms */
  private strategyQuoted(
    intent: DetectedIntent,
    opts?: RetrievalOptions,
    ftsLimit?: number
  ): CandidateChunk[] {
    const hits: CandidateChunk[] = [];
    for (const term of intent.quotedTerms) {
      hits.push(...this.runFTS(`"${term.replace(/"/g, '""')}"`, opts, ftsLimit));
    }
    return hits;
  }

  /** Strategy 1: FTS5 OR (recall) + AND (precision) — double-weighted for content markers */
  private strategyFts(
    intent: DetectedIntent,
    opts?: RetrievalOptions,
    ftsLimit?: number
  ): WeightedList[] {
    const lists: WeightedList[] = [];
    const searchTerms = intent.concepts.slice(0, 15);
    if (searchTerms.length === 0) return lists;

    const ftsQueryOr = searchTerms.map((c) => `"${c.replace(/"/g, '""')}"`).join(' OR ');
    const orHits = this.runFTS(ftsQueryOr, opts, ftsLimit);
    pushList(lists, orHits, 2);

    if (searchTerms.length >= 2 && searchTerms.length <= 6) {
      const ftsQueryAnd = searchTerms.map((c) => `"${c.replace(/"/g, '""')}"`).join(' AND ');
      const andHits = this.runFTS(ftsQueryAnd, opts, ftsLimit);
      pushList(lists, andHits, 2);
    }

    // Per-term FTS for longer concepts — surfaces content-only anchors (allChunksMap, etc.)
    for (const term of searchTerms) {
      if (term.length < 6 || term.includes(' ')) continue;
      if (
        /^(function|method|string|number|object|return|const|import|export|class|boolean|array)$/i.test(
          term
        )
      )
        continue;
      const limit = Math.min(ftsLimit || 30, 8);
      const hits = this.runFTS(`"${term.replace(/"/g, '""')}"`, opts, limit);
      pushList(lists, hits, 0.4); // Reduced weight so generic unigrams don't wash out multi-term exact matches
    }
    return lists;
  }

  /** Strategy 2: identifiers → keyword / symbol / parent children */
  private strategyIdentifiers(
    intent: DetectedIntent,
    opts?: RetrievalOptions,
    ftsLimit?: number
  ): WeightedList[] {
    const lists: WeightedList[] = [];
    if (intent.identifiers.length === 0) return lists;
    const layerOpts = opts?.layers && opts.layers.length > 0 ? { layers: opts.layers } : undefined;
    const idHits: CandidateChunk[] = [];
    const exactSymbolHits: CandidateChunk[] = [];

    for (const identifier of intent.identifiers) {
      for (const repo of this.chunksRepos) {
        idHits.push(...repo.findByKeyword(identifier, layerOpts));
        const symbolHits = repo.findBySymbolName(identifier, layerOpts);
        exactSymbolHits.push(...symbolHits.map((h) => ({ ...h, score: 20 })));
        idHits.push(...repo.findByParentSymbol(identifier, layerOpts));

        let expanded = 0;
        // Prefer longer/more specific class names (SessionStore before Session)
        const classHits = symbolHits
          .filter((h) => (h.symbolKind === 'class' || h.symbolKind === 'struct') && h.symbolName)
          .sort((a, b) => b.symbolName!.length - a.symbolName!.length);
        for (const hit of classHits) {
          if (expanded >= MAX_CLASS_EXPAND_PER_ID) break;
          exactSymbolHits.push(
            ...repo.findByParentSymbol(hit.symbolName!, layerOpts).map((h) => ({ ...h, score: 15 }))
          );
          expanded++;
        }
      }
      idHits.push(...this.runFTS(`"${identifier.replace(/"/g, '""')}"`, opts, ftsLimit));
      // Call-site discovery: FTS for the identifier also finds registration/wiring files
      exactSymbolHits.push(
        ...this.runFTS(`"${identifier.replace(/"/g, '""')}"`, opts, ftsLimit).map((h) => ({
          ...h,
          score: h.symbolKind === 'file' ? 45 : 18
        }))
      );

      // Sibling symbols from the same file as exact hits (loadConfig → mergeDeep)
      for (const repo of this.chunksRepos) {
        const exact = repo.findBySymbolName(identifier, layerOpts);
        for (const hit of exact) {
          if (!hit.fileStem || hit.fileStem.length < 3) continue;
          const siblings = repo.findByFileStem(hit.fileStem, 8, layerOpts);
          exactSymbolHits.push(
            ...siblings
              .filter((s) => s.sourceFile === hit.sourceFile && s.id !== hit.id)
              .map((s) => ({ ...s, score: 14 }))
          );
        }
      }
    }

    pushList(lists, exactSymbolHits, 2);
    pushList(lists, idHits, 1);
    return lists;
  }

  /** Strategy 3: Section title exact match (unigrams only) */
  private strategyTitleMatch(intent: DetectedIntent, opts?: RetrievalOptions): CandidateChunk[] {
    const layerOpts = opts?.layers && opts.layers.length > 0 ? { layers: opts.layers } : undefined;
    const unigrams = intent.concepts.filter((c) => c.split(' ').length === 1);
    const titleHits: CandidateChunk[] = [];
    for (const concept of unigrams) {
      // Penalize/skip extremely generic words that drown out structural intent
      if (/^(file|structure|data|type|name|code|system|component)$/i.test(concept)) continue;
      for (const repo of this.chunksRepos) {
        titleHits.push(...repo.findByTitleMatch(concept, layerOpts).slice(0, 5));
      }
    }
    return titleHits;
  }

  /**
   * Strategy 4: Intent-aware boosting
   * Routes error/fix/implement/pr queries via semantic FTS expansions.
   */
  private strategyIntentAware(
    intent: DetectedIntent,
    opts?: RetrievalOptions,
    ftsLimit?: number
  ): CandidateChunk[] {
    const limit = Math.min(ftsLimit || 30, 8); // strict limit for generic intent words
    if (intent.intentType === 'fix') {
      return this.runFTS('"error" OR "bug" OR "exception" OR "fix"', opts, limit);
    } else if (intent.intentType === 'implement') {
      return this.runFTS('"api" OR "interface" OR "spec" OR "implement"', opts, limit);
    } else if (intent.intentType === 'pr') {
      return this.runFTS('"pr" OR "pull request" OR "rules" OR "guidelines"', opts, limit);
    }
    return [];
  }

  /**
   * Strategy 5: Filename / path stem matching
   * e.g. scoring → scorer.ts via findByFileStem variants.
   */
  private strategyFileStem(intent: DetectedIntent, opts?: RetrievalOptions): WeightedList[] {
    const lists: WeightedList[] = [];
    const layerOpts = opts?.layers && opts.layers.length > 0 ? { layers: opts.layers } : undefined;
    const stemCandidates = new Set<string>([
      ...intent.concepts.filter((c) => c.split(' ').length === 1 && c.length >= 3),
      ...intent.identifiers
    ]);
    const stemHits: CandidateChunk[] = [];
    const exactStemHits: CandidateChunk[] = [];
    const idLower = new Set(intent.identifiers.map((i) => i.toLowerCase()));

    for (const stem of stemCandidates) {
      for (const v of stemVariants(stem)) {
        // Short generic stems (chunk, file, path) are noisy unless from an identifier
        const weak = v.length < 5 && ![...idLower].some((i) => i.includes(v.toLowerCase()));
        for (const repo of this.chunksRepos) {
          const fileHits = repo.findByFileStem(v, weak ? 8 : 20, layerOpts);
          for (const h of fileHits) {
            const base = (h.sourceFile.split(/[/\\]/).pop() || '').toLowerCase();
            const fileStem = (h.fileStem || base.replace(/\.[^.]+$/, '')).toLowerCase();
            const vl = v.toLowerCase();
            if (fileStem === vl || fileStem.replace(/-/g, '') === vl.replace(/-/g, '')) {
              exactStemHits.push({ ...h, score: weak ? 8 : 30 + Math.min(v.length, 12) });
            } else if (fileStem.startsWith(vl) || fileStem.includes(vl)) {
              stemHits.push({ ...h, score: weak ? 2 : 10 + Math.min(v.length, 8) });
            } else if (!weak) {
              stemHits.push({ ...h, score: 3 });
            }
          }
        }
      }
    }

    pushList(lists, exactStemHits, 2);
    pushList(lists, stemHits, 1);

    // From stem hits, also pull sibling symbols in the same source file (loadConfig → mergeDeep)
    const siblingHits: CandidateChunk[] = [];
    const seenFiles = new Set<string>();
    for (const h of [...exactStemHits, ...stemHits]) {
      if (!h.sourceFile || seenFiles.has(h.sourceFile)) continue;
      seenFiles.add(h.sourceFile);
      for (const repo of this.chunksRepos) {
        const stem = h.fileStem || path.basename(h.sourceFile).replace(/\.[^.]+$/, '');
        if (!stem || stem.length < 3) continue;
        siblingHits.push(
          ...repo
            .findByFileStem(stem, 8, layerOpts)
            .filter((s) => s.sourceFile === h.sourceFile)
            .map((s) => ({ ...s, score: 12 }))
        );
      }
    }
    pushList(lists, siblingHits, 1);
    return lists;
  }

  /** Strategy 6: concept → symbol_name (prefix + fuzzy); expands class children */
  private strategyConceptSymbols(intent: DetectedIntent, opts?: RetrievalOptions): WeightedList[] {
    const lists: WeightedList[] = [];
    const layerOpts = opts?.layers && opts.layers.length > 0 ? { layers: opts.layers } : undefined;
    const symbolHits: CandidateChunk[] = [];
    const exactHits: CandidateChunk[] = [];
    const tokens = expandMatchTokens([
      ...intent.identifiers,
      ...intent.concepts.filter((c) => !c.includes(' '))
    ]);

    for (const token of tokens) {
      if (token.length < 4) continue;
      // Avoid suffix-only fuzzy noise (command → watchCommand/statusCommand/…)
      const weakFuzzy =
        token.length < 7 ||
        /^(command|config|store|event|index|file|test|data|type|name)$/i.test(token);
      for (const repo of this.chunksRepos) {
        const exact = repo.findBySymbolName(token, layerOpts);
        exactHits.push(...exact.map((h) => ({ ...h, score: 20 })));
        if (!weakFuzzy) {
          const fuzzy = repo.findBySymbolFuzzy(token, layerOpts);
          symbolHits.push(...fuzzy.map((h) => ({ ...h, score: 8 })));
        }
        let expanded = 0;
        const classHits = exact
          .filter((h) => (h.symbolKind === 'class' || h.symbolKind === 'struct') && h.symbolName)
          .sort((a, b) => b.symbolName!.length - a.symbolName!.length);
        for (const hit of classHits) {
          if (expanded >= MAX_CLASS_EXPAND_PER_ID) break;
          exactHits.push(
            ...repo.findByParentSymbol(hit.symbolName!, layerOpts).map((h) => ({ ...h, score: 16 }))
          );
          expanded++;
        }
      }
    }

    pushList(lists, exactHits, 2);
    pushList(lists, symbolHits, 1);
    return lists;
  }

  public matchChunks(intent: DetectedIntent, opts?: RetrievalOptions): ScoredChunk[] {
    const ftsLimit = opts?.limit ?? loadConfig().ftsLimit;
    const strategyLists: WeightedList[] = [];

    // Strategy 0: Exact match for quoted terms
    pushList(strategyLists, this.strategyQuoted(intent, opts, ftsLimit));

    // Strategy 1: FTS5 OR (recall) + AND (precision) — double-weighted for content markers
    strategyLists.push(...this.strategyFts(intent, opts, ftsLimit));

    // Strategy 2: Identifiers
    strategyLists.push(...this.strategyIdentifiers(intent, opts, ftsLimit));

    // Strategy 3: Section title exact match (unigrams only)
    pushList(strategyLists, this.strategyTitleMatch(intent, opts), 0.5); // reduced weight

    // Strategy 4: Intent-aware boosting (intentType === 'fix' | implement | pr)
    pushList(strategyLists, this.strategyIntentAware(intent, opts, ftsLimit), 1);

    // Strategy 5: Filename / path stem matching via findByFileStem
    strategyLists.push(...this.strategyFileStem(intent, opts));
    strategyLists.push(...this.strategyConceptSymbols(intent, opts));

    if (strategyLists.length === 0) return [];
    return reciprocalRankFusion(strategyLists);
  }

  public matchForEntities(entities: string[]): ScoredChunk[] {
    // Low absolute scores — RRF direct matches are scaled ~1–10; don't wash them out
    const results: Map<string, ScoredChunk> = new Map();
    for (const entity of entities) {
      for (const repo of this.chunksRepos) {
        const hits = repo.findByKeyword(entity);
        for (const h of hits) {
          if (!results.has(h.id)) {
            results.set(h.id, { ...h, score: 0.5 });
          } else {
            results.get(h.id)!.score += 0.15;
          }
        }
      }
    }
    return Array.from(results.values());
  }
}
