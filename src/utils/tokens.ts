export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Code has ~3.5 chars/token, prose ~4.5, mixed ~4
  // Measure punctuation density to estimate how "code-like" the string is
  const codeRatio = (text.match(/[{}();=<>\[\]\.,+*\/-]/g)?.length || 0) / text.length;
  // Clamp between 0 and 0.5 (where 0.5 means highly dense code)
  const clampedRatio = Math.min(Math.max(codeRatio, 0), 0.5);
  // Scale from 4.5 (pure text) to 3.0 (dense code) based on punctuation ratio
  const charsPerToken = 4.5 - (clampedRatio * 2 * 1.5);
  return Math.ceil(text.length / charsPerToken);
}
