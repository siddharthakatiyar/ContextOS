export interface SanitizeFTSOptions {
  /** When true, keep caller-built AND/OR/NOT between terms; only sanitize inside quoted strings. */
  preserveOperators?: boolean;
}

/**
 * Sanitize a single user/search term for FTS5 (strips dashes, boolean keywords, quotes).
 */
export function sanitizeFTSTerm(term: string): string {
  let sanitized = term;
  sanitized = sanitized.replace(/-/g, ' ');
  sanitized = sanitized.replace(/\b(AND|OR|NOT)\b/gi, ' ');
  sanitized = sanitized.replace(/"/g, ' ');
  return sanitized.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitize an FTS5 MATCH query.
 * Default (preserveOperators=false): legacy strip of dashes and AND/OR/NOT everywhere.
 * With preserveOperators=true: only sanitize inside "quoted" terms so Strategy 1 OR/AND works.
 */
export function sanitizeFTSQuery(query: string, opts?: SanitizeFTSOptions): string {
  if (opts?.preserveOperators) {
    let result = query.replace(/"([^"]*)"/g, (_match, inner: string) => {
      const cleaned = sanitizeFTSTerm(inner);
      if (!cleaned) return '""';
      return `"${cleaned.replace(/"/g, '""')}"`;
    });
    // Collapse leftover whitespace around operators
    result = result.replace(/\s+/g, ' ').trim();
    return result;
  }

  let sanitized = query;
  sanitized = sanitized.replace(/-/g, ' ');
  sanitized = sanitized.replace(/\b(AND|OR|NOT)\b/gi, ' ');
  const quoteCount = (sanitized.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) {
    sanitized = sanitized.replace(/"/g, ' ');
  }
  return sanitized.replace(/\s+/g, ' ').trim();
}
