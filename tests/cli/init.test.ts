import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { initCommand } from '../../src/cli/commands/init.js';

// Mock dependencies that we don't want to actually run in the init test
vi.mock('../../src/core/indexer/index.js', () => ({
  Indexer: class {
    indexFile = vi
      .fn()
      .mockResolvedValue({ processed: 0, chunksCreated: 0, relationshipsFound: 0, durationMs: 0 });
  }
}));

vi.mock('../../src/core/storage/database.js', () => ({
  DB: class {
    close = vi.fn();
    getInstance = vi.fn();
  },
  getContextOSHome: vi.fn(() => path.join(os.tmpdir(), 'contextos-home-test'))
}));

vi.mock('../../src/config/index.js', () => ({
  loadConfig: vi.fn(() => ({ indexablePatterns: ['**/*.ts'] }))
}));

vi.mock('glob', () => ({
  glob: vi.fn(() => Promise.resolve([]))
}));

vi.mock('../../src/mcp/cursor/config-generator.js', () => ({
  generateCursorConfig: vi.fn(() => ({ mcpServers: {} }))
}));

describe('CLI init command', () => {
  let tmpCwd: string;
  let originalCwd: () => string;
  let homedirSpy: any;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-cli-init-'));
    originalCwd = process.cwd;
    process.cwd = () => tmpCwd;

    originalHome = process.env.HOME;
    process.env.HOME = tmpCwd;

    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpCwd);

    const globalHome = path.join(os.tmpdir(), 'contextos-home-test');
    if (fs.existsSync(globalHome)) {
      fs.rmSync(globalHome, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    process.cwd = originalCwd;
    process.env.HOME = originalHome;
    homedirSpy.mockRestore();
    try {
      fs.rmSync(tmpCwd, { recursive: true, force: true });
    } catch {}
  });

  it('creates local .contextos directory and global home', async () => {
    // Suppress console output for the test
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    // We mock glob to return nothing so it finishes quickly
    await initCommand.parseAsync(['node', 'test']);

    const repoContextDir = path.join(tmpCwd, '.contextos');
    const globalContextDir = path.join(os.tmpdir(), 'contextos-home-test', 'global');

    expect(fs.existsSync(repoContextDir)).toBe(true);
    expect(fs.existsSync(globalContextDir)).toBe(true);

    const defaultGlobalDoc = path.join(globalContextDir, 'engineering.md');
    expect(fs.existsSync(defaultGlobalDoc)).toBe(true);

    consoleSpy.mockRestore();
  });
});
