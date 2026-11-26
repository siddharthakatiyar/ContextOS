import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { buildCompressCtx, packToBudget } from '../../src/core/compiler/compressor.js';
import { SentRegistry } from '../../src/core/session/sent-registry.js';
import type { ScoredChunk } from '../../src/core/retrieval/types.js';

vi.mock('../../src/config/index.js', () => ({ loadConfig: vi.fn() }));

function chunk(id: string): ScoredChunk {
  return {
    id,
    repoId: 'real-project-view',
    sourceFile: `${id}.ts`,
    content: `export function ${id}() { return "${id} implementation body"; }`,
    score: 10,
    tokenCount: 20,
    layer: 'repo',
    workspaceName: null,
    sectionTitle: null,
    sectionDepth: 0,
    summary: null,
    keywords: null,
    hash: `${id}-hash`,
    importance: 1,
    createdAt: 1,
    updatedAt: 1,
    symbolName: id,
    symbolKind: 'function'
  };
}

afterEach(() => vi.clearAllMocks());

describe('sentDedupEnabled in compiler packing', () => {
  it('retains an already-sent companion body and does not mark new sends when disabled', () => {
    vi.mocked(loadConfig).mockReturnValue({ ...defaultConfig, sentDedupEnabled: false });
    const sent = new SentRegistry();
    const leader = chunk('leader');
    const companion = chunk('companion');
    sent.markSent(`${companion.repoId}:${companion.hash}`);
    const ctx = buildCompressCtx([], new Set());
    ctx.opts = { sentRegistry: sent };

    const packed = packToBudget([leader, companion], [], 1000, leader.sourceFile, ctx);

    expect(packed.find((item) => item.id === companion.id)?.content).toBe(companion.content);
    expect(packed.find((item) => item.id === companion.id)?.summary).not.toBe('[stub]');
    expect(sent.hasBeenSent(`${leader.repoId}:${leader.hash}`)).toBe(false);
  });

  it('suppresses an already-sent companion and tracks the leader when enabled', () => {
    vi.mocked(loadConfig).mockReturnValue({ ...defaultConfig, sentDedupEnabled: true });
    const sent = new SentRegistry();
    const leader = chunk('leader');
    const companion = chunk('companion');
    sent.markSent(`${companion.repoId}:${companion.hash}`);
    const ctx = buildCompressCtx([], new Set());
    ctx.opts = { sentRegistry: sent };

    const packed = packToBudget([leader, companion], [], 1000, leader.sourceFile, ctx);

    expect(packed.find((item) => item.id === companion.id)?.summary).toBe('[stub]');
    expect(sent.hasBeenSent(`${leader.repoId}:${leader.hash}`)).toBe(true);
  });

  it('preserves the explicit per-call registry opt-out when deduplication is enabled', () => {
    vi.mocked(loadConfig).mockReturnValue({ ...defaultConfig, sentDedupEnabled: true });
    const leader = chunk('leader');
    const companion = chunk('companion');
    const ctx = buildCompressCtx([], new Set());
    ctx.opts = { sentRegistry: null };

    const packed = packToBudget([leader, companion], [], 1000, leader.sourceFile, ctx);

    expect(packed.find((item) => item.id === companion.id)?.content).toBe(companion.content);
  });
});
