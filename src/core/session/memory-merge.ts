import crypto from 'crypto';
import { ScoredChunk, DetectedIntent } from '../retrieval/types.js';
import { estimateTokens } from '../../utils/tokens.js';
import { loadConfig } from '../../config/index.js';

const MEMORY_TOKENS_CAP = 120;

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

export function mergeMemoryPipeline(
  codeChunks: ScoredChunk[],
  sessionChunks: Array<{ id: string; content: string; layer: string; importance: number; eventType?: string }>,
  knowledgeFacts: Array<{ id: string; fact: string; category: string; confidence: number }>,
  intent: DetectedIntent,
): ScoredChunk[] {
  const config = loadConfig();
  const injection = config.memoryInjection || 'relevant';
  
  if (injection === 'off') {
    return codeChunks;
  }

  const memory: ScoredChunk[] = [];
  const intentLower = intent.intentType?.toLowerCase() || '';
  const promptTokens = new Set([
    ...intent.identifiers.map(i => i.toLowerCase()),
    ...intent.concepts.map(c => c.toLowerCase()),
    ...intent.quotedTerms.map(q => q.toLowerCase())
  ]);

  for (const sc of sessionChunks) {
    let include = false;
    let score = sc.importance;
    const content = sc.content;
    const isBranch = sc.id.startsWith('session:branch:');
    const isEvents = sc.id.startsWith('session:events:');

    if (injection === 'always') {
      include = true;
    } else if (injection === 'relevant') {
      if (isBranch) {
        if (['fix', 'deploy', 'pr'].includes(intentLower)) {
          include = true;
          score = 4; // imp 8 -> 4
        }
      } else if (isEvents) {
        // Session events only on term overlap, never echo errors unless intent=fix
        const hasError = sc.eventType === 'error' || content.includes('[error]:');
        if (hasError && intentLower !== 'fix') {
          continue; // never echo errors unless intent=fix
        }
        
        // Term overlap
        const contentLower = content.toLowerCase();
        const overlap = Array.from(promptTokens).some(t => t.length > 3 && contentLower.includes(t));
        if (overlap) {
          include = true;
          score = 5; // imp 9 -> 5
        }
      } else {
        // unknown session chunk
        include = true;
      }
    }

    if (include) {
      memory.push({
        id: sc.id,
        content,
        sourceFile: 'session',
        layer: 'session',
        workspaceName: null,
        sectionTitle: null,
        sectionDepth: 0,
        summary: null,
        keywords: null,
        hash: contentHash(content),
        importance: score,
        tokenCount: estimateTokens(content),
        score: score,
        fileType: 'text',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as ScoredChunk);
    }
  }

  for (const fact of knowledgeFacts) {
    if (injection === 'relevant' && fact.confidence < 0.6) { // fact score floor
      continue;
    }
    const content = `**[${fact.category.toUpperCase()}]**: ${fact.fact}`;
    const score = fact.confidence * 10;
    memory.push({
      id: fact.id,
      content,
      sourceFile: 'memory.fact',
      layer: 'global',
      workspaceName: null,
      sectionTitle: 'Cross-Session Knowledge Fact',
      sectionDepth: 1,
      summary: null,
      keywords: null,
      hash: contentHash(content),
      importance: Math.round(score),
      tokenCount: estimateTokens(content),
      score: score,
      fileType: 'text',
      language: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as ScoredChunk);
  }

  // Cap memory insertion at 120 tokens
  const sortedMemory = memory.sort((a, b) => (b.score || 0) - (a.score || 0));
  const cappedMemory: ScoredChunk[] = [];
  let tokenSum = 0;

  for (const memChunk of sortedMemory) {
    if (tokenSum + (memChunk.tokenCount || 0) <= MEMORY_TOKENS_CAP) {
      cappedMemory.push(memChunk);
      tokenSum += memChunk.tokenCount || 0;
    } else if (cappedMemory.length === 0) {
      // Allow at least one if it's over budget but first
      cappedMemory.push(memChunk);
      break;
    } else {
      break;
    }
  }

  return [...codeChunks, ...cappedMemory].sort(
    (a, b) => (b.score || 0) - (a.score || 0),
  );
}
