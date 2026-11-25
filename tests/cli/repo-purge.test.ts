import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { refreshWorkspaceDaemon } from '../../src/core/workspace/daemon.js';
import { repoCommand } from '../../src/cli/commands/repo.js';

vi.mock('../../src/core/workspace/daemon.js', () => ({ refreshWorkspaceDaemon: vi.fn() }));
let temporary: string;
beforeEach(() => {
  fs.mkdirSync(path.resolve('scratch'), { recursive: true });
  temporary = fs.mkdtempSync(path.resolve('scratch', 'purge-'));
  vi.spyOn(os, 'homedir').mockReturnValue(temporary);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('project purge group selection', () => {
  it.each(['--group', '--workspace'])('quiesces and resumes the selected %s', async (selector) => {
    vi.spyOn(WorkspaceRegistry.prototype, 'views').mockReturnValue([
      { repoId: 'view' }
    ] as ReturnType<WorkspaceRegistry['views']>);
    vi.spyOn(WorkspaceRegistry.prototype, 'purgeProject').mockImplementation(() => {
      throw new Error('busy');
    });
    await expect(
      repoCommand.parseAsync([
        'node',
        'contextos',
        'remove',
        'project',
        '--purge',
        selector,
        'payments'
      ])
    ).rejects.toThrow('busy');
    expect(vi.mocked(refreshWorkspaceDaemon).mock.calls.slice(-2)).toEqual([
      ['payments', 'quiesce', ['view']],
      ['payments', 'resume', ['view']]
    ]);
  });
});
