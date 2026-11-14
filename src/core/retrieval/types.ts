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
  selectedRepo?: boolean;
  limit?: number;
  maxChunks?: number;
  layers?: string[];
  feedbackAdjustments?: Record<string, number>;
  /** Collect optional ranking provenance. Disabled by default to keep normal queries lean. */
  explain?: boolean;
  /** Explicit repo root for foreign-workspace scoring (B27). Defaults to process.cwd(). */
  repoRoot?: string;
}

export interface KeywordScoreContribution {
  strategy: string;
  /** Zero-based position in the strategy's ranked list. */
  rank: number;
  weight: number;
  /** The exact RRF score added after the matcher's 100x scale. */
  scoreContribution: number;
}

export interface RetrievalChunkExplanation {
  repository?: { repoId: string; name: string; localityMultiplier: number };
  keyword?: {
    rrfScore: number;
    contributions: KeywordScoreContribution[];
  };
  embedding?:
    | {
        action: 'agreement-boost';
        /** One-based position in embedding search results. */
        rank: number;
        scoreBefore: number;
        scoreAfter: number;
        multiplier: number;
      }
    | {
        action: 'fallback-insert';
        /** One-based position in embedding search results. */
        rank: number;
        score: number;
      };
  graph?: {
    /** Score returned by graph keyword matching before overlap fusion. */
    matchScore?: number;
    /** Exact score added when a graph match overlapped a direct match. */
    overlapScoreAdded?: number;
    /** Actual additive keyword/entity boost applied by scoreChunks. */
    keywordBoost?: number;
    matchedEntities?: string[];
  };
  feedback?: { adjustment: number };
  sessionContext?: true;
  /** Final score returned by retrieval after scoring and post-processing. */
  finalScore: number;
}

export interface RetrievalExplanation {
  embeddingSearch: {
    configured: boolean;
    lowConfidenceFallback: boolean;
    available: boolean;
    searched: boolean;
    hitCount: number | null;
    failed?: true;
  };
  graphExpansionEnabled: boolean;
  chunks: Record<string, RetrievalChunkExplanation>;
}

export interface ScoredChunk extends Chunk {
  score: number;
  /** Internal containment signal used to prefer a retained child over its dropped parent. */
  parentDropped?: boolean;
}

export interface RetrievalResult {
  knowledgeLinks?: import('../knowledge/graph-store.js').VerifiedLink[];
  learnedLinks?: import('../knowledge/graph-store.js').VerifiedLink[];
  linkSuggestions?: import('../knowledge/import-learning.js').LinkSuggestion[];
  scope?: import('../workspace/registry.js').RetrievalScope;
  unavailableSources?: Array<{ repoId: string; name: string; error: string }>;
  partial?: boolean;
  chunks: ScoredChunk[];
  intent: DetectedIntent;
  expandedEntities: ExpandedEntity[];
  latencyMs: number;
  explanation?: RetrievalExplanation;
}

export interface ScoreChunksOptions {
  config?: import('../../config/types.js').ContextOSConfig;
  selectedRepo?: boolean;
  repoRoot?: string;
  /** Prompt identifiers + concept unigrams for generic symbol fuzzy boost. */
  matchTokens?: string[];
  /** High-precision identifiers (stronger boost than concepts). */
  identifiers?: string[];
  /** When false, skip the per-file diversity decay pass. Default: true */
  diversityFilter?: boolean;
  /** Optional observer for the exact graph and feedback additions applied during scoring. */
  onSignals?: (chunkId: string, signals: ScoringSignals) => void;
}

export interface ScoringSignals {
  graphKeywordBoost: number;
  matchedGraphEntities: string[];
  feedbackAdjustment?: number;
}
