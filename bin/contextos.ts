#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageManifest(start: string): { path: string; version: string } {
  let current = path.resolve(start);
  while (true) {
    const manifestPath = path.join(current, 'package.json');
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (manifest.name === '@siddharthakatiyar/contextos' && manifest.version) {
        return { path: manifestPath, version: manifest.version };
      }
    } catch {
      // Keep walking through dist/source layouts.
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error('Could not locate ContextOS package metadata.');
    current = parent;
  }
}

function skipsStartupNotice(args: string[]): boolean {
  const commands = new Set([
    'init',
    'setup',
    'enable',
    'serve',
    'query',
    'workspace',
    'repo',
    'project',
    'group',
    'worktree',
    'watch',
    'export',
    'import',
    'analytics',
    'status',
    'doctor',
    'reindex',
    'clean',
    'daemon',
    'visualize',
    'upgrade',
    'update',
    'updates'
  ]);
  const commandIndex = args.findIndex((arg) => commands.has(arg));
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  return (
    command === 'doctor' ||
    command === 'enable' ||
    command === 'setup' ||
    command === 'upgrade' ||
    command === 'update' ||
    command === 'updates' ||
    command === 'serve' ||
    args.includes('--version') ||
    args.includes('-V') ||
    args.includes('--help') ||
    args.includes('-h') ||
    (command === 'daemon' && args[commandIndex + 1] === 'start')
  );
}

function skipsFirstUseAutoPatchNotice(args: string[]): boolean {
  const maintenanceCommands = new Set([
    'doctor',
    'enable',
    'setup',
    'upgrade',
    'update',
    'updates',
    'daemon',
    'help'
  ]);
  const command = args.find((arg) => !arg.startsWith('-'));
  return (
    (command !== undefined && maintenanceCommands.has(command)) ||
    args.includes('--version') ||
    args.includes('--cli-version') ||
    args.includes('-V') ||
    args.includes('--help') ||
    args.includes('-h')
  );
}

async function main(): Promise<void> {
  const serveArgs = process.argv.slice(2);
  if (
    serveArgs.find((arg) => !arg.startsWith('-')) === 'serve' &&
    !serveArgs.some((arg) => ['--help', '-h', '--version', '--cli-version', '-V'].includes(arg)) &&
    process.env.CONTEXTOS_DAEMON_PROXY_BACKEND !== '1'
  ) {
    const { runHandshakeProxy } = await import('../src/mcp/handshake-proxy.js');
    await runHandshakeProxy();
    return;
  }
  // Keep the entrypoint light until the updater lock is clear. A package swap
  // must not make new commands import a mix of the old and new package trees.
  const { waitForUpgradeToFinish } = await import('../src/core/updater/upgrade-lock.js');
  await waitForUpgradeToFinish();

  const manifest = findPackageManifest(path.dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  if (['--version', '-V', '--cli-version'].includes(args[0] ?? '')) {
    process.stdout.write(`${manifest.version}\n`);
    return;
  }

  const command = args.find((arg) => !arg.startsWith('-'));
  if (
    command &&
    ['serve', 'query', 'watch', 'reindex', 'status'].includes(command) &&
    !args.some((arg) => ['--help', '-h'].includes(arg))
  ) {
    const { upgradeExistingProjects } = await import('../src/cli/utils/installation-setup.js');
    await upgradeExistingProjects({ cwd: process.env.CONTEXTOS_REPO_ROOT || process.cwd() });
  }

  if (!skipsFirstUseAutoPatchNotice(args) && process.env.CONTEXTOS_AUTO_PATCH_REEXEC !== '1') {
    try {
      const { showAutoPatchDefaultNotice } =
        await import('../src/core/updater/auto-patch-onboarding.js');
      showAutoPatchDefaultNotice();
    } catch {
      // Onboarding state is optional and must not block a working command.
    }
  }

  const { program } = await import('commander');
  const { handleCliError } = await import('../src/cli/utils/errors.js');

  process.on('uncaughtException', handleCliError);
  process.on('unhandledRejection', handleCliError);

  if (!skipsStartupNotice(args)) {
    try {
      const { checkForUpdates, formatUpdateNotice } = await import('../src/core/updater/index.js');
      const notice = formatUpdateNotice(await checkForUpdates());
      if (notice) process.stderr.write(notice);
    } catch {
      // Version checks are advisory and must never block a working command.
    }
  }

  const { loadCommands } = await import('../src/cli/command-registry.js');
  const commands = await loadCommands();

  program
    .name('contextos')
    .description('Intelligent context routing for AI coding assistants')
    .version(manifest.version, '-V, --cli-version', 'output the CLI version')
    .option('--verbose', 'Enable verbose debug logging')
    .option('--trace', 'Output detailed retrieval traces')
    .option('--profile', 'Output execution profiling metrics')
    .hook('preAction', (thisCommand) => {
      const opts = thisCommand.opts();
      if (opts.verbose) process.env.DEBUG = '1';
      if (opts.trace) process.env.TRACE = '1';
      if (opts.profile) {
        process.env.PROFILE = '1';
        performance.mark('contextos_start');
      }
    });

  for (const command of commands) program.addCommand(command);

  try {
    await program.parseAsync(process.argv);
    if (process.env.PROFILE === '1') {
      performance.mark('contextos_end');
      performance.measure('Execution Time', 'contextos_start', 'contextos_end');
      const measure = performance.getEntriesByName('Execution Time')[0];
      process.stderr.write(`\n[Profile] Total execution time: ${measure.duration.toFixed(2)}ms\n`);
    }
  } catch (error) {
    handleCliError(error);
  }
}

void main().catch(async (error) => {
  const { handleCliError } = await import('../src/cli/utils/errors.js');
  handleCliError(error);
});
