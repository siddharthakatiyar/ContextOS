import { describe, it, expect } from 'vitest';
import { chunkCode } from '../../src/core/chunker/code-chunker.js';
import crypto from 'crypto';

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
});
