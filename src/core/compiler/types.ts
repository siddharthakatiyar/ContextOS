export interface CompiledContext {
  output: string;
  tokenCount: number;
}

export interface CompilerOptions {
  maxTokens: number;
  outputFormat?: 'markdown' | 'xml';
  /** Query intent terms used for signal-preserving truncation. */
  signalTerms?: string[];
}
