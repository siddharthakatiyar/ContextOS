export function sanitizeFTSQuery(query: string): string {
  let sanitized = query;
  // strip dashes
  sanitized = sanitized.replace(/-/g, ' ');
  // strip FTS keywords
  sanitized = sanitized.replace(/\b(AND|OR|NOT)\b/gi, ' ');
  // fix unbalanced quotes
  const quoteCount = (sanitized.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
      sanitized = sanitized.replace(/"/g, ' ');
  }
  return sanitized.trim();
}
