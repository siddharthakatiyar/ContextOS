import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daemonCommand } from '../../src/cli/commands/daemon.js';

describe('daemon stop command', () => {
  const originalCwd = process.cwd();
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the PID file until the daemon has finished draining and exited', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-daemon-stop-'));
    temporaryDirectories.push(projectDir);
    const contextDir = path.join(projectDir, '.contextos');
    fs.mkdirSync(contextDir);
    const pidPath = path.join(contextDir, 'daemon.pid');
    const daemonPid = 44_321;
    fs.writeFileSync(pidPath, String(daemonPid));
    process.chdir(projectDir);

    let pollCount = 0;
    let pidFilePresentWhileWaiting = false;
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      if (pid !== daemonPid) return true;
      if (signal === 'SIGTERM') return true;
      if (signal === 0) {
        pollCount++;
        pidFilePresentWhileWaiting ||= fs.existsSync(pidPath);
        if (pollCount >= 2) {
          throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
        }
        return true;
      }
      return true;
    }) as typeof process.kill);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await daemonCommand.parseAsync(['node', 'contextos', 'stop']);

    expect(pidFilePresentWhileWaiting).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
  });
});
