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

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

program
  .name('contextos')
  .description('Intelligent context routing for AI coding assistants')
  .version(require('../../package.json').version);

program.addCommand(initCommand);
program.addCommand(serveCommand);
program.addCommand(queryCommand);
program.addCommand(workspaceCommand);
program.addCommand(watchCommand);
program.addCommand(exportCommand);
program.addCommand(importCommand);
program.addCommand(analyticsCommand);

program.parse(process.argv);
