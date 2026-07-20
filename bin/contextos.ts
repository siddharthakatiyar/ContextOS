#!/usr/bin/env node

import { program } from 'commander';
import { initCommand } from '../src/cli/commands/init.js';
import { serveCommand } from '../src/cli/commands/serve.js';
import { queryCommand } from '../src/cli/commands/query.js';
import { workspaceCommand } from '../src/cli/commands/workspace.js';
import { watchCommand } from '../src/cli/commands/watch.js';
import { exportCommand } from '../src/cli/commands/export.js';
import { importCommand } from '../src/cli/commands/import.js';
import { analyticsCommand } from '../src/cli/commands/analytics.js';
import { statusCommand } from '../src/cli/commands/status.js';
import { reindexCommand } from '../src/cli/commands/reindex.js';
import { cleanCommand } from '../src/cli/commands/clean.js';
import { daemonCommand } from '../src/cli/commands/daemon.js';
import { visualizeCommand } from '../src/cli/commands/visualize.js';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { handleCliError } from '../src/cli/utils/errors.js';
import updateNotifier from 'update-notifier';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let pkgPath = path.join(__dirname, '../package.json');
if (!fs.existsSync(pkgPath)) {
  pkgPath = path.join(__dirname, '../../package.json');
}
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

// Non-blocking update check
updateNotifier({ pkg }).notify();

// Global error handlers
process.on('uncaughtException', handleCliError);
process.on('unhandledRejection', handleCliError);

program
  .name('contextos')
  .description('Intelligent context routing for AI coding assistants')
  .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(queryCommand);
program.addCommand(workspaceCommand);
program.addCommand(watchCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(analyticsCommand);
program.addCommand(statusCommand);
program.addCommand(reindexCommand);
program.addCommand(cleanCommand);
program.addCommand(daemonCommand);
program.addCommand(visualizeCommand);

// Wrap execution to catch sync errors
try {
  program.parse(process.argv);
} catch (error) {
  handleCliError(error);
}
