import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { workspaceStateDirectory } from '../../src/core/workspace/daemon.js';

describe('daemon stop command', () => {
  const originalCwd = process.cwd();
  let home: string;
  let projectDir: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    process.chdir(originalCwd);
    homedirSpy?.mockRestore();
    vi.restoreAllMocks();
    if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true });
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  it('can stop legacy project daemons without constructing or migrating their registry', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-legacy-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-legacy-project-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const contextHome = path.join(home, '.contextos');
    fs.mkdirSync(contextHome);
    const legacyRoot = path.join(projectDir, 'legacy');
    fs.mkdirSync(path.join(legacyRoot, '.contextos'), { recursive: true });
    const pidPath = path.join(legacyRoot, '.contextos', 'daemon.pid');
    fs.writeFileSync(pidPath, '44322');
    const registry = new Database(path.join(contextHome, 'registry.db'));
    registry.exec(
      'CREATE TABLE repositories (root_path TEXT); CREATE TABLE indexing_leases (entity_id TEXT,owner TEXT);'
    );
    registry.prepare('INSERT INTO repositories VALUES (?)').run(legacyRoot);
    registry
      .prepare('INSERT INTO indexing_leases VALUES (?,?)')
      .run('old-owner', JSON.stringify({ pid: 44322 }));
    registry.close();
    process.chdir(projectDir);
    const stopped: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: NodeJS.Signals | number
    ) => {
      if (signal === 'SIGTERM') {
        stopped.push(pid);
        return true;
      }
      if (signal === 0) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await daemonCommand.parseAsync(['node', 'contextos', 'stop', '--all']);
    expect(stopped).toEqual([44322]);
    expect(fs.existsSync(pidPath)).toBe(false);
    const unchanged = new Database(path.join(contextHome, 'registry.db'), { readonly: true });
    try {
      expect(
        unchanged.prepare("SELECT name FROM sqlite_master WHERE name='projects'").get()
      ).toBeUndefined();
    } finally {
      unchanged.close();
    }
  });

  it('keeps the global PID file until the daemon has drained and exited', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-daemon-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-daemon-project-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    process.chdir(projectDir);

    const runtimeDir = workspaceStateDirectory('default');
    const pidPath = path.join(runtimeDir, 'daemon.pid');
    const daemonPid = 44_321;
    fs.writeFileSync(pidPath, String(daemonPid));

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
        if (pollCount >= 2) throw Object.assign(new Error('No such process'), { code: 'ESRCH' });
      }
      return true;
    }) as typeof process.kill);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await daemonCommand.parseAsync(['node', 'contextos', 'stop']);

    expect(pidFilePresentWhileWaiting).toBe(true);
    expect(fs.existsSync(pidPath)).toBe(false);
    expect(path.dirname(pidPath)).toBe(path.join(home, '.contextos', 'runtime'));
    expect(fs.existsSync(path.join(projectDir, '.contextos'))).toBe(false);
  });
});
