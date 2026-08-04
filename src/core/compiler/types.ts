export interface CompiledContext {
  output: string;
  tokenCount: number;
}

export interface CompilerOptions {
  maxTokens: number;
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
