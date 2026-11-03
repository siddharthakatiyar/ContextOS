import { Command } from 'commander';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDaemonClient } from '../../core/daemon/client.js';
import { checkForUpdates, formatUpdateNotice } from '../../core/updater/index.js';
import { readAutoPatchPolicy } from '../../core/updater/auto-patch-policy.js';
import { formatAutoPatchNotice, runAutoPatchBeforeServe } from './upgrade.js';

export const AUTO_PATCH_REEXEC_ENV = 'CONTEXTOS_AUTO_PATCH_REEXEC';

function findInstalledPackageRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')) as {
        name?: string;
      };
      if (manifest.name === '@siddharthakatiyar/contextos') return current;
    } catch {
      // Continue through the compiled package layout.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate the installed ContextOS package.');
    current = parent;
  }
}

/** Launch the new CLI with the same Node flags, arguments, environment, and stdio. */
export async function relaunchUpdatedServe(targetVersion: string): Promise<void> {
  const fail = (reason: string) => {
    process.stderr.write(
      `[ContextOS] Updated the package to ${targetVersion}, but the new CLI could not start (${reason}). No MCP server was started. Resolve the install issue, then run \`contextos serve\` again.\n`
    );
    process.exitCode = 1;
  };

  let child: childProcess.ChildProcess;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    const packageRoot = findInstalledPackageRoot(path.dirname(modulePath));
    const cliPath = path.join(packageRoot, 'dist', 'bin', 'contextos.js');
    child = childProcess.spawn(
      process.execPath,
      [...process.execArgv, cliPath, ...process.argv.slice(2)],
      {
        cwd: process.cwd(),
        env: { ...process.env, [AUTO_PATCH_REEXEC_ENV]: '1' },
        stdio: 'inherit'
      }
    );
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let spawned = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('spawn', () => {
      spawned = true;
    });
    child.once('error', (error) => {
      if (settled) return;
      fail(error.message);
      finish();
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      if (!spawned || code !== 0 || signal !== null) {
        fail(`exit ${code ?? 'unknown'}${signal ? `, signal ${signal}` : ''}`);
      } else {
        process.exitCode = 0;
      }
      finish();
    });
  });
}

export const serveCommand = new Command('serve')
  .description('Start the ContextOS MCP server (stdio)')
  .action(async () => {
    // Use CONTEXTOS_REPO_ROOT env var if set (MCP clients often spawn with CWD=/)
    const envRoot = process.env.CONTEXTOS_REPO_ROOT?.trim();
    let projectDir = envRoot && envRoot.length > 1 ? envRoot : process.cwd();

    // If CWD is root (/) — which happens when MCP clients don't set CWD —
    // fall back to home directory to avoid writing to filesystem root
    if (projectDir === '/') {
      const os = await import('os');
      projectDir = os.default.homedir();
    }

    // Change into the project directory so all path resolution works correctly
    try {
      process.chdir(projectDir);
    } catch {
      // If we can't chdir, continue with whatever cwd we have
    }

    // Provide stdout/stderr handlers to prevent crashing
    process.on('uncaughtException', (err) => {
      process.stderr.write(`ContextOS uncaught exception: ${err.message}\n`);
    });
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`ContextOS unhandled rejection: ${reason}\n`);
    });

    const wasAutoPatchReexec = process.env[AUTO_PATCH_REEXEC_ENV] === '1';
    delete process.env[AUTO_PATCH_REEXEC_ENV];
    if (!wasAutoPatchReexec && readAutoPatchPolicy() === 'auto-patch') {
      const result = await runAutoPatchBeforeServe();
      if (result.status === 'skipped' && !result.latestVersion && !result.registryCheckAttempted) {
        const updateNotice = formatUpdateNotice(await checkForUpdates());
        if (updateNotice) process.stderr.write(updateNotice);
      }
      const notice = formatAutoPatchNotice(result);
      if (notice) process.stderr.write(notice);
      if (result.status === 'updated') {
        await relaunchUpdatedServe(result.targetVersion);
        return;
      }
    } else if (!wasAutoPatchReexec) {
      const updateNotice = formatUpdateNotice(await checkForUpdates());
      if (updateNotice) process.stderr.write(updateNotice);
    }

    // Serve now just connects to the daemon or spawns it
    await runDaemonClient(projectDir);
  });
