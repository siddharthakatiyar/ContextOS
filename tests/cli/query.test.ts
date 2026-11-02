import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { queryCommand } from '../../src/cli/commands/query.js';

vi.mock('../../src/core/storage/database.js', () => ({
  DB: {
    resolveDatabases: vi.fn(() => [
      {
        getInstance: vi.fn(),
        prepare: vi.fn(),
        exec: vi.fn(),
        close: vi.fn()
      }
    ])
  },
  getContextOSHome: vi.fn(() => '/mock/home')
}));

vi.mock('../../src/core/storage/chunks-repo.js', () => ({
  ChunksRepo: class {}
}));

vi.mock('../../src/core/storage/relationships-repo.js', () => ({
  RelationshipsRepo: class {}
}));

vi.mock('../../src/core/storage/prompts-repo.js', () => ({
  PromptsRepo: class {}
}));

vi.mock('../../src/core/session/session-store.js', () => ({
  SessionStore: class {
    addEvent = vi.fn();
  }
}));

vi.mock('../../src/core/session/index.js', () => ({
  SessionManager: class {
    getSessionId = vi.fn(() => '1234');
    getSessionContext = vi.fn().mockResolvedValue([]);
  }
}));

vi.mock('../../src/core/retrieval/index.js', () => ({
  RetrievalEngine: class {
    retrieve = vi.fn().mockImplementation((_prompt: string, options?: { explain?: boolean }) =>
      Promise.resolve({
        chunks: [],
        intent: { concepts: ['test'], identifiers: [], intentType: 'general', rawPrompt: 'test' },
        expandedEntities: [],
        latencyMs: 10,
        ...(options?.explain
          ? {
              explanation: {
                embeddingSearch: {
                  configured: false,
                  lowConfidenceFallback: true,
                  available: false,
                  searched: false,
                  hitCount: null
                },
                graphExpansionEnabled: true,
                chunks: {}
              }
            }
          : {})
      })
    );
  }
}));

vi.mock('../../src/core/compiler/index.js', () => ({
  compile: vi.fn((_result: unknown, options?: { explain?: boolean }) => ({
    output: 'Compiled result',
    tokenCount: 10,
    ...(options?.explain
      ? {
          diagnostics: {
            tier: 'explore',
            outputFormat: 'markdown',
            configuredMaxTokens: 1000,
            effectiveMaxTokens: 1000,
            firstPassChunkBudget: 952,
            framingReserve: 48,
            signalTerms: ['test'],
            includedChunks: [],
            omittedChunkIds: []
          }
        }
      : {})
  }))
}));

describe('CLI query command', () => {
  let consoleLogSpy: MockInstance;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
  });

  it('runs query and outputs result', async () => {
    await queryCommand.parseAsync(['node', 'test', 'how does indexing work?']);

    // Check if console.log was called which signifies command executed properly
    expect(consoleLogSpy).toHaveBeenCalled();
    const calls = consoleLogSpy.mock.calls.map((call) => call.join(' '));
    expect(calls.some((c: string) => c.includes('Intent Detection'))).toBe(true);
    expect(calls.some((c: string) => c.includes('Compiled Context'))).toBe(true);
  });

  it('adds retrieval and compilation diagnostics only when --explain is requested', async () => {
    await queryCommand.parseAsync(['node', 'test', '--json', '--explain', 'test prompt']);

    const jsonOutput = consoleLogSpy.mock.calls.map((call) => call.join(' ')).at(-1);
    const parsed = JSON.parse(String(jsonOutput));
    expect(Object.keys(parsed)).toEqual([
      'intent',
      'latencyMs',
      'chunks',
      'expandedEntities',
      'context',
      'tokens',
      'explanation'
    ]);
    expect(parsed.explanation.retrieval.embeddingSearch).toMatchObject({
      configured: false,
      searched: false,
      hitCount: null
    });
    expect(parsed.explanation.compilation).toMatchObject({
      tier: 'explore',
      effectiveMaxTokens: 1000,
      includedChunks: []
    });
  });

  it('keeps the ordinary JSON response keys unchanged', async () => {
    await queryCommand.parseAsync(['node', 'test', '--json', 'test prompt']);

    const jsonOutput = consoleLogSpy.mock.calls.map((call) => call.join(' ')).at(-1);
    const parsed = JSON.parse(String(jsonOutput));
    expect(Object.keys(parsed)).toEqual([
      'intent',
      'latencyMs',
      'chunks',
      'expandedEntities',
      'context',
      'tokens'
    ]);
  });
});
