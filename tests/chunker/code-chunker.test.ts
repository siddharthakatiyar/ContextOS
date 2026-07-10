import { describe, it, expect } from 'vitest';
import { chunkCode, segmentLargeSymbol } from '../../src/core/chunker/code-chunker.js';
import crypto from 'crypto';
import { estimateTokens } from '../../src/utils/tokens.js';

describe('code-chunker', () => {
  it('should create chunks from parsed symbols', () => {
    const symbols = [
      {
        name: 'testFunc',
        kind: 'function' as const,
        startLine: 1,
        endLine: 6,
        body: `function testFunc() {
  const value = true;
  if (!value) {
    return false;
  }
  return value;
}`
      }
    ];
    
    const doc = {
      filePath: 'test.ts',
      language: 'typescript',
      symbols
    };

    const chunks = chunkCode(doc, { layer: 'repo' });
    expect(chunks.length).toBe(2); // symbol + File Structure (no whole-file when symbols exist)
    expect(chunks[0].symbolName).toBe('testFunc');
    expect(chunks[0].content).toContain('function testFunc');
    expect(chunks[0].parentSymbol).toBeNull();
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(6);
    expect(chunks[0].fileStem).toBe('test');
  });

  it('should use stable IDs that survive content edits', () => {
    const make = (body: string) => chunkCode({
      filePath: 'svc.ts',
      language: 'typescript',
      symbols: [{
        name: 'run',
        kind: 'function',
        startLine: 1,
        endLine: 5,
        body,
      }],
    }, { layer: 'repo' });

    const a = make('function run() {\n  return 1;\n  // pad\n  // pad\n}');
    const b = make('function run() {\n  return 2;\n  // pad\n  // pad\n}');
    const symbolA = a.find(c => c.symbolName === 'run')!;
    const symbolB = b.find(c => c.symbolName === 'run')!;
    expect(symbolA.id).toBe(symbolB.id);
    expect(symbolA.hash).not.toBe(symbolB.hash);
    expect(symbolA.id).toBe(
      crypto.createHash('md5').update('svc.ts:run').digest('hex')
    );
    expect(symbolA.tokenCount).toBeGreaterThan(0);
  });

  it('should skip whole-file fallback when a real symbol exists', () => {
    const chunks = chunkCode({
      filePath: 'one.ts',
      language: 'typescript',
      rawContent: 'function only() {\n  return true;\n  // x\n}',
      symbols: [{
        name: 'only',
        kind: 'function',
        startLine: 1,
        endLine: 4,
        body: 'function only() {\n  return true;\n  // x\n}',
      }],
    }, { layer: 'repo' });
    expect(chunks.some(c => c.symbolKind === 'file')).toBe(false);
  });

  it('emits additive segments for oversized functions with full coverage', () => {
    const sections: string[] = [];
    for (let s = 0; s < 8; s++) {
      sections.push(`  // Section ${s}: handling path ${s}`);
      sections.push(`  if (mode === ${s}) {`);
      for (let i = 0; i < 25; i++) {
        sections.push(`    result_${s}_${i} = computeValue_${s}_${i}(input, flags, options);`);
      }
      sections.push(`    return result_${s}_0;`);
      sections.push(`  }`);
      sections.push(``);
    }
    const body = `function hugeHandler(mode, input, flags, options) {\n${sections.join('\n')}\n}`;
    expect(estimateTokens(body)).toBeGreaterThan(900);

    const startLine = 10;
    const lineCount = body.split('\n').length;
    const chunks = chunkCode({
      filePath: 'big.ts',
      language: 'typescript',
      symbols: [{
        name: 'hugeHandler',
        kind: 'function',
        startLine,
        endLine: startLine + lineCount - 1,
        body,
      }],
    }, { layer: 'repo', maxSymbolChunkTokens: 900 });

    const parent = chunks.find(c => c.symbolName === 'hugeHandler' && c.symbolKind === 'function')!;
    const segs = chunks.filter(c => c.symbolKind === 'segment');
    expect(parent).toBeTruthy();
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.every(s => !s.symbolName)).toBe(true);
    expect(segs.every(s => s.parentSymbol === 'hugeHandler')).toBe(true);

    const ordered = [...segs].sort((a, b) => (a.startLine || 0) - (b.startLine || 0));
    const joined = ordered.map(s => s.content).join('\n');
    expect(joined).toBe(body);

    expect(ordered[0].startLine).toBe(startLine);
    expect(ordered[ordered.length - 1].endLine).toBe(startLine + lineCount - 1);
    for (let i = 1; i < ordered.length; i++) {
      expect(ordered[i].startLine).toBe((ordered[i - 1].endLine || 0) + 1);
    }

    const fsChunk = chunks.find(c => c.sectionTitle === 'File Structure')!;
    expect(fsChunk.content).toContain('[function] hugeHandler');
    expect(fsChunk.content).not.toContain('[segment]');
  });

  it('segmentLargeSymbol returns contiguous absolute line ranges', () => {
    const lines = Array.from({ length: 120 }, (_, i) => {
      if (i % 20 === 0) return `  // block ${i / 20}`;
      if (i % 20 === 1) return `  if (x === ${i}) {`;
      if (i % 20 === 19) return `  }`;
      return `    doWork_${i}(a, b, c, d, e);`;
    });
    const body = `function demo() {\n${lines.join('\n')}\n}`;
    const segs = segmentLargeSymbol({
      name: 'demo',
      kind: 'function',
      startLine: 5,
      endLine: 5 + body.split('\n').length - 1,
      body,
    }, 200);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.map(s => s.content).join('\n')).toBe(body);
    expect(segs[0].startLine).toBe(5);
  });

  it('segmentLargeSymbol prefers comment labels for section titles', () => {
    const body = [
      'function demo() {',
      '  // Prefer repo-local source files over foreign workspace pollution',
      '  if (chunk.layer === "workspace" && chunk.workspaceName) {',
      ...Array.from({ length: 40 }, (_, i) => `    doWork_${i}(a, b, c);`),
      '  }',
      '',
      '  // Soft demotion for very large chunks so siblings can share',
      '  if ((chunk.tokenCount || 0) > 1800) {',
      ...Array.from({ length: 40 }, (_, i) => `    otherWork_${i}(x, y);`),
      '  }',
      '}',
    ].join('\n');
    const segs = segmentLargeSymbol({
      name: 'demo',
      kind: 'function',
      startLine: 1,
      endLine: body.split('\n').length,
      body,
    }, 120);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.some((s) => /Prefer repo-local|foreign workspace/i.test(s.label))).toBe(true);
  });
});
