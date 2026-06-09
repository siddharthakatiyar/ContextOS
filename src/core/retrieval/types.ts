import { Chunk } from '../storage/types.js';
import { ExpandedEntity } from '../graph/expander.js';

export interface DetectedIntent {
  concepts: string[];
  identifiers: string[];
  quotedTerms: string[];
  intentType: string;
  rawPrompt: string;
}

export interface RetrievalOptions {
  limit?: number;
  maxChunks?: number;
  layers?: string[];
}

export interface ScoredChunk extends Chunk {
  score: number;
}

export interface RetrievalResult {
  chunks: ScoredChunk[];
  intent: DetectedIntent;
  expandedEntities: ExpandedEntity[];
  latencyMs: number;
}
