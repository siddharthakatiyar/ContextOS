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
  feedbackAdjustments?: Record<string, number>;
  /** Explicit repo root for foreign-workspace scoring (B27). Defaults to process.cwd(). */
  repoRoot?: string;
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

export interface ScoreChunksOptions {
  repoRoot?: string;
  /** Prompt identifiers + concept unigrams for generic symbol fuzzy boost. */
  matchTokens?: string[];
  /** High-precision identifiers (stronger boost than concepts). */
  identifiers?: string[];
}
