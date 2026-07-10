import { ScoredChunk } from './types.js';
import { ExpandedEntity } from '../graph/expander.js';

import { loadConfig } from '../../config/index.js';
import path from 'path';

export function scoreChunks(chunks: ScoredChunk[], expandedEntities: ExpandedEntity[], feedbackAdjustments: Record<string, number> = {}): ScoredChunk[] {
  const config = loadConfig();
  const layerBoosts = config.layerBoosts || { session: 1.5, repo: 1.3, workspace: 1.1, global: 1.0 };
  const maxGraphBoost = config.maxGraphBoost || 10;
  const diversityDecay = config.diversityDecay || 0.7;
  const diversityPenaltyStart = config.diversityPenaltyStart || 3;
  const cwd = process.cwd();

  const entityScores = new Map<string, number>();
  for (const e of expandedEntities) {
    entityScores.set(e.entity, e.score);
  }

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

    // Graph expansion boost
    if (chunk.keywords) {
      const chunkKeywords = chunk.keywords.split(', ').map(k => k.trim());
      let graphBoost = 0;
      for (const k of chunkKeywords) {
        if (entityScores.has(k)) {
          graphBoost += (entityScores.get(k)! * 5.0); // Boost by graph score
        }
      }
      finalScore += Math.min(graphBoost, maxGraphBoost);
    }

    // Importance weight
    finalScore += Math.min((chunk.importance || 0), 10) / 10 * 2.0;

    // Feedback adjustment
    if (chunk.id && feedbackAdjustments[chunk.id] !== undefined) {
      finalScore += feedbackAdjustments[chunk.id];
    }

    // Layer boost (Multiplicative)
    finalScore *= (layerBoosts[chunk.layer as keyof typeof layerBoosts] || 1.0);

    // Prefer repo-local source files over foreign workspace pollution
    if (chunk.layer === 'workspace' && chunk.workspaceName) {
      const ws = chunk.workspaceName;
      const isLocal =
        ws === cwd ||
        cwd.startsWith(ws + path.sep) ||
        ws.startsWith(cwd + path.sep) ||
        path.basename(cwd) === path.basename(ws);
      if (!isLocal) {
        finalScore *= 0.3;
      }
    }

    // Prefer primary symbol bodies over File Structure stubs
    if (chunk.sectionTitle === 'File Structure') {
      finalScore *= 0.5;
    }

    // Prefer large schema/DDL variable symbols (template-literal consts)
    if (chunk.symbolKind === 'variable' && (chunk.tokenCount || 0) > 200) {
      finalScore *= 1.8;
    }

    // Prefer method bodies over compact class outlines when both appear
    if (chunk.parentSymbol && (chunk.symbolKind === 'function' || chunk.symbolKind === 'method')) {
      finalScore *= 1.15;
    }
    // Demote tiny class outlines (member lists) relative to real implementations
    if ((chunk.symbolKind === 'class' || chunk.symbolKind === 'struct') && (chunk.tokenCount || 0) < 80) {
      finalScore *= 0.6;
    }
    // Constructors and trivial getters rarely answer architectural questions
    if (chunk.symbolName === 'constructor') {
      finalScore *= 0.35;
    }
    if (chunk.symbolName === 'getLatestSession' || chunk.symbolName === 'dbPath' || chunk.symbolName === 'globalContextDir') {
      finalScore *= 0.5;
    }
    if (chunk.symbolName === 'ENTITY_BLOCKLIST' || chunk.symbolName === 'ENTITY_PATTERNS' || chunk.symbolName === 'ENTITY_STOPWORDS') {
      finalScore *= 0.4;
    }
    // Prefer primary exported functions named like the query topic
    if (chunk.symbolName && /^(extract|parse|compile|expand|start|init|register)/i.test(chunk.symbolName)) {
      finalScore *= 1.2;
    }

    return { ...chunk, score: finalScore };
  }).filter(chunk => chunk.score > -9000);

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply progressive diversity filter
  const fileCounts = new Map<string, number>();
  const diverse: ScoredChunk[] = [];
  
  for (const chunk of scored) {
    const count = fileCounts.get(chunk.sourceFile) || 0;
    if (count >= diversityPenaltyStart) {
      chunk.score *= Math.pow(diversityDecay, count - diversityPenaltyStart + 1);
    }
    fileCounts.set(chunk.sourceFile, count + 1);
    diverse.push(chunk);
  }

  // Re-sort after demotions
  diverse.sort((a, b) => b.score - a.score);

  return diverse;
}
