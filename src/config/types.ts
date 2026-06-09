import { Layer } from '../core/storage/types.js';

export interface ContextOSConfig {
  dbPath: string;
  globalContextDir: string;
  
  indexablePatterns: string[];
  ignorePatterns: string[];
  maxChunkTokens: number;
  
  maxRetrievalResults: number;
  maxTokenBudget: number;
  layerBoosts: Record<Layer, number>;
  graphExpansionDepth: number;
  graphExpansionMaxNodes: number;
  maxGraphBoost?: number;
  diversityDecay?: number;
  diversityPenaltyStart?: number;
  
  ftsLimit: number;
  busyTimeout: number;
  
  cursor: {
    autoGenerateConfig: boolean;
  };
}
