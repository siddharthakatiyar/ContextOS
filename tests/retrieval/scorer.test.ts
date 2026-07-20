import { describe, it, expect } from 'vitest';
import {
  scoreChunks,
  applyPoisonPenalty,
  applyWorkspacePenalty,
  applyNoiseDemotion,
  applyGenericAdjustments
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
    ...partial
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
      workspaceName: '/other/project'
    });
    const ctx = {
      repoRoot: '/Volumes/ExtremeSSD/code/contextOS',
      matchTokens: [] as string[],
      identifiers: new Set<string>()
    };
    expect(applyWorkspacePenalty(foreign, 10, ctx)).toBeCloseTo(3);
  });

  it('applyNoiseDemotion demotes tests and README', () => {
    expect(applyNoiseDemotion(chunk({ id: '1', sourceFile: 'src/foo.test.ts' }), 10)).toBeCloseTo(
      5.5
    );
    expect(applyNoiseDemotion(chunk({ id: '2', sourceFile: 'README.md' }), 10)).toBeCloseTo(4);
    expect(applyNoiseDemotion(chunk({ id: '3', sectionTitle: 'File Structure' }), 10)).toBeCloseTo(
      4.5
    );
  });

  it('applyGenericAdjustments is symbol-name neutral (no hardcoded dedup/watcher boosts)', () => {
    const ctx = {
      repoRoot: '/x',
      matchTokens: ['deduplicate'],
      identifiers: new Set<string>()
    };
    const retrieve = chunk({ id: '1', symbolName: 'retrieve', score: 10 });
    const genericChunk = chunk({ id: '2', symbolName: 'someFunction', score: 10 });
    // Without the hardcoded logic, retrieve should not get an artificial 3.2x boost just because "deduplicate" is in the prompt
    expect(applyGenericAdjustments(retrieve, 10, ctx)).toBe(10);
    expect(applyGenericAdjustments(genericChunk, 10, ctx)).toBe(10);
  });
});

describe('scoreChunks', () => {
  it('accepts optional repoRoot instead of process.cwd()', () => {
    const foreign = chunk({
      id: '1',
      layer: 'workspace',
      workspaceName: '/other/project',
      score: 10
    });
    const scored = scoreChunks(
      [foreign],
      [],
      {},
      { repoRoot: '/Volumes/ExtremeSSD/code/contextOS' }
    );
    expect(scored[0].score).toBeLessThan(10);
  });

  it('boosts exact symbolName match to prompt tokens', () => {
    const hit = chunk({ id: '1', symbolName: 'extractRelationships', score: 1 });
    const miss = chunk({ id: '2', symbolName: 'unrelatedHelper', score: 1 });
    const scored = scoreChunks([hit, miss], [], {}, { matchTokens: ['extractRelationships'] });
    expect(scored[0].id).toBe('1');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });

  it('produces identical ordering on two calls with the same input (deterministic)', () => {
    // Build chunks that will land on equal RRF-ish float scores after scoreChunks
    // multipliers — the only difference between runs should be the tiebreaker.
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk({ id: `chunk-${String(i).padStart(3, '0')}`, score: 5, symbolName: `fn${i}` })
    );
    const run1 = scoreChunks([...chunks], [], {}).map((c) => c.id);
    const run2 = scoreChunks([...chunks], [], {}).map((c) => c.id);
    expect(run1).toEqual(run2);
  });

  it('skips diversity decay when diversityFilter is false', () => {
    // Feed 10 chunks from the same file — with diversity enabled the later ones
    // get penalised; with it disabled, scores should remain unchanged.
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk({ id: `f${i}`, sourceFile: 'src/big.ts', score: 5 })
    );
    const withDiversity = scoreChunks([...chunks], [], {}, { diversityFilter: true });
    const noDiversity = scoreChunks([...chunks], [], {}, { diversityFilter: false });

    // With diversity the last few chunks are demoted; without it they keep their score
    const lastWithDiv = withDiversity[withDiversity.length - 1].score;
    const lastNoDivScore = noDiversity[noDiversity.length - 1].score;
    expect(lastNoDivScore).toBeGreaterThan(lastWithDiv);
  });
});
