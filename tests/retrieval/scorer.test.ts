import { describe, it, expect } from 'vitest';
import {
  scoreChunks,
  applyPoisonPenalty,
  applyWorkspacePenalty,
  applyNoiseDemotion,
  applyIntentAdjustments,
} from '../../src/core/retrieval/scorer.js';
import { ScoredChunk } from '../../src/core/retrieval/types.js';

function chunk(partial: Partial<ScoredChunk> & { id: string }): ScoredChunk {
  return {
    sourceFile: 'src/foo.ts',
    layer: 'repo',
    workspaceName: null,
    sectionTitle: null,
    sectionDepth: 0,
    content: 'x',
    summary: null,
    keywords: null,
    hash: 'h',
    importance: 5,
    tokenCount: 50,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    score: 1,
    ...partial,
  } as ScoredChunk;
}

describe('scoreChunks helpers', () => {
  it('applyPoisonPenalty zeros poison paths', () => {
    const c = chunk({ id: '1', sourceFile: 'src/foo.ts' });
    const poisoned = chunk({ id: '1', sourceFile: '/proj/node_modules/pkg/index.js' });
    expect(applyPoisonPenalty(poisoned, 10)).toBe(-9999);
    expect(applyPoisonPenalty(c, 10)).toBe(10);
  });

  it('applyWorkspacePenalty demotes foreign workspaces', () => {
    const foreign = chunk({
      id: '1',
      layer: 'workspace',
      workspaceName: '/other/project',
    });
    const ctx = {
      repoRoot: '/Volumes/ExtremeSSD/code/contextOS',
      matchTokens: [] as string[],
      identifiers: new Set<string>(),
    };
    expect(applyWorkspacePenalty(foreign, 10, ctx)).toBeCloseTo(3);
  });

  it('applyNoiseDemotion demotes tests and README', () => {
    expect(applyNoiseDemotion(chunk({ id: '1', sourceFile: 'src/foo.test.ts' }), 10)).toBeCloseTo(5.5);
    expect(applyNoiseDemotion(chunk({ id: '2', sourceFile: 'README.md' }), 10)).toBeCloseTo(4);
    expect(applyNoiseDemotion(chunk({ id: '3', sectionTitle: 'File Structure' }), 10)).toBeCloseTo(4.5);
  });

  it('applyIntentAdjustments boosts retrieve on dedup prompts', () => {
    const ctx = {
      repoRoot: '/x',
      matchTokens: ['deduplicate'],
      identifiers: new Set<string>(),
    };
    const retrieve = chunk({ id: '1', symbolName: 'retrieve' });
    const scorer = chunk({ id: '2', symbolName: 'scoreChunks' });
    expect(applyIntentAdjustments(retrieve, 10, ctx)).toBeGreaterThan(10);
    expect(applyIntentAdjustments(scorer, 10, ctx)).toBeLessThan(10);
  });
});

describe('scoreChunks', () => {
  it('accepts optional repoRoot instead of process.cwd()', () => {
    const foreign = chunk({
      id: '1',
      layer: 'workspace',
      workspaceName: '/other/project',
      score: 10,
    });
    const scored = scoreChunks([foreign], [], {}, { repoRoot: '/Volumes/ExtremeSSD/code/contextOS' });
    expect(scored[0].score).toBeLessThan(10);
  });

  it('boosts exact symbolName match to prompt tokens', () => {
    const hit = chunk({ id: '1', symbolName: 'extractRelationships', score: 1 });
    const miss = chunk({ id: '2', symbolName: 'unrelatedHelper', score: 1 });
    const scored = scoreChunks([hit, miss], [], {}, { matchTokens: ['extractRelationships'] });
    expect(scored[0].id).toBe('1');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('demotes trivial getters and constructors generically', () => {
    const getter = chunk({ id: '1', symbolName: 'getFoo', tokenCount: 10, score: 5 });
    const ctor = chunk({ id: '2', symbolName: 'constructor', tokenCount: 20, score: 5 });
    const real = chunk({ id: '3', symbolName: 'compile', tokenCount: 100, score: 5 });
    const scored = scoreChunks([getter, ctor, real], [], {});
    const byId = Object.fromEntries(scored.map(c => [c.id, c.score]));
    expect(byId['3']).toBeGreaterThan(byId['1']);
    expect(byId['3']).toBeGreaterThan(byId['2']);
  });
});
