import { describe, it, expect } from 'vitest';
import { detectIntent } from '../../src/core/retrieval/intent-detector.js';

describe('detectIntent', () => {
  it('extracts camelCase and PascalCase multi-token identifiers', () => {
    const intent = detectIntent('How does createSession and SessionStore work?');
    expect(intent.identifiers).toContain('createSession');
    expect(intent.identifiers).toContain('SessionStore');
  });

  it('does not treat apostrophes in contractions as quotes', () => {
    const intent = detectIntent("What's the don't-care path for it's config?");
    expect(intent.quotedTerms).toEqual([]);
  });

  it('expands contractions so bare letter tokens are not left behind', () => {
    const intent = detectIntent("What's wrong with FTS query sanitization?");
    expect(intent.concepts).not.toContain('s');
    expect(intent.concepts).toContain('wrong');
    expect(intent.concepts).toContain('fts');
  });

  it('only uses balanced straight double-quote pairs', () => {
    const intent = detectIntent('Find "exact phrase" and also \'single\'');
    expect(intent.quotedTerms).toEqual(['exact phrase']);
  });

  it('filters stopwords from identifiers', () => {
    const intent = detectIntent('The And Or Not identifiers should be filtered');
    expect(intent.identifiers.every((id) => !['The', 'And', 'Or', 'Not'].includes(id))).toBe(true);
  });

  it('skips sentence-initial single Titlecase that is not multi-token', () => {
    const intent = detectIntent('Session lifecycle and DB events');
    // "Session" alone at start should not be an identifier; SessionStore would
    expect(intent.identifiers).not.toContain('Session');
    expect(intent.concepts).toContain('session');
  });
});
