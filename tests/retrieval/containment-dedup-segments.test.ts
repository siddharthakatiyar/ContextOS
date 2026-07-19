import { describe, it, expect } from 'vitest';
import { containmentDedup } from '../../src/core/retrieval/index.js';
import { ScoredChunk } from '../../src/core/retrieval/types.js';

function chunk(partial: Partial<ScoredChunk> & { id: string }): ScoredChunk {
  return {
    sourceFile: 'src/core/retrieval/scorer.ts',
    layer: 'repo',
    workspaceName: null,
    sectionTitle: null,
    sectionDepth: 2,
    content: 'x',
    summary: null,
    keywords: null,
    hash: 'h',
    importance: 5,
    tokenCount: 50,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    score: 10,
    ...partial,
  } as ScoredChunk;
}

describe('containmentDedup segments', () => {
  it('keeps exact-identifier parent and drops its segments', () => {
    const parent = chunk({
      id: 'p',
      symbolName: 'scoreChunks',
      symbolKind: 'function',
      tokenCount: 3382,
      score: 50,
    });
    const seg1 = chunk({
      id: 's1',
      symbolName: null,
      symbolKind: 'segment',
      parentSymbol: 'scoreChunks',
      sectionTitle: 'scoreChunks › foreign workspace',
      tokenCount: 300,
      score: 40,
    });
    const seg2 = chunk({
      id: 's2',
      symbolName: null,
      symbolKind: 'segment',
      parentSymbol: 'scoreChunks',
      sectionTitle: 'scoreChunks › poison paths',
      tokenCount: 280,
      score: 35,
    });
    const out = containmentDedup([parent, seg1, seg2], ['scoreChunks']);
    expect(out.map((c) => c.id)).toEqual(['p']);
  });

  it('drops giant parent when it is not an exact-id hit', () => {
    const parent = chunk({
      id: 'p',
      symbolName: 'scoreChunks',
      symbolKind: 'function',
      tokenCount: 3382,
      score: 50,
    });
    const seg1 = chunk({
      id: 's1',
      symbolName: null,
      symbolKind: 'segment',
      parentSymbol: 'scoreChunks',
      tokenCount: 300,
      score: 40,
    });
    const seg2 = chunk({
      id: 's2',
      symbolName: null,
      symbolKind: 'segment',
      parentSymbol: 'scoreChunks',
      tokenCount: 280,
      score: 35,
    });
    const out = containmentDedup([parent, seg1, seg2], ['foreign', 'workspace']);
    expect(out.map((c) => c.id).sort()).toEqual(['s1', 's2']);
  });

  it('does not treat segments as symbolName hits', () => {
    const seg = chunk({
      id: 's',
      symbolName: null,
      symbolKind: 'segment',
      parentSymbol: 'compressChunks',
      tokenCount: 320,
    });
    expect(seg.symbolName).toBeNull();
  });
});
