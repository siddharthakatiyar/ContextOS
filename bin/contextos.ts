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
    'init', 'serve', 'query', 'workspace', 'watch', 'export', 'import', 'analytics',
    'status', 'doctor', 'reindex', 'clean', 'daemon', 'visualize', 'upgrade'
  ]);
  const commandIndex = args.findIndex((arg) => commands.has(arg));
  const command = commandIndex >= 0 ? args[commandIndex] : undefined;
  return (
    command === 'doctor' ||
    command === 'upgrade' ||
    command === 'serve' ||
    args.includes('--version') ||
    args.includes('-V') ||
    args.includes('--help') ||
    args.includes('-h') ||
    (command === 'daemon' && args[commandIndex + 1] === 'start')
  );
}

async function main(): Promise<void> {
  // Keep the entrypoint light until the updater lock is clear. A package swap
  // must not make new commands import a mix of the old and new package trees.
  const { waitForUpgradeToFinish } = await import('../src/core/updater/upgrade-lock.js');
  await waitForUpgradeToFinish();

  const manifest = findPackageManifest(path.dirname(fileURLToPath(import.meta.url)));
  const args = process.argv.slice(2);
  if (args.includes('--version') && !args.includes('upgrade')) {
    process.stdout.write(`${manifest.version}\n`);
    return;
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

  const commands = await Promise.all([
    import('../src/cli/commands/init.js'),
    import('../src/cli/commands/serve.js'),
    import('../src/cli/commands/query.js'),
    import('../src/cli/commands/workspace.js'),
    import('../src/cli/commands/watch.js'),
    import('../src/cli/commands/export.js'),
    import('../src/cli/commands/import.js'),
    import('../src/cli/commands/analytics.js'),
    import('../src/cli/commands/status.js'),
    import('../src/cli/commands/doctor.js'),
    import('../src/cli/commands/reindex.js'),
    import('../src/cli/commands/clean.js'),
    import('../src/cli/commands/daemon.js'),
    import('../src/cli/commands/visualize.js'),
    import('../src/cli/commands/upgrade.js')
  ]);
  const [init, serve, query, workspace, watch, exportCmd, importCmd, analytics, status, doctor, reindex, clean, daemon, visualize, upgrade] = commands;

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

  for (const command of [
    init.initCommand,
    serve.serveCommand,
    query.queryCommand,
    workspace.workspaceCommand,
    watch.watchCommand,
    exportCmd.exportCommand,
    importCmd.importCommand,
    analytics.analyticsCommand,
    status.statusCommand,
    doctor.doctorCommand,
    reindex.reindexCommand,
    clean.cleanCommand,
    daemon.daemonCommand,
    visualize.visualizeCommand,
    upgrade.upgradeCommand
  ]) {
    program.addCommand(command);
  }

  try {
    await program.parseAsync(process.argv);
    if (process.env.PROFILE === '1') {
      performance.mark('contextos_end');
      performance.measure('Execution Time', 'contextos_start', 'contextos_end');
      const measure = performance.getEntriesByName('Execution Time')[0];
      process.stdout.write(`\n[Profile] Total execution time: ${measure.duration.toFixed(2)}ms\n`);
    }
  } catch (error) {
    handleCliError(error);
  }
}

void main().catch(async (error) => {
  const { handleCliError } = await import('../src/cli/utils/errors.js');
  handleCliError(error);
});
