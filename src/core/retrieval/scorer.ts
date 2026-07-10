import { ScoredChunk } from './types.js';
import { ExpandedEntity } from '../graph/expander.js';

import { loadConfig } from '../../config/index.js';

export function scoreChunks(chunks: ScoredChunk[], expandedEntities: ExpandedEntity[], feedbackAdjustments: Record<string, number> = {}): ScoredChunk[] {
  const config = loadConfig();
  const layerBoosts = config.layerBoosts || { session: 1.5, repo: 1.3, workspace: 1.1, global: 1.0 };
  const maxGraphBoost = config.maxGraphBoost || 10;
  const diversityDecay = config.diversityDecay || 0.7;
  const diversityPenaltyStart = config.diversityPenaltyStart || 3;

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

    // 2. Huge boost for architectural source-of-truth docs (CLAUDE.md, engineering.md)
    if (lowerPath.endsWith('claude.md') || lowerPath.endsWith('engineering.md')) {
      finalScore += 20; // Massive additive boost to float rules to the top
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
