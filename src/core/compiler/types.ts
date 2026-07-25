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
}
