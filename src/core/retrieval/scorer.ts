import { ScoredChunk, ScoreChunksOptions } from './types.js';
import { ExpandedEntity } from '../graph/expander.js';

import { loadConfig } from '../../config/index.js';
import path from 'path';

const PRIMARY_EXPORT_RE =
  /^(extract|parse|compile|expand|start|init|register|create|add|search|match|load|merge|detect|apply|stem)/i;

export interface ScoreAdjustContext {
  repoRoot: string;
  matchTokens: string[];
  identifiers: Set<string>;
}

/** Hard penalty for poison paths — returns -9999 when path is excluded. */
export function applyPoisonPenalty(chunk: ScoredChunk, finalScore: number): number {
  const lowerPath = chunk.sourceFile.toLowerCase();
  // 1. Hard penalty for poison paths
  if (
    lowerPath.includes('/node_modules/') ||
    lowerPath.includes('/.git/') ||
    lowerPath.includes('changelog') ||
    lowerPath.includes('changes.md') ||
    lowerPath.includes('history.md') ||
    lowerPath.endsWith('.map') ||
    lowerPath.endsWith('.lock') ||
    lowerPath.endsWith('.min.js') ||
    lowerPath.endsWith('.min.css')
  ) {
    finalScore = -9999;
  }
  return finalScore;
}

/** Prefer repo-local source files over foreign workspace pollution. */
export function applyWorkspacePenalty(
  chunk: ScoredChunk,
  finalScore: number,
  ctx: ScoreAdjustContext
): number {
  if (chunk.layer === 'workspace' && chunk.workspaceName) {
    const ws = chunk.workspaceName;
    const isLocal =
      ws === ctx.repoRoot ||
      ctx.repoRoot.startsWith(ws + path.sep) ||
      ws.startsWith(ctx.repoRoot + path.sep) ||
      path.basename(ctx.repoRoot) === path.basename(ws);
    if (!isLocal) {
      finalScore *= 0.3;
    }
  }
  return finalScore;
}

/** Demote tests / README noise and File Structure stubs relative to implementation. */
export function applyNoiseDemotion(chunk: ScoredChunk, finalScore: number): number {
  // Prefer primary symbol bodies over File Structure stubs
  if (chunk.sectionTitle === 'File Structure') {
    finalScore *= 0.45;
  }

  // Demote tests / README noise relative to implementation
  if (/\.(test|spec)\./i.test(chunk.sourceFile) || /\/tests?\//i.test(chunk.sourceFile)) {
    finalScore *= 0.55;
  }
  if (/readme\.md$/i.test(chunk.sourceFile)) {
    finalScore *= 0.4;
  }
  return finalScore;
}

/** Intent-aware boosts/demotions for config, dedup, watcher, and CLI prompts. */
export function applyGenericAdjustments(
  chunk: ScoredChunk,
  finalScore: number,
  ctx: ScoreAdjustContext
): number {
  const fileStemLower = (
    chunk.fileStem || path.basename(chunk.sourceFile).replace(/\.[^.]+$/, '')
  ).toLowerCase();
  const { matchTokens, identifiers } = ctx;

  // When prompt identifier or token matches file stem (get_context → get-context.ts), prefer that file's bodies.
  // This explicitly boosts all chunks (including helpers) from a file named in the prompt.
  const allTokens = [...identifiers, ...matchTokens];
  if (allTokens.length > 0) {
    const fsCompact = fileStemLower.replace(/[_-]/g, '');
    let fileNamedInPrompt = false;
    for (const t of allTokens) {
      const tc = t.replace(/[_-]/g, '').toLowerCase();
      if (tc === 'contextos' || tc === 'contexto') continue;
      const isId = identifiers.has(t);
      const minLen = isId ? 5 : 8; // Require longer matches for generic concepts to avoid 'server' or 'daemon' dominating

      // Ensure it's a substantive match (e.g., intentdetector)
      if (
        tc.length >= minLen &&
        (fsCompact === tc || (fsCompact.includes(tc) && tc.length >= minLen + 2))
      ) {
        fileNamedInPrompt = true;
        break;
      }
    }
    if (fileNamedInPrompt) {
      finalScore *= 2.5; // Aggressive boost so local helpers rank above unrelated high-score chunks
    }
  }

  // Constructors rarely answer architectural questions
  if (chunk.symbolName === 'constructor') {
    finalScore *= 0.35;
  }

  // Trivial getters: name match /^get[A-Z]/ && tiny body
  if (chunk.symbolName && /^get[A-Z]/.test(chunk.symbolName) && (chunk.tokenCount || 0) < 40) {
    finalScore *= 0.5;
  }

  // Primary-export style boost ONLY when symbol also overlaps a prompt token
  if (chunk.symbolName && PRIMARY_EXPORT_RE.test(chunk.symbolName)) {
    const sn = chunk.symbolName.toLowerCase();
    const overlaps =
      [...identifiers].some(
        (t) => sn === t || sn.startsWith(t) || t.startsWith(sn) || (t.length >= 5 && sn.includes(t))
      ) ||
      matchTokens.some((t) => t.length >= 5 && (sn === t || sn.startsWith(t) || sn.includes(t)));
    if (overlaps) {
      finalScore *= 1.3;
    }
  }

  // Definition / Type boost
  // if (chunk.symbolKind && /^(class|interface|type_alias|struct|enum|type_declaration)$/.test(chunk.symbolKind)) {
  //   const sn = (chunk.symbolName || '').toLowerCase();
  //   const overlaps = [...identifiers, ...matchTokens].some(
  //     t => t.length >= 4 && (sn === t || sn.startsWith(t) || t.startsWith(sn) || sn.includes(t))
  //   );
  //   if (overlaps) {
  //     finalScore *= 2.0;
  //   }
  // }

  return finalScore;
}

export function scoreChunks(
  chunks: ScoredChunk[],
  expandedEntities: ExpandedEntity[],
  feedbackAdjustments: Record<string, number> = {},
  opts?: ScoreChunksOptions
): ScoredChunk[] {
  const config = loadConfig();
  const layerBoosts = config.layerBoosts || {
    session: 1.5,
    repo: 1.3,
    workspace: 1.1,
    global: 1.0
  };
  const maxGraphBoost = config.maxGraphBoost || 10;
  const diversityDecay = config.diversityDecay || 0.7;
  const diversityPenaltyStart = config.diversityPenaltyStart || 3;
  const applyDiversity = opts?.diversityFilter !== false;
  const repoRoot = opts?.repoRoot || process.cwd();
  const matchTokens = (opts?.matchTokens || [])
    .map((t) => t.toLowerCase().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ''))
    .filter((t) => t.length >= 4);
  const identifiers = new Set(
    (opts?.identifiers || [])
      .map((t) => t.toLowerCase().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ''))
      .filter((t) => t.length >= 3)
  );
  const adjustCtx: ScoreAdjustContext = { repoRoot, matchTokens, identifiers };

  const entityScores = new Map<string, number>();
  for (const e of expandedEntities) {
    entityScores.set(e.entity, e.score);
  }

  const now = Date.now();

  const scored = chunks
    .map((chunk) => {
      let finalScore = chunk.score || 0;

      finalScore = applyPoisonPenalty(chunk, finalScore);

      // Graph expansion boost (capped absolute)
      if (chunk.keywords) {
        const chunkKeywords = chunk.keywords.split(', ').map((k) => k.trim());
        let graphBoost = 0;
        for (const k of chunkKeywords) {
          if (entityScores.has(k)) {
            graphBoost += entityScores.get(k)! * 5.0;
          }
        }
        finalScore += Math.min(graphBoost, maxGraphBoost);
      }

      // Importance weight (small absolute)
      finalScore += (Math.min(chunk.importance || 0, 10) / 10) * 2.0;

      // Feedback adjustment
      if (chunk.id && feedbackAdjustments[chunk.id] !== undefined) {
        finalScore += feedbackAdjustments[chunk.id];
      }

      // Generic prompt-token → symbolName / fileStem / path-segment boost
      if (matchTokens.length > 0 || identifiers.size > 0) {
        let best = 1;
        const sn = (chunk.symbolName || '').toLowerCase();
        const fs = (
          chunk.fileStem || path.basename(chunk.sourceFile).replace(/\.[^.]+$/, '')
        ).toLowerCase();
        const parent = (chunk.parentSymbol || '').toLowerCase();
        const pathParts = chunk.sourceFile.toLowerCase().split(/[/\\]/);

        // Identifiers get stronger exact/prefix boosts than plain concepts
        for (const t of identifiers) {
          if (t === 'contextos' || t === 'contexto') continue; // Prevent project name from dominating file stem matches
          const snLower = sn;
          const tLower = t;
          if (sn && sn === t) {
            // Compact class/struct outlines matching the name are weaker than method bodies
            const compactOutline =
              (chunk.symbolKind === 'class' || chunk.symbolKind === 'struct') &&
              (chunk.tokenCount || 0) < 80;
            best = Math.max(best, compactOutline ? 2.5 : 3.5);
          } else if (
            snLower &&
            tLower &&
            (snLower.startsWith(tLower) || tLower.startsWith(snLower))
          ) {
            best = Math.max(best, 3.0);
          } else if (
            snLower &&
            tLower.length >= 5 &&
            (snLower.includes(tLower) || tLower.includes(snLower))
          ) {
            best = Math.max(best, 2.2);
          }
          if (parent && (parent === t || parent.startsWith(t) || t.startsWith(parent))) {
            best = Math.max(best, 2.8);
          }
          // Identifier → file stem (get_context → get-context.ts)
          const fsCompact = fs.replace(/[_-]/g, '');
          const tCompact = t.replace(/[_-]/g, '');
          if (
            fsCompact &&
            tCompact.length >= 5 &&
            (fsCompact === tCompact || fsCompact.includes(tCompact))
          ) {
            best = Math.max(best, 3.5);
          }
        }

        for (const t of matchTokens) {
          if (t === 'contextos' || t === 'contexto') continue;
          // Skip short generic concepts that over-boost merge*/add*/get* noise
          // but still allow short tokens for endsWith / compact matches below
          const shortGeneric = t.length < 6 && !identifiers.has(t);

          if (!shortGeneric) {
            if (sn && sn === t) {
              best = Math.max(best, 3.2);
            } else if (sn && (sn.startsWith(t) || t.startsWith(sn))) {
              best = Math.max(best, 2.4);
            } else if (sn && t.length >= 5 && (sn.includes(t) || t.includes(sn))) {
              best = Math.max(best, 1.6);
            }
          }

          if (sn && t.length >= 4 && sn.endsWith(t)) {
            // applyDecay for "decay", searchFacts for "facts"
            best = Math.max(best, 3.5);
          }

          // Hyphen/underscore-insensitive contains (get_context → registerGetContextTool)
          const snCompact = sn.replace(/[_-]/g, '');
          const tCompact = t.replace(/[_-]/g, '');
          const weakContains =
            /^(source|file|path|name|type|data|index|test|config|value|event|context|layer|token|budget)$/i.test(
              t
            );
          if (snCompact && tCompact.length >= 6 && snCompact.includes(tCompact) && !weakContains) {
            best = Math.max(best, 3.2);
          }

          if (shortGeneric) continue;

          if (fs === t || fs.replace(/-/g, '') === t.replace(/-/g, '')) {
            best = Math.max(best, 3.2);
          } else if (fs.startsWith(t) || t.startsWith(fs) || (t.length >= 4 && fs.includes(t))) {
            best = Math.max(best, 2.2);
          }

          // Directory segment match (watcher/index.ts for token "watcher")
          if (pathParts.some((p) => p === t || p.replace(/\.[^.]+$/, '') === t)) {
            best = Math.max(best, 3.0);
          }

          if (parent && (parent === t || parent.startsWith(t) || t.startsWith(parent))) {
            best = Math.max(best, 2.2);
          }
        }
        finalScore *= best;
      }

      // Layer boost (Multiplicative) — post-fusion
      finalScore *= layerBoosts[chunk.layer as keyof typeof layerBoosts] || 1.0;

      // Recency: prefer newer updated_at (mild, post-fusion)
      if (chunk.updatedAt) {
        const ageDays = Math.max(0, (now - chunk.updatedAt) / 86_400_000);
        finalScore *= 1 + 0.12 * Math.exp(-ageDays / 45);
      }

      finalScore = applyWorkspacePenalty(chunk, finalScore, adjustCtx);
      finalScore = applyNoiseDemotion(chunk, finalScore);

      // Prefer large schema/DDL variable symbols (template-literal consts)
      if (chunk.symbolKind === 'variable' && (chunk.tokenCount || 0) > 200) {
        finalScore *= 1.8;
      }

      // Prefer method / segment bodies over compact class outlines when both appear
      if (
        chunk.parentSymbol &&
        (chunk.symbolKind === 'function' || chunk.symbolKind === 'method')
      ) {
        finalScore *= 1.2;
      }
      // Segments are intact slices — mild preference, but do not outrank real symbols
      if (chunk.symbolKind === 'segment' && chunk.parentSymbol) {
        finalScore *= 1.05;
      }

      const snLower = (chunk.symbolName || '').toLowerCase();
      const isExactIdHit = snLower && identifiers.has(snLower);
      if (
        (chunk.symbolKind === 'class' || chunk.symbolKind === 'struct') &&
        (chunk.tokenCount || 0) < 80 &&
        !isExactIdHit
      ) {
        finalScore *= 0.55;
      }

      // Soft demotion for very large chunks so siblings can share the token budget
      // Do not demote exact identifier hits — they are often the answer body.
      if ((chunk.tokenCount || 0) > 1800 && !isExactIdHit) {
        finalScore *= 0.5;
      } else if ((chunk.tokenCount || 0) > 1100 && !isExactIdHit) {
        finalScore *= 0.75;
      }

      finalScore = applyGenericAdjustments(chunk, finalScore, adjustCtx);

      return { ...chunk, score: finalScore };
    })
    .filter((chunk) => chunk.score > -9000);

  // Sort by score descending; use chunk ID as a stable tiebreaker so ordering
  // is deterministic across runs even when float scores are equal.
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Apply progressive diversity filter
  // Same-class methods are complementary (not redundant) — allow more before demoting.
  // Exact identifier symbol hits are never diversity-demoted (must survive into top-N).
  const fileCounts = new Map<string, number>();
  const diverse: ScoredChunk[] = [];

  if (applyDiversity) {
    for (const chunk of scored) {
      const count = fileCounts.get(chunk.sourceFile) || 0;
      const sn = (chunk.symbolName || '').toLowerCase();
      const isExactId = sn && identifiers.has(sn);
      const threshold = chunk.parentSymbol
        ? Math.max(diversityPenaltyStart + 4, 8)
        : chunk.symbolKind === 'class' || chunk.symbolKind === 'struct'
          ? diversityPenaltyStart + 2
          : diversityPenaltyStart;
      if (!isExactId && count >= threshold) {
        chunk.score *= Math.pow(diversityDecay, count - threshold + 1);
      }
      fileCounts.set(chunk.sourceFile, count + 1);
      diverse.push(chunk);
    }

    // Re-sort after demotions; stable tiebreaker keeps order deterministic.
    diverse.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  } else {
    diverse.push(...scored);
  }

  return diverse;
}
