import { describe, it, expect } from 'vitest';
import { chunkCode } from '../../src/core/chunker/code-chunker.js';

describe('code-chunker', () => {
  it('should create chunks from parsed symbols', () => {
    const symbols = [
      {
        name: 'testFunc',
        kind: 'function' as const,
        startLine: 1,
        endLine: 3,
        body: 'function testFunc() { return true; }'
      }
    ];
    
    const doc = {
      filePath: 'test.ts',
      language: 'typescript',
      symbols
    };

    const chunks = chunkCode(doc, { layer: 'repo' });
    expect(chunks.length).toBe(2); // 1 for file, 1 for symbol
    expect(chunks[0].symbolName).toBe('testFunc');
    expect(chunks[0].content).toBe('function testFunc() { return true; }');
  });
});
