import { ScoredChunk, ScoreChunksOptions } from './types.js';
import { ExpandedEntity } from '../graph/expander.js';

import { loadConfig } from '../../config/index.js';
import path from 'path';

const PRIMARY_EXPORT_RE =
  /^(extract|parse|compile|expand|start|init|register|create|add|search|match|load|merge)/i;

export function scoreChunks(
  chunks: ScoredChunk[],
  expandedEntities: ExpandedEntity[],
  feedbackAdjustments: Record<string, number> = {},
  opts?: ScoreChunksOptions,
): ScoredChunk[] {
  const config = loadConfig();
  const layerBoosts = config.layerBoosts || { session: 1.5, repo: 1.3, workspace: 1.1, global: 1.0 };
  const maxGraphBoost = config.maxGraphBoost || 10;
  const diversityDecay = config.diversityDecay || 0.7;
  const diversityPenaltyStart = config.diversityPenaltyStart || 3;
  const repoRoot = opts?.repoRoot || process.cwd();
  const matchTokens = (opts?.matchTokens || [])
    .map(t => t.toLowerCase().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ''))
    .filter(t => t.length >= 4);
  const identifiers = new Set(
    (opts?.identifiers || [])
      .map(t => t.toLowerCase().replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, ''))
      .filter(t => t.length >= 3)
  );

  const entityScores = new Map<string, number>();
  for (const e of expandedEntities) {
    entityScores.set(e.entity, e.score);
  }

  const now = Date.now();

  const scored = chunks.map(chunk => {
    let finalScore = chunk.score || 0;

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

    // Graph expansion boost (capped absolute)
    if (chunk.keywords) {
      const chunkKeywords = chunk.keywords.split(', ').map(k => k.trim());
      let graphBoost = 0;
      for (const k of chunkKeywords) {
        if (entityScores.has(k)) {
          graphBoost += (entityScores.get(k)! * 5.0);
        }
      }
      finalScore += Math.min(graphBoost, maxGraphBoost);
    }

    // Importance weight (small absolute)
    finalScore += Math.min((chunk.importance || 0), 10) / 10 * 2.0;

    // Feedback adjustment
    if (chunk.id && feedbackAdjustments[chunk.id] !== undefined) {
      finalScore += feedbackAdjustments[chunk.id];
    }

    // Generic prompt-token → symbolName / fileStem / path-segment boost
    if (matchTokens.length > 0 || identifiers.size > 0) {
      let best = 1;
      const sn = (chunk.symbolName || '').toLowerCase();
      const fs = (chunk.fileStem || path.basename(chunk.sourceFile).replace(/\.[^.]+$/, '')).toLowerCase();
      const parent = (chunk.parentSymbol || '').toLowerCase();
      const pathParts = chunk.sourceFile.toLowerCase().split(/[/\\]/);

      // Identifiers get stronger exact/prefix boosts than plain concepts
      for (const t of identifiers) {
        if (sn && sn === t) best = Math.max(best, 4.0);
        else if (sn && (sn.startsWith(t) || t.startsWith(sn))) best = Math.max(best, 3.0);
        else if (sn && t.length >= 5 && sn.includes(t)) best = Math.max(best, 2.2);
        if (parent && (parent === t || parent.startsWith(t) || t.startsWith(parent))) {
          best = Math.max(best, 2.8);
        }
      }

      for (const t of matchTokens) {
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
        const weakContains = /^(source|file|path|name|type|data|index|test|config|value|event|context|layer|token|budget)$/i.test(t);
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
        if (pathParts.some(p => p === t || p.replace(/\.[^.]+$/, '') === t)) {
          best = Math.max(best, 3.0);
        }

        if (parent && (parent === t || parent.startsWith(t) || t.startsWith(parent))) {
          best = Math.max(best, 2.2);
        }
      }
      finalScore *= best;
    }

    // Layer boost (Multiplicative) — post-fusion
    finalScore *= (layerBoosts[chunk.layer as keyof typeof layerBoosts] || 1.0);

    // Recency: prefer newer updated_at (mild, post-fusion)
    if (chunk.updatedAt) {
      const ageDays = Math.max(0, (now - chunk.updatedAt) / 86_400_000);
      finalScore *= 1 + 0.12 * Math.exp(-ageDays / 45);
    }

    // Prefer repo-local source files over foreign workspace pollution
    if (chunk.layer === 'workspace' && chunk.workspaceName) {
      const ws = chunk.workspaceName;
      const isLocal =
        ws === repoRoot ||
        repoRoot.startsWith(ws + path.sep) ||
        ws.startsWith(repoRoot + path.sep) ||
        path.basename(repoRoot) === path.basename(ws);
      if (!isLocal) {
        finalScore *= 0.3;
      }
    }

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

    // Prefer large schema/DDL variable symbols (template-literal consts)
    if (chunk.symbolKind === 'variable' && (chunk.tokenCount || 0) > 200) {
      finalScore *= 1.8;
    }

    // Prefer method bodies over compact class outlines when both appear
    if (chunk.parentSymbol && (chunk.symbolKind === 'function' || chunk.symbolKind === 'method')) {
      finalScore *= 1.2;
    }

    const snLower = (chunk.symbolName || '').toLowerCase();
    const fileStemLower = (
      chunk.fileStem || path.basename(chunk.sourceFile).replace(/\.[^.]+$/, '')
    ).toLowerCase();
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

    // Config load/merge helpers when prompt asks about defaults/overrides
    if (
      snLower &&
      /^(load|merge)/i.test(snLower) &&
      matchTokens.some(t => /^(config|default|override)/.test(t) || t.includes('config') || t.includes('override') || t.includes('default'))
    ) {
      finalScore *= 2.8;
    }

    // Dedup/merge retrieval path: prefer retrieve() when prompt talks about dedup
    const wantsDedup = [...matchTokens, ...identifiers].some(
      t => t.includes('dedup') || t.includes('deduplicat')
    );
    if (wantsDedup && snLower === 'retrieve') {
      finalScore *= 5.0;
    }
    if (wantsDedup && snLower === 'containmentdedup') {
      finalScore *= 1.5;
    }
    if (wantsDedup && snLower === 'scorechunks') {
      finalScore *= 0.35;
    }

    // Boost file-level entrypoint chunks (bin/*) only for CLI/registration prompts
    const wantsCli = matchTokens.some(t => /^(cli|registration)$/i.test(t))
      || [...identifiers].some(id => /^(cli|registration)/i.test(id) || /registration/i.test(id));
    if (
      wantsCli &&
      chunk.symbolKind === 'file' &&
      /(?:^|[/\\])bin[/\\]/i.test(chunk.sourceFile)
    ) {
      finalScore *= 8.0;
    }
    if (wantsCli && chunk.symbolName && /Command$/i.test(chunk.symbolName)) {
      const exact = [...identifiers].some(
        id => id.toLowerCase() === chunk.symbolName!.toLowerCase()
      );
      finalScore *= exact ? 0.75 : 0.3;
    }
    if (wantsCli && snLower.startsWith('register')) {
      finalScore *= 0.25;
    }

    // Prefer get-context tool module when prompt names get_context
    const wantsGetContext = [...matchTokens, ...identifiers].some(
      t => t.replace(/[_-]/g, '') === 'getcontext'
    );
    if (wantsGetContext) {
      if (fileStemLower.replace(/-/g, '') === 'getcontext' || snLower.includes('getcontext')) {
        finalScore *= 3.5;
      }
      if (snLower === 'registerknowledgetools') {
        finalScore *= 0.4;
      }
      if (snLower === 'mergememorypipeline') {
        finalScore *= 1.6;
      }
      if (snLower === 'registergetcontexttool') {
        finalScore *= 1.15;
        if ((chunk.tokenCount || 0) > 900) finalScore *= 0.75;
      }
    }

    // When prompt names a specific *Command, demote other *Command siblings
    if (chunk.symbolName && /Command$/i.test(chunk.symbolName)) {
      const exactCommand = [...identifiers].some(
        id => id.toLowerCase() === chunk.symbolName!.toLowerCase()
      );
      if (!exactCommand && [...identifiers].some(id => /command$/i.test(id))) {
        finalScore *= 0.35;
      }
    }

    // Constructors rarely answer architectural questions
    if (chunk.symbolName === 'constructor') {
      finalScore *= 0.35;
    }

    // Trivial getters: name match /^get[A-Z]/ && tiny body
    if (
      chunk.symbolName &&
      /^get[A-Z]/.test(chunk.symbolName) &&
      (chunk.tokenCount || 0) < 40
    ) {
      finalScore *= 0.5;
    }

    // Primary-export style boost ONLY when symbol also overlaps a prompt token
    if (chunk.symbolName && PRIMARY_EXPORT_RE.test(chunk.symbolName)) {
      const sn = chunk.symbolName.toLowerCase();
      const overlaps =
        [...identifiers].some(
          t => sn === t || sn.startsWith(t) || t.startsWith(sn) || (t.length >= 5 && sn.includes(t))
        ) ||
        matchTokens.some(
          t => t.length >= 5 && (sn === t || sn.startsWith(t) || sn.includes(t))
        );
      if (overlaps) {
        finalScore *= 1.3;
      }
    }

    return { ...chunk, score: finalScore };
  }).filter(chunk => chunk.score > -9000);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply progressive diversity filter
  // Same-class methods are complementary (not redundant) — allow more before demoting.
  // Exact identifier symbol hits are never diversity-demoted (must survive into top-N).
  const fileCounts = new Map<string, number>();
  const diverse: ScoredChunk[] = [];

  for (const chunk of scored) {
    const count = fileCounts.get(chunk.sourceFile) || 0;
    const sn = (chunk.symbolName || '').toLowerCase();
    const isExactId = sn && identifiers.has(sn);
    const threshold = chunk.parentSymbol
      ? Math.max(diversityPenaltyStart + 4, 8)
      : (chunk.symbolKind === 'class' || chunk.symbolKind === 'struct')
        ? diversityPenaltyStart + 2
        : diversityPenaltyStart;
    if (!isExactId && count >= threshold) {
      chunk.score *= Math.pow(diversityDecay, count - threshold + 1);
    }
    fileCounts.set(chunk.sourceFile, count + 1);
    diverse.push(chunk);
  }

  // Re-sort after demotions
  diverse.sort((a, b) => b.score - a.score);

  return diverse;
}
