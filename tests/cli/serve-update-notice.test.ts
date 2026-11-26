import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../src/core/daemon/client.js', () => ({ runDaemonClient: vi.fn() }));
vi.mock('../../src/core/updater/index.js', () => ({
  checkForUpdates: vi.fn(),
  formatUpdateNotice: vi.fn()
}));
vi.mock('../../src/core/updater/auto-patch-policy.js', () => ({
  readAutoPatchPolicy: vi.fn(() => 'notify')
}));
vi.mock('../../src/cli/commands/upgrade.js', () => ({
  runAutoPatchBeforeServe: vi.fn(),
  formatAutoPatchNotice: vi.fn(),
  upgradeCommand: {}
}));

import { serveCommand } from '../../src/cli/commands/serve.js';
import { runDaemonClient } from '../../src/core/daemon/client.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import {
  checkForUpdates,
  formatUpdateNotice,
  type UpdateStatus
} from '../../src/core/updater/index.js';

describe('serve update notice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('checks once and writes an available update only to stderr before proxying', async () => {
    const oldCwd = process.cwd();
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-serve-'));
    const projectRoot = path.join(temporary, 'project');
    const home = path.join(temporary, 'home');
    fs.mkdirSync(projectRoot);
    fs.mkdirSync(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const registry = new WorkspaceRegistry();
    registry.register(projectRoot);
    registry.close();
    const oldUncaughtListeners = new Set(process.listeners('uncaughtException'));
    const oldRejectionListeners = new Set(process.listeners('unhandledRejection'));
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const notice = '[ContextOS] Update available: 1.0.2 → 1.0.3\n';
    vi.stubEnv('CONTEXTOS_REPO_ROOT', projectRoot);
    vi.mocked(checkForUpdates).mockResolvedValue({} as UpdateStatus);
    vi.mocked(formatUpdateNotice).mockReturnValue(notice);
    vi.mocked(runDaemonClient).mockResolvedValue();

    try {
      await serveCommand.parseAsync(['node', 'contextos']);

      expect(checkForUpdates).toHaveBeenCalledOnce();
      expect(formatUpdateNotice).toHaveBeenCalledOnce();
      expect(stderrWrite).toHaveBeenCalledWith(notice);
      expect(stdoutWrite).not.toHaveBeenCalled();
      expect(runDaemonClient).toHaveBeenCalledOnce();
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(temporary, { recursive: true, force: true });
      for (const listener of process.listeners('uncaughtException')) {
        if (!oldUncaughtListeners.has(listener))
          process.removeListener('uncaughtException', listener);
      }
      for (const listener of process.listeners('unhandledRejection')) {
        if (!oldRejectionListeners.has(listener)) {
          process.removeListener('unhandledRejection', listener);
        }
      }
    }
  });
});
