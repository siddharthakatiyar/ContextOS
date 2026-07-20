import { RetrievalResult } from '../retrieval/types.js';

export function assessTier(
  result: RetrievalResult
): 'exact' | 'exact-implementation' | 'file' | 'explore' {
  const topChunks = result.chunks.slice(0, 5);

  const exactMatch = topChunks.some((c) => {
    return c.symbolName && result.intent?.identifiers?.includes(c.symbolName) && c.score >= 10;
  });

  if (exactMatch) {
    const rawPrompt = result.intent?.rawPrompt || '';
    const isImplementation =
      /(how|what) does .* (work|function|do)/i.test(rawPrompt) ||
      /(explain|describe) .* implementation/i.test(rawPrompt) ||
      /how is .* implemented/i.test(rawPrompt);
    return isImplementation ? 'exact-implementation' : 'exact';
  }

  const fileMatch = topChunks.some((c) => {
    const stem = c.sourceFile.split(/[/\\]/).pop()?.split('.')[0] || '';
    return result.intent?.concepts?.includes(stem) && c.score >= 5;
  });
  if (fileMatch) return 'file';

  return 'explore';
}
