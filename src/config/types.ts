import { z } from 'zod';
import { Layer } from '../core/storage/types.js';

export interface ContextOSConfig {
  dbPath: string;
  globalContextDir: string;
  
  indexablePatterns: string[];
  ignorePatterns: string[];
  maxChunkTokens: number;
  /** Soft threshold: function/method bodies above this also emit additive segment chunks. */
  maxSymbolChunkTokens: number;
  
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

  /** Local embedding hybrid search (index-time). Disable via CONTEXTOS_EMBEDDINGS=0. */
  embeddingsEnabled: boolean;
  /** When true, fuse embedding kNN into retrieval. Default false — keyword path is the accuracy baseline. */
  embeddingsRetrieval: boolean;
  
  cursor: {
    autoGenerateConfig: boolean;
  };
  memoryInjection: 'relevant' | 'always' | 'off';
  sentDedupEnabled: boolean;
  legacyTools: boolean;
  tokenCalibration: number;
  framingReserve: number;
  adaptiveResponse: boolean;
}

/** Partial zod schema for config.json — validates known keys; unknown keys are stripped with a warning. */
export const configJsonSchema = z.object({
  dbPath: z.string().optional(),
  globalContextDir: z.string().optional(),
  indexablePatterns: z.array(z.string()).optional(),
  ignorePatterns: z.array(z.string()).optional(),
  maxChunkTokens: z.number().positive().optional(),
  maxSymbolChunkTokens: z.number().positive().optional(),
  maxRetrievalResults: z.number().int().positive().optional(),
  maxTokenBudget: z.number().int().positive().optional(),
  layerBoosts: z.object({
    session: z.number().optional(),
    repo: z.number().optional(),
    workspace: z.number().optional(),
    global: z.number().optional(),
  }).partial().optional(),
  graphExpansionDepth: z.number().int().nonnegative().optional(),
  graphExpansionMaxNodes: z.number().int().positive().optional(),
  maxGraphBoost: z.number().optional(),
  diversityDecay: z.number().optional(),
  diversityPenaltyStart: z.number().int().nonnegative().optional(),
  ftsLimit: z.number().int().positive().optional(),
  busyTimeout: z.number().int().nonnegative().optional(),
  embeddingsEnabled: z.boolean().optional(),
  embeddingsRetrieval: z.boolean().optional(),
  cursor: z.object({
    autoGenerateConfig: z.boolean().optional(),
  }).partial().optional(),
  memoryInjection: z.enum(['relevant', 'always', 'off']).optional(),
  sentDedupEnabled: z.boolean().optional(),
  legacyTools: z.boolean().optional(),
  tokenCalibration: z.number().positive().optional(),
  framingReserve: z.number().nonnegative().optional(),
  adaptiveResponse: z.boolean().optional(),
}).passthrough();

export type ConfigJson = z.infer<typeof configJsonSchema>;
