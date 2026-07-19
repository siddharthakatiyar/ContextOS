import { describe, it, expect } from 'vitest';
import { compile } from '../../src/core/compiler/index.js';
import { RetrievalResult, ScoredChunk } from '../../src/core/retrieval/types.js';

function makeChunk(id: string, content: string, score: number): ScoredChunk {
  return {
    id,
    sourceFile: 'test.ts',
    content,
    score,
    tokenCount: content.length / 4,
    startLine: 1,
    endLine: 10,
    symbolName: 'foo',
    layer: 'repo',
    language: 'typescript'
  } as ScoredChunk;
}

describe('Compiler', () => {
  it('compiles full bodies when within token budget', () => {
    const chunk1 = makeChunk('1', 'console.log("hello");', 10);
    const chunk2 = makeChunk('2', 'const a = 1;', 5);
    
    const result: RetrievalResult = {
      chunks: [chunk1, chunk2],
      expandedEntities: [],
      intent: { isBroad: false } as any,
      latencyMs: 10
    };
    
    const compiled = compile(result, { maxTokens: 1000, repoRoot: '/test' });
    
    expect(compiled.output).toContain('console.log("hello");');
    expect(compiled.output).toContain('const a = 1;');
  });

  it('downgrades chunks to stubs when outside token budget', () => {
    const chunk1 = makeChunk('1', 'a'.repeat(2000), 10); // Token count ~ 500
    const chunk2 = makeChunk('2', 'b'.repeat(2000), 5);  // Token count ~ 500
    
    const result: RetrievalResult = {
      chunks: [chunk1, chunk2],
      expandedEntities: [],
      intent: { isBroad: false } as any,
      latencyMs: 10
    };
    
    const compiled = compile(result, { maxTokens: 600 });
    
    expect(compiled.output).toContain('a'.repeat(2000));
    expect(compiled.output).not.toContain('b'.repeat(2000));
    expect(compiled.output).toContain('### Also');
  });
});
