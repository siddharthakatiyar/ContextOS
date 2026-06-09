export function estimateTokens(text: string): number {
  if (!text) return 0;
  // GPT-4 / Claude tokenization approximation:
  // ~4 characters per token for English text
  // ~3.0 characters per token for code (dense punctuation)
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks = text.match(codeBlockRegex) ?? [];
  const codeLength = codeBlocks.reduce((sum, block) => sum + block.length, 0);
  const textLength = text.length - codeLength;
  
  return Math.ceil(textLength / 4 + codeLength / 3.0);
}
