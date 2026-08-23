import { describe, it, expect } from 'vitest';
import { sanitizeFTSQuery, sanitizeFTSTerm } from '../../src/core/storage/fts-sanitizer.js';

describe('fts-sanitizer', () => {
  it('sanitizeFTSTerm strips dashes and boolean keywords', () => {
    expect(sanitizeFTSTerm('foo-bar AND baz')).toBe('foo bar  baz'.replace(/\s+/g, ' ').trim());
    expect(sanitizeFTSTerm('hello OR world')).toBe('hello  world'.replace(/\s+/g, ' ').trim());
  });

  it('legacy sanitizeFTSQuery strips OR/AND', () => {
    const q = sanitizeFTSQuery('"error" OR "bug"');
    expect(q).not.toMatch(/\bOR\b/i);
  });

  it('preserveOperators keeps OR/AND between quoted terms', () => {
    const q = sanitizeFTSQuery('"error" OR "bug" OR "fix"', { preserveOperators: true });
    expect(q).toContain(' OR ');
    expect(q).toMatch(/"error"/);
    expect(q).toMatch(/"bug"/);
  });

  it('preserveOperators sanitizes inside quotes only', () => {
    const q = sanitizeFTSQuery('"foo-bar" AND "baz"', { preserveOperators: true });
    expect(q).toContain(' AND ');
    expect(q).toContain('"foo bar"');
  });

  it('preserveOperators drops fully-stripped quoted terms instead of emitting empty phrases', () => {
    // Regression: an empty `""` phrase is an FTS5 syntax error and used to
    // crash retrieval for prompts quoting only stripped characters.
    expect(sanitizeFTSQuery('"---"', { preserveOperators: true })).toBe('');
    const q = sanitizeFTSQuery('"auth" OR "---"', { preserveOperators: true });
    expect(q).toBe('"auth"');
  });

  it('preserveOperators collapses dangling operators around dropped terms', () => {
    expect(sanitizeFTSQuery('"a" OR "---" OR "b"', { preserveOperators: true })).toBe('"a" OR "b"');
    expect(sanitizeFTSQuery('"---" OR "b"', { preserveOperators: true })).toBe('"b"');
    expect(sanitizeFTSQuery('"a" OR "---"', { preserveOperators: true })).toBe('"a"');
    expect(sanitizeFTSQuery('NOT "---"', { preserveOperators: true })).toBe('');
  });
});
