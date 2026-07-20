import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  isEmbeddingsAvailable,
  embedTexts,
  embedChunkText,
  _resetEmbedderForTests
} from '../../src/core/embeddings/index.js';
import type { Chunk } from '../../src/core/storage/types.js';

describe('embeddings embedder', () => {
  const prevEnv = process.env.CONTEXTOS_EMBEDDINGS;

  beforeEach(() => {
    _resetEmbedderForTests();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.CONTEXTOS_EMBEDDINGS;
    } else {
      process.env.CONTEXTOS_EMBEDDINGS = prevEnv;
    }
    _resetEmbedderForTests();
  });

  it('isEmbeddingsAvailable returns false when CONTEXTOS_EMBEDDINGS=0', () => {
    process.env.CONTEXTOS_EMBEDDINGS = '0';
    expect(isEmbeddingsAvailable()).toBe(false);
  });

  it('embedTexts returns empty array when embeddings disabled (no model download)', async () => {
    process.env.CONTEXTOS_EMBEDDINGS = '0';
    const result = await embedTexts(['hello world']);
    expect(result).toEqual([]);
  });

  it('embedTexts returns empty for empty input', async () => {
    process.env.CONTEXTOS_EMBEDDINGS = '0';
    expect(await embedTexts([])).toEqual([]);
  });

  it('marks unavailable path as graceful (forced unavailable)', async () => {
    delete process.env.CONTEXTOS_EMBEDDINGS;
    _resetEmbedderForTests({ unavailable: true });
    expect(isEmbeddingsAvailable()).toBe(false);
    expect(await embedTexts(['x'])).toEqual([]);
  });
});

describe('embedChunkText', () => {
  it('includes summary, keywords, and capped content', () => {
    const chunk: Chunk = {
      id: 'c1',
      sourceFile: 'foo.ts',
      layer: 'repo',
      workspaceName: null,
      sectionTitle: 'MyFn',
      sectionDepth: 1,
      content: Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'),
      summary: 'does stuff',
      keywords: 'foo, bar',
      hash: 'h',
      importance: 5,
      tokenCount: 10,
      symbolName: 'myFn',
      createdAt: 0,
      updatedAt: 0
    };
    const text = embedChunkText(chunk);
    expect(text).toContain('does stuff');
    expect(text).toContain('foo, bar');
    expect(text).toContain('myFn');
    expect(text).toContain('line 0');
    expect(text.length).toBeLessThan(2000);
    // content capped ~500 chars among other parts
    expect(text).not.toContain('line 99');
  });
});
