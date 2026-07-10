import { Layer } from '../storage/types.js';

export interface ChunkCreationOptions {
  layer: Layer;
  workspaceName?: string;
  importance?: number;
  maxChunkTokens?: number;
  /** Override for segment threshold (defaults to config.maxSymbolChunkTokens). */
  maxSymbolChunkTokens?: number;
}
