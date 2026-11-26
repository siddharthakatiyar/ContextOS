import { Command, InvalidArgumentError } from 'commander';
import {
  enableGlobalAgentInstructions,
  globalInstructionsBlock,
  GLOBAL_AGENT_NAMES,
  type GlobalAgent
} from '../utils/global-agent-setup.js';

function parseAgent(value: string): GlobalAgent {
  if (!(GLOBAL_AGENT_NAMES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`Choose one of: ${GLOBAL_AGENT_NAMES.join(', ')}.`);
  }
  return value as GlobalAgent;
}

export const enableCommand = new Command('enable')
  .description('Install or refresh global instructions for installed coding agents')
  .option('--agent <name>', 'Select one agent', parseAgent)
  .option('--dry-run', 'Show changes without writing files')
  .option('--json', 'Output results as JSON')
  .action((options: { agent?: GlobalAgent; dryRun?: boolean; json?: boolean }) => {
    const results = enableGlobalAgentInstructions(options);
    if (options.json) process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
    else
      for (const result of results) {
        if (result.status === 'not-installed' && !options.agent) continue;
        process.stdout.write(
          `${result.agent}: ${result.status}${result.files.length ? ` (${result.files.join(', ')})` : ''}${result.message ? ` — ${result.message}` : ''}\n`
        );
        if (result.status === 'manual' && options.agent === 'cursor') {
          process.stdout.write(`\n${globalInstructionsBlock()}\n`);
        }
      }
    if (results.some((result) => result.status === 'error')) process.exitCode = 1;
  });
