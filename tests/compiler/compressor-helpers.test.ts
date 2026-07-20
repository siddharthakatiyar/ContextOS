import { describe, it, expect } from 'vitest';
import {
  compressChunks,
  pickPrimaries,
  collectCompanions,
  orderForPacking,
  buildCompressCtx,
  packToBudget
} from '../../src/core/compiler/compressor.js';
import { ScoredChunk } from '../../src/core/retrieval/types.js';

function chunk(partial: Partial<ScoredChunk> & { id: string; content?: string }): ScoredChunk {
  const content = partial.content ?? `function ${partial.symbolName || 'x'}() { return 1; }`;
  return {
    sourceFile: 'src/core/compiler/compressor.ts',
    layer: 'repo',
    workspaceName: null,
    sectionTitle: null,
    sectionDepth: 0,
    content,
    summary: null,
    keywords: null,
    hash: partial.id,
    importance: 5,
    tokenCount: Math.ceil(content.length / 4),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    score: 10,
    fileType: 'code',
    language: 'typescript',
    ...partial
  } as ScoredChunk;
}

describe('compressChunks helpers', () => {
  it('pickPrimaries prefers stem-matching chunks', () => {
    const a = chunk({ id: '1', symbolName: 'unrelated', sourceFile: 'src/other.ts', score: 20 });
    const b = chunk({
      id: '2',
      symbolName: 'compressChunks',
      sourceFile: 'src/core/compiler/compressor.ts',
      score: 5
    });
    const ctx = buildCompressCtx(['compressChunks', 'toStub'], new Set(['compresschunks']));
    const primary = pickPrimaries([a, b], 2000, ctx);
    expect(primary[0].id).toBe('2');
  });

  it('collectCompanions pulls same-file siblings', () => {
    const leader = chunk({ id: '1', symbolName: 'compressChunks', score: 20 });
    const sibling = chunk({
      id: '2',
      symbolName: 'toStub',
      content: 'function toStub() { return null; }',
      score: 5
    });
    const other = chunk({
      id: '3',
      symbolName: 'elsewhere',
      sourceFile: 'src/other.ts',
      score: 4
    });
    const ctx = buildCompressCtx(['toStub', 'compressChunks'], new Set());
    const companions = collectCompanions([leader, sibling, other], [leader], ctx);
    expect(companions.some((c) => c.id === '2')).toBe(true);
  });

  it('orderForPacking puts leader first', () => {
    const leader = chunk({ id: '1', symbolName: 'compressChunks', score: 20 });
    const seg = chunk({
      id: '2',
      symbolKind: 'segment',
      parentSymbol: 'compressChunks',
      symbolName: null,
      tokenCount: 100,
      score: 8
    });
    const ctx = buildCompressCtx(['compressChunks'], new Set(['compresschunks']));
    const ordered = orderForPacking([leader, seg], [], ctx);
    expect(ordered[0].id).toBe('1');
  });

  it('packToBudget keeps framing-sized bodies under budget', () => {
    const leader = chunk({
      id: '1',
      symbolName: 'compressChunks',
      content:
        'function compressChunks() {\n  const framingReserve = 90;\n  return framingReserve;\n}\n',
      score: 20
    });
    const ctx = buildCompressCtx(['compressChunks', 'framingReserve'], new Set(['compresschunks']));
    const out = packToBudget([leader], [], 500, leader.sourceFile, ctx);
    expect(out[0].content).toContain('framingReserve');
  });

  it('compressChunks orchestrator exposes framingReserve path', () => {
    const leader = chunk({
      id: '1',
      symbolName: 'compressChunks',
      content:
        'export function compressChunks() {\n  const framingReserve = 90;\n  function toStub() {}\n  truncatePreservingSignals();\n}\n',
      score: 20
    });
    const stubFn = chunk({
      id: '2',
      symbolName: 'toStub',
      content: 'function toStub(c) { return c; }\n',
      score: 8
    });
    const out = compressChunks([leader, stubFn], 1200, {
      signalTerms: ['compressChunks', 'toStub', 'framingReserve'],
      identifiers: ['compressChunks']
    });
    const joined = out.map((c) => c.content).join('\n');
    expect(joined).toContain('framingReserve');
  });
});
