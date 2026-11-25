import Database from 'better-sqlite3';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { discoverProject } from '../../core/workspace/discovery.js';
import { Command } from 'commander';
import {
  WorkspaceDaemon,
  workspaceStateDirectory,
  workspaceSocketPath
} from '../../core/workspace/daemon.js';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '../../utils/errors.js';
import {
  assertNoSymlinkInPath,
  removePrivateStateFile,
  preparePrivateStateFile
} from '../../utils/secure-state.js';
import { verifiedDaemonProcess } from '../utils/installation-setup.js';
import { getActiveUpgradeToken, isUpgradeInProgress } from '../../core/updater/upgrade-lock.js';

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

/** This path discovery deliberately never opens the migrating WorkspaceRegistry. */
function daemonPidPaths(all: boolean): string[] {
  const home = path.join(os.homedir(), '.contextos');
  const roots = new Set<string>();
  const input = process.env.CONTEXTOS_REPO_ROOT?.trim() || process.cwd();
  try {
    const canonical = fs.realpathSync(input);
    const discovery = discoverProject(canonical);
    const current = discovery.worktrees
      .filter(
        (tree) => canonical === tree.rootPath || canonical.startsWith(tree.rootPath + path.sep)
      )
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
    roots.add(current?.rootPath ?? canonical);
  } catch {
    roots.add(path.resolve(input));
  }
  if (all) {
    let db: Database.Database | undefined;
    try {
      const file = path.join(home, 'registry.db');
      if (fs.existsSync(file)) {
        db = new Database(file, { readonly: true });
        for (const table of ['repositories', 'legacy_repositories']) {
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
            continue;
          for (const row of db.prepare(`SELECT root_path FROM ${table}`).all() as {
            root_path: string;
          }[])
            roots.add(row.root_path);
        }
      }
    } finally {
      db?.close();
    }
    const legacy = path.join(home, 'workspaces.json');
    if (fs.existsSync(legacy)) {
      const workspaces = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Record<
        string,
        { repos?: string[] }
      >;
      for (const workspace of Object.values(workspaces))
        for (const root of workspace.repos ?? []) roots.add(root);
    }
  }
  return [
    ...new Set([
      path.join(workspaceStateDirectory('default'), 'daemon.pid'),
      ...Array.from(roots, (root) => path.join(root, '.contextos', 'daemon.pid'))
    ])
  ];
}

interface DaemonStatus {
  ok: boolean;
  pid: number;
  version: string;
  group: string;
}

async function readDaemonStatus(group?: string): Promise<DaemonStatus> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(workspaceSocketPath());
    let buffer = '';
    socket.setTimeout(1000, () => socket.destroy(new Error('Daemon status timed out')));
    socket.once('connect', () =>
      socket.write(JSON.stringify({ action: 'status', workspaceId: group }) + '\n')
    );
    socket.on('data', (data) => {
      buffer += data.toString('utf8');
      if (buffer.length > 8192) {
        socket.destroy(new Error('Daemon status response is too large'));
        return;
      }
      if (!buffer.includes('\n')) return;
      try {
        const status = JSON.parse(buffer.split('\n')[0]) as DaemonStatus;
        if (
          !status.ok ||
          !Number.isSafeInteger(status.pid) ||
          status.pid <= 0 ||
          typeof status.version !== 'string' ||
          typeof status.group !== 'string'
        )
          throw new Error('Invalid daemon status response');
        resolve(status);
      } catch (error) {
        reject(error);
      } finally {
        socket.destroy();
      }
    });
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('Daemon closed the status connection')));
  });
}

/** The status protocol identifies the daemon; verify process identity before every signal. */
async function replaceExistingDaemon(group: string): Promise<void> {
  let previous: DaemonStatus;
  try {
    previous = await readDaemonStatus(group);
  } catch {
    return;
  }
  const signal = (value: NodeJS.Signals) => {
    if (!verifiedDaemonProcess(previous.pid))
      throw new Error(
        `Cannot verify ContextOS daemon PID ${previous.pid}; stop it manually before retrying.`
      );
    try {
      process.kill(previous.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  signal('SIGTERM');
  if (!(await waitForProcessExit(previous.pid, 3000))) {
    signal('SIGKILL');
    if (!(await waitForProcessExit(previous.pid, 3000)))
      throw new Error(`Previous ContextOS daemon (PID ${previous.pid}) did not exit.`);
  }
  console.log(
    `Replaced previous ContextOS daemon (PID ${previous.pid}, version ${previous.version}, group ${previous.group}).`
  );
}

async function startDetached(group: string): Promise<void> {
  const logPath = preparePrivateStateFile(path.join(workspaceStateDirectory(group), 'daemon.log'));
  const log = fs.openSync(
    logPath,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_APPEND |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600
  );
  let child;
  try {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../../../bin/contextos.js', import.meta.url)),
        'daemon',
        'start',
        '--group',
        group
      ],
      {
        detached: true,
        stdio: ['ignore', log, log],
        env: process.env
      }
    );
  } finally {
    fs.closeSync(log);
  }
  let failure: Error | undefined;
  child.once('error', (error) => {
    failure = error;
  });
  child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        `Daemon failed to start: ${failure?.message ?? child.exitCode ?? child.signalCode}. Log: ${logPath}`
      );
    try {
      const status = await readDaemonStatus(group);
      // The CLI can re-exec (for example through the TypeScript launcher), so
      // the serving PID need not equal the spawned wrapper's PID.
      if (status.group === group) {
        console.log(
          `Daemon is RUNNING (PID ${status.pid}, version ${status.version}, group ${status.group})\nLog: ${logPath}`
        );
        return;
      }
    } catch {
      // The child may not have bound its socket yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill('SIGTERM');
  throw new Error(`Daemon did not report running within 15 seconds. Log: ${logPath}`);
}

export const daemonCommand = new Command('daemon').description(
  'Manage the ContextOS background daemon'
);

daemonCommand
  .command('start')
  .description('Start the ContextOS daemon for a project or workspace')
  .option('--group <name>', 'Group selector')
  .option('--workspace <name>', 'Alias for --group')
  .option('--detach', 'Run in the background and write output to the daemon log')
  .option('--background', 'Alias for --detach')
  .option(
    '--keep-existing',
    'Leave an already running daemon in place instead of replacing it (used for automatic starts)'
  )
  .action(
    async (options: {
      workspace?: string;
      group?: string;
      detach?: boolean;
      background?: boolean;
      keepExisting?: boolean;
    }) => {
      if (
        isUpgradeInProgress() &&
        process.env.CONTEXTOS_UPGRADE_TOKEN !== getActiveUpgradeToken()
      ) {
        throw new Error(
          'A ContextOS upgrade is in progress; wait for it to finish before starting a daemon.'
        );
      }
      const registry = new WorkspaceRegistry();
      let group: string;
      try {
        group = registry.workspace(options.group ?? options.workspace ?? 'default').name;
      } finally {
        registry.close();
      }
      if (options.keepExisting) {
        try {
          await readDaemonStatus(group);
          return;
        } catch {
          // No live daemon answered; fall through and start one.
        }
      } else {
        await replaceExistingDaemon(group);
      }
      if (options.detach || options.background) return startDetached(group);
      const daemon = new WorkspaceDaemon(group);
      await daemon.start();
      const cleanup = () => {
        void daemon.stop().then(() => process.exit(0));
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    }
  );

daemonCommand
  .command('stop')
  .description('Stop the shared daemon and an older daemon in the current project')
  .option('--group <name>', 'Group selector (the daemon is shared across groups)')
  .option('--workspace <name>', 'Alias for --group')
  .option('--all', 'Also stop legacy daemons found in registered projects')
  .action(async (options: { all?: boolean }) => {
    let found = false;
    for (const pidPath of daemonPidPaths(!!options.all)) {
      try {
        assertNoSymlinkInPath(pidPath);
        if (!fs.existsSync(pidPath)) continue;
        found = true;
        const pid = Number(fs.readFileSync(pidPath, 'utf8').trim());
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Daemon PID file is invalid.');
        try {
          process.kill(pid, 'SIGTERM');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        console.log(`Stopping daemon (PID ${pid}); waiting for active indexing to finish...`);
        if (!(await waitForProcessExit(pid, 30 * 60 * 1000))) {
          console.error(`Daemon (PID ${pid}) is still stopping; its state files were left intact.`);
          process.exitCode = 1;
          continue;
        }
        if (fs.existsSync(pidPath) && Number(fs.readFileSync(pidPath, 'utf8').trim()) === pid)
          removePrivateStateFile(pidPath);
        console.log(`Daemon (PID ${pid}) stopped.`);
      } catch (error) {
        console.error(`Failed to stop daemon: ${getErrorMessage(error)}`);
        process.exitCode = 1;
      }
    }
    if (!found) console.log('No ContextOS daemon found in the selected scope.');
  });

daemonCommand
  .command('status')
  .description('Check the status of the ContextOS daemon')
  .option('--group <name>', 'Group selector')
  .option('--workspace <name>', 'Alias for --group')
  .action(async (options: { group?: string; workspace?: string }) => {
    try {
      const status = await readDaemonStatus(options.group ?? options.workspace);
      console.log(
        `Daemon is RUNNING (PID ${status.pid}, version ${status.version}, group ${status.group})`
      );
    } catch (error) {
      console.log(`Daemon is NOT RUNNING or unavailable: ${getErrorMessage(error)}`);
    }
  });
