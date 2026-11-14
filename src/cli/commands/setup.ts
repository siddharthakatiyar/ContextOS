import { Command, InvalidArgumentError } from 'commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initializeProject } from './init.js';
import {
  DIAGNOSTIC_CLIENTS,
  inspectAgentDiagnostics,
  inspectRegisteredScope,
  type DiagnosticClient
} from '../utils/agent-diagnostics.js';

export function inspectProjectSetup(input: string, client?: DiagnosticClient) {
  const root = fs.realpathSync(input);
  const home = os.homedir();
  const [scope, readiness] = inspectRegisteredScope(root, home);
  const projectRoot = typeof scope.details?.rootPath === 'string' ? scope.details.rootPath : root;
  const agent = inspectAgentDiagnostics({ root: projectRoot, homeDirectory: home, client });
  const mcpChecks = (client ? [client] : DIAGNOSTIC_CLIENTS).map((selected) => ({
    client: selected,
    check: inspectAgentDiagnostics({
      root: projectRoot,
      homeDirectory: home,
      client: selected
    }).find((check) => check.id === 'agent-mcp-registration')
  }));
  const missing =
    scope.summary.startsWith('No global project registry') ||
    scope.summary.startsWith('This directory has no active registered');
  const registered = scope.details?.viewId != null;
  const status = registered ? 'registered' : missing ? 'not_initialized' : 'unknown';
  const hasMcpRegistration = mcpChecks.some(
    (item) =>
      Array.isArray(item.check?.details?.registrations) &&
      item.check.details.registrations.length > 0
  );
  return {
    status,
    rootPath: root,
    scope,
    readiness,
    instructions: agent.find((check) => check.id === 'agent-instructions'),
    mcp: client ? mcpChecks[0].check : mcpChecks,
    nextAction:
      status === 'not_initialized'
        ? 'Ask the user whether to initialize this project, then run contextos init --json if they agree.'
        : status === 'unknown'
          ? 'Run contextos doctor to inspect registration.'
          : scope.status !== 'pass'
            ? 'Refresh project registration with contextos init.'
            : readiness.status !== 'pass'
              ? 'Index the project with contextos init.'
              : !hasMcpRegistration
                ? 'Run contextos init in this checkout to add project MCP configuration, then reconnect the agent.'
                : 'Reconnect the agent MCP server if ContextOS tools are unavailable.'
  };
}
function parseClient(value: string): DiagnosticClient {
  if (!(DIAGNOSTIC_CLIENTS as readonly string[]).includes(value))
    throw new InvalidArgumentError(`Choose one of: ${DIAGNOSTIC_CLIENTS.join(', ')}`);
  return value as DiagnosticClient;
}
export const setupCommand = new Command('setup')
  .description('Check or initialize ContextOS for a project')
  .argument('[path]', 'Project or worktree path', '.')
  .option('--check', 'Inspect setup without changing files or registration')
  .option('--json', 'Output a structured result')
  .option('--agent <client>', 'Inspect a specific coding agent', parseClient)
  .option('--no-index', 'Register without indexing')
  .action(
    async (
      input: string,
      options: { check?: boolean; json?: boolean; agent?: DiagnosticClient; index: boolean }
    ) => {
      if (!options.check)
        return initializeProject(path.resolve(input), { index: options.index, json: options.json });
      const result = inspectProjectSetup(path.resolve(input), options.agent);
      if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
      else
        process.stdout.write(
          `${result.status}: ${result.scope.summary}\n${result.readiness.summary}\n${result.nextAction}\n`
        );
    }
  );
