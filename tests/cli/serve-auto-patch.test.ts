import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';

vi.mock('../../src/core/daemon/client.js', () => ({ runDaemonClient: vi.fn() }));
vi.mock('../../src/core/updater/index.js', () => ({
  checkForUpdates: vi.fn(),
  formatUpdateNotice: vi.fn()
}));
vi.mock('../../src/core/updater/auto-patch-policy.js', () => ({ readAutoPatchPolicy: vi.fn() }));
vi.mock('../../src/cli/commands/upgrade.js', () => ({
  runAutoPatchBeforeServe: vi.fn(),
  formatAutoPatchNotice: vi.fn()
}));
import { runDaemonClient } from '../../src/core/daemon/client.js';
import {
  checkForUpdates,
  formatUpdateNotice,
  type UpdateStatus
} from '../../src/core/updater/index.js';
import { readAutoPatchPolicy } from '../../src/core/updater/auto-patch-policy.js';
import { AUTO_PATCH_REEXEC_ENV, serveCommand } from '../../src/cli/commands/serve.js';
import { formatAutoPatchNotice, runAutoPatchBeforeServe } from '../../src/cli/commands/upgrade.js';

describe('serve auto-patch policy and restart flow', () => {
  let originalCwd: string;
  let originalExitCode: typeof process.exitCode;
  let oldUncaughtListeners: Set<(...args: never[]) => void>;
  let oldRejectionListeners: Set<(...args: never[]) => void>;

  beforeEach(() => {
    originalCwd = process.cwd();
    originalExitCode = process.exitCode;
    oldUncaughtListeners = new Set(process.listeners('uncaughtException'));
    oldRejectionListeners = new Set(process.listeners('unhandledRejection'));
    vi.mocked(runDaemonClient).mockReset().mockResolvedValue();
    vi.mocked(checkForUpdates).mockReset();
    vi.mocked(formatUpdateNotice).mockReset();
    vi.mocked(readAutoPatchPolicy).mockReset();
    vi.mocked(runAutoPatchBeforeServe).mockReset();
    vi.mocked(formatAutoPatchNotice).mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const listener of process.listeners('uncaughtException')) {
      if (!oldUncaughtListeners.has(listener))
        process.removeListener('uncaughtException', listener);
    }
    for (const listener of process.listeners('unhandledRejection')) {
      if (!oldRejectionListeners.has(listener))
        process.removeListener('unhandledRejection', listener);
    }
  });

  it('keeps the default notify policy install-free and writes notices only to stderr', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const notice = '[ContextOS] Update available: 1.2.3 → 1.2.4\n';
    vi.stubEnv('CONTEXTOS_REPO_ROOT', originalCwd);
    vi.mocked(readAutoPatchPolicy).mockReturnValue('notify');
    vi.mocked(checkForUpdates).mockResolvedValue({} as UpdateStatus);
    vi.mocked(formatUpdateNotice).mockReturnValue(notice);

    await serveCommand.parseAsync(['node', 'contextos']);

    expect(runAutoPatchBeforeServe).not.toHaveBeenCalled();
    expect(runDaemonClient).toHaveBeenCalledOnce();
    expect(stderrWrite).toHaveBeenCalledWith(notice);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('falls back to a passive update notice when automatic installation is safely skipped', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const updateNotice = '[ContextOS] Update available: 1.2.3 → 1.2.4\n';
    const skipNotice = '[ContextOS] Automatic patch update skipped: Linux global npm only.\n';
    const status = { status: 'update_available' } as UpdateStatus;
    vi.stubEnv('CONTEXTOS_REPO_ROOT', originalCwd);
    vi.mocked(readAutoPatchPolicy).mockReturnValue('auto-patch');
    vi.mocked(runAutoPatchBeforeServe).mockResolvedValue({
      status: 'skipped',
      currentVersion: '1.2.3',
      reason: 'Automatic package installation is supported on Linux only.'
    });
    vi.mocked(checkForUpdates).mockResolvedValue(status);
    vi.mocked(formatUpdateNotice).mockReturnValue(updateNotice);
    vi.mocked(formatAutoPatchNotice).mockReturnValue(skipNotice);

    await serveCommand.parseAsync(['node', 'contextos']);

    expect(runAutoPatchBeforeServe).toHaveBeenCalledOnce();
    expect(checkForUpdates).toHaveBeenCalledOnce();
    expect(formatUpdateNotice).toHaveBeenCalledWith(status);
    expect(stderrWrite).toHaveBeenCalledWith(updateNotice);
    expect(stderrWrite).toHaveBeenCalledWith(skipNotice);
    expect(runDaemonClient).toHaveBeenCalledOnce();
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('does not repeat a passive registry check after the auto-patch coordinator already checked', async () => {
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('CONTEXTOS_REPO_ROOT', originalCwd);
    vi.mocked(readAutoPatchPolicy).mockReturnValue('auto-patch');
    vi.mocked(runAutoPatchBeforeServe).mockResolvedValue({
      status: 'skipped',
      currentVersion: '1.2.3',
      registryCheckAttempted: true,
      reason: 'Automatic patch update failed; continuing with the installed version.'
    });
    vi.mocked(formatAutoPatchNotice).mockReturnValue('skip notice\n');

    await serveCommand.parseAsync(['node', 'contextos']);

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith('skip notice\n');
    expect(runDaemonClient).toHaveBeenCalledOnce();
  });

  it('relaunches once after a patch and lets the re-exec proceed without another update attempt', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const notice = '[ContextOS] Updated from 1.2.3 to 1.2.4; restarting before serving.\n';
    vi.stubEnv('CONTEXTOS_REPO_ROOT', originalCwd);
    vi.mocked(readAutoPatchPolicy).mockReturnValue('auto-patch');
    vi.mocked(runAutoPatchBeforeServe).mockResolvedValue({
      status: 'updated',
      currentVersion: '1.2.3',
      targetVersion: '1.2.4'
    });
    vi.mocked(formatAutoPatchNotice).mockReturnValue(notice);
    const child = new EventEmitter();
    const spawn = vi
      .spyOn(childProcess, 'spawn')
      .mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);

    const firstServe = serveCommand.parseAsync(['node', 'contextos']);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const spawnOptions = spawn.mock.calls[0]?.[2] as childProcess.SpawnOptions;
    expect(spawnOptions.env?.[AUTO_PATCH_REEXEC_ENV]).toBe('1');
    expect(spawnOptions.stdio).toBe('inherit');
    child.emit('spawn');
    child.emit('close', 0, null);
    await firstServe;

    expect(runAutoPatchBeforeServe).toHaveBeenCalledOnce();
    expect(runDaemonClient).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(notice);
    expect(stdoutWrite).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    vi.stubEnv(AUTO_PATCH_REEXEC_ENV, '1');
    await serveCommand.parseAsync(['node', 'contextos']);

    expect(runAutoPatchBeforeServe).toHaveBeenCalledOnce();
    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(runDaemonClient).toHaveBeenCalledOnce();
  });

  it('surfaces child spawn failure and never serves with the old loaded CLI after an update', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('CONTEXTOS_REPO_ROOT', originalCwd);
    vi.mocked(readAutoPatchPolicy).mockReturnValue('auto-patch');
    vi.mocked(runAutoPatchBeforeServe).mockResolvedValue({
      status: 'updated',
      currentVersion: '1.2.3',
      targetVersion: '1.2.4'
    });
    vi.mocked(formatAutoPatchNotice).mockReturnValue('');
    const child = new EventEmitter();
    const spawn = vi
      .spyOn(childProcess, 'spawn')
      .mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);

    const serving = serveCommand.parseAsync(['node', 'contextos']);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit('error', new Error('spawn denied'));
    await serving;

    expect(runAutoPatchBeforeServe).toHaveBeenCalledOnce();
    expect(runDaemonClient).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('spawn denied'));
    expect(process.exitCode).toBe(1);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it('surfaces a nonzero child exit without connecting through the old CLI', async () => {
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrWrite = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('CONTEXTOS_REPO_ROOT', originalCwd);
    vi.mocked(readAutoPatchPolicy).mockReturnValue('auto-patch');
    vi.mocked(runAutoPatchBeforeServe).mockResolvedValue({
      status: 'updated',
      currentVersion: '1.2.3',
      targetVersion: '1.2.4'
    });
    vi.mocked(formatAutoPatchNotice).mockReturnValue('');
    const child = new EventEmitter();
    const spawn = vi
      .spyOn(childProcess, 'spawn')
      .mockReturnValue(child as unknown as ReturnType<typeof childProcess.spawn>);

    const serving = serveCommand.parseAsync(['node', 'contextos']);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.emit('spawn');
    child.emit('close', 23, null);
    await serving;

    expect(runDaemonClient).not.toHaveBeenCalled();
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining('exit 23'));
    expect(process.exitCode).toBe(1);
    expect(stdoutWrite).not.toHaveBeenCalled();
  });
});
