export interface CompiledContext {
  output: string;
  tokenCount: number;
  diagnostics?: CompilerDiagnostics;
}

export interface CompilerDiagnostics {
  tier: 'exact' | 'exact-implementation' | 'file' | 'explore';
  outputFormat: 'markdown' | 'xml';
  configuredMaxTokens: number;
  effectiveMaxTokens: number;
  firstPassChunkBudget: number;
  repackChunkBudget?: number;
  framingReserve: number;
  signalTerms: string[];
  includedChunks: { id: string; representation: 'body' | 'excerpt' | 'stub' }[];
  omittedChunkIds: string[];
}

export interface CompilerOptions {
  sentRegistry?: import('../session/sent-registry.js').SentRegistry | null;
  maxTokens: number;
  /** Collect compile decisions for the optional retrieval inspector. */
  explain?: boolean;
  maxExactTokens?: number;
  outputFormat?: 'markdown' | 'xml';
  /** Query intent terms used for signal-preserving truncation. */
  signalTerms?: string[];
  tier?: 'exact' | 'exact-implementation' | 'file' | 'explore';
  /** Repository root used to render source paths relative to the active project. */
  repoRoot?: string;
  /** Tokens reserved for headings, path legends, and other response framing. */
  framingReserve?: number;
}
