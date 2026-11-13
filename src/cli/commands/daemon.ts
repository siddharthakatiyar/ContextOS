import Database from 'better-sqlite3';
import os from 'node:os';
import { discoverProject } from '../../core/workspace/discovery.js';
import { Command } from 'commander';
import { WorkspaceDaemon, workspaceStateDirectory } from '../../core/workspace/daemon.js';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '../../utils/errors.js';
import { assertNoSymlinkInPath, removePrivateStateFile } from '../../utils/secure-state.js';
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

export const daemonCommand = new Command('daemon').description(
  'Manage the ContextOS background daemon'
);

daemonCommand
  .command('start')
  .description('Start the ContextOS daemon for a project or workspace')
  .option('--workspace <name>', 'Group to validate at startup')
  .option('--group <name>', 'Group to validate at startup')
  .action(async (options: { workspace?: string; group?: string }) => {
    if (isUpgradeInProgress() && process.env.CONTEXTOS_UPGRADE_TOKEN !== getActiveUpgradeToken()) {
      throw new Error(
        'A ContextOS upgrade is in progress; wait for it to finish before starting a daemon.'
      );
    }
    const daemon = new WorkspaceDaemon(options.group ?? options.workspace ?? 'default');
    await daemon.start();
    const cleanup = () => {
      void daemon.stop().then(() => process.exit(0));
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  });

daemonCommand
  .command('stop')
  .description('Stop the shared daemon and an older daemon in the current project')
  .option('--workspace <name>', 'Compatibility group selector')
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
  .option('--workspace <name>', 'Workspace daemon')
  .action(async () => {
    const pidPath = path.join(workspaceStateDirectory('default'), 'daemon.pid');

    try {
      assertNoSymlinkInPath(pidPath);
      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
        process.kill(pid, 0); // test if alive
        console.log(`Daemon is RUNNING (PID ${pid})`);
      } else {
        console.log('Daemon is NOT RUNNING.');
      }
    } catch {
      console.log('Daemon is NOT RUNNING (state path is unavailable or unsafe).');
    }
  });
