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
});
