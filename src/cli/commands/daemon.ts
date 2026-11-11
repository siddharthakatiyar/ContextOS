import { Command } from 'commander';
import { ContextOSDaemon } from '../../core/daemon/daemon.js';
import fs from 'fs';
import path from 'path';
import { getErrorMessage } from '../../utils/errors.js';
import {
  assertNoSymlinkInPath,
  canonicalDirectory,
  removePrivateStateFile
} from '../../utils/secure-state.js';
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

export const daemonCommand = new Command('daemon').description(
  'Manage the ContextOS background daemon'
);

daemonCommand
  .command('start')
  .description('Start the ContextOS daemon for a project or workspace')
  .option('--workspace <name>', 'Workspace to serve')
  .action(async (options: { workspace?: string }) => {
    if (isUpgradeInProgress() && process.env.CONTEXTOS_UPGRADE_TOKEN !== getActiveUpgradeToken()) {
      throw new Error(
        'A ContextOS upgrade is in progress; wait for it to finish before starting a daemon.'
      );
    }
    if (options.workspace) {
      const { WorkspaceDaemon } = await import('../../core/workspace/daemon.js');
      const daemon = new WorkspaceDaemon(options.workspace);
      await daemon.start();
      const cleanup = () => {
        void daemon.stop().then(() => process.exit(0));
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
      return;
    }
    const envRoot = process.env.CONTEXTOS_REPO_ROOT?.trim();
    let projectDir = envRoot && envRoot.length > 1 ? envRoot : process.cwd();
    if (projectDir === '/') {
      const os = await import('os');
      projectDir = os.default.homedir();
    }

    try {
      const daemon = new ContextOSDaemon(projectDir);
      await daemon.start();
    } catch (error) {
      process.stderr.write(`Failed to start daemon: ${getErrorMessage(error)}\n`);
      process.exit(1);
    }
  });

daemonCommand
  .command('stop')
  .description('Stop the ContextOS daemon for the current project')
  .option('--workspace <name>', 'Workspace daemon')
  .action(async (options: { workspace?: string }) => {
    const projectDir = options.workspace
      ? (await import('../../core/workspace/daemon.js')).workspaceStateDirectory(options.workspace)
      : canonicalDirectory(process.cwd());
    const pidPath = path.join(projectDir, '.contextos', 'daemon.pid');

    try {
      assertNoSymlinkInPath(pidPath);
      if (fs.existsSync(pidPath)) {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Daemon PID file is invalid.');
        process.kill(pid, 'SIGTERM');
        console.log(`Stopping daemon (PID ${pid}); waiting for active indexing to finish...`);
        const stopped = await waitForProcessExit(pid, 30 * 60 * 1000);
        if (!stopped) {
          console.error(`Daemon (PID ${pid}) is still stopping; its state files were left intact.`);
          return;
        }
        if (
          fs.existsSync(pidPath) &&
          Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10) === pid
        ) {
          removePrivateStateFile(pidPath);
        }
        console.log(`Daemon (PID ${pid}) stopped.`);
      } else {
        console.log('No daemon is currently running for this project.');
      }
    } catch (error) {
      console.error(`Failed to stop daemon: ${getErrorMessage(error)}`);
    }
  });

daemonCommand
  .command('status')
  .description('Check the status of the ContextOS daemon')
  .option('--workspace <name>', 'Workspace daemon')
  .action(async (options: { workspace?: string }) => {
    const projectDir = options.workspace
      ? (await import('../../core/workspace/daemon.js')).workspaceStateDirectory(options.workspace)
      : canonicalDirectory(process.cwd());
    const pidPath = path.join(projectDir, '.contextos', 'daemon.pid');

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
