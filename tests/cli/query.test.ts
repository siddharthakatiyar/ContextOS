import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
    retrieve = vi.fn().mockResolvedValue({
      chunks: [],
      intent: { concepts: ['test'], identifiers: [], intentType: 'general', rawPrompt: 'test' },
      expandedEntities: [],
      latencyMs: 10
    });
  }
}));

vi.mock('../../src/core/compiler/index.js', () => ({
  compile: vi.fn(() => ({ output: 'Compiled result', tokenCount: 10 }))
}));

describe('CLI query command', () => {
  let consoleLogSpy: any;

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
    const calls = consoleLogSpy.mock.calls.map((call: any) => call.join(' '));
    expect(calls.some((c: string) => c.includes('Intent Detection'))).toBe(true);
    expect(calls.some((c: string) => c.includes('Compiled Context'))).toBe(true);
  });
});
