import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { discoverProject } from '../../core/workspace/discovery.js';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';
import { mergeContextosMcpConfig, validateJsonConfigs } from '../utils/mcp-config.js';
import { installAgentInstructions } from '../utils/agent-instructions.js';
import { loadConfig } from '../../config/index.js';
import {
  installProjectAgentConfigs,
  projectAgentJsonPaths
} from '../utils/project-agent-config.js';

function projectSetupPlan(cwd: string, options: { integrations?: boolean }) {
  const configs = [
    path.join(cwd, '.mcp.json'),
    ...(fs.existsSync(path.join(cwd, '.cursor')) ? [path.join(cwd, '.cursor', 'mcp.json')] : []),
    ...projectAgentJsonPaths(cwd),
    path.join(cwd, '.vscode', 'cline_mcp_settings.json'),
    path.join(cwd, '.vscode', 'roo_mcp_settings.json')
  ];
  const integrations =
    options.integrations !== false &&
    loadConfig({ cwd, forceReload: true }).cursor.autoGenerateConfig !== false;
  if (integrations) validateJsonConfigs(configs);
  return { configs, integrations };
}

/** Refresh checkout integration without changing registration or group membership. */
export function refreshProjectSetup(
  cwd: string,
  options: { group?: string; integrations?: boolean } = {},
  plan = projectSetupPlan(cwd, options)
): string[] {
  installAgentInstructions(cwd);
  if (!plan.integrations) return ['Automatic project MCP configuration is disabled.'];
  const generated = generateCursorConfig({ projectRoot: cwd, workspaceName: options.group });
  for (const config of plan.configs) mergeContextosMcpConfig(config, generated);
  return installProjectAgentConfigs(cwd, generated).warnings;
}

export async function initializeProject(
  input: string,
  options: {
    name?: string;
    group?: string;
    workspace?: string;
    index?: boolean;
    integrations?: boolean;
    json?: boolean;
  } = {}
): Promise<void> {
  const { upgradeExistingProjects } = await import('../utils/installation-setup.js');
  await upgradeExistingProjects({ cwd: input });
  const registry = new WorkspaceRegistry();
  const runtime = new WorkspaceRuntime(registry);
  try {
    const canonical = fs.realpathSync(input);
    const discovered = discoverProject(canonical);
    const cwd =
      discovered.worktrees
        .filter(
          (tree) => canonical === tree.rootPath || canonical.startsWith(tree.rootPath + path.sep)
        )
        .sort((a, b) => b.rootPath.length - a.rootPath.length)[0]?.rootPath ?? discovered.rootPath;
    const plan = projectSetupPlan(cwd, options);
    const source = registry.register(cwd, {
      name: options.name,
      workspace: options.group ?? options.workspace ?? 'default'
    });
    const views = registry.listAll().filter((view) => view.projectId === source.projectId);
    for (const view of views)
      if (fs.existsSync(view.rootPath)) installAgentInstructions(view.rootPath);
    const integrationWarnings = refreshProjectSetup(
      cwd,
      { ...options, group: options.group ?? options.workspace },
      plan
    );
    if (!options.json) for (const warning of integrationWarnings) console.warn(warning);
    if (!options.json)
      console.log(
        `Registered ${source.name} in ${options.group ?? options.workspace ?? 'default'} (${views.length} checkout${views.length === 1 ? '' : 's'}).`
      );
    if (options.index !== false) {
      await Promise.all(
        views.map(async (view) => {
          await runtime
            .get(view)
            .index(
              false,
              options.json ? (message) => process.stderr.write(`${message}\n`) : undefined
            );
        })
      );
      if (!options.json)
        console.log(
          `Indexed ${source.name}. Data: ${path.dirname(path.dirname(path.dirname(source.dbPath)))}`
        );
    }
    if (options.json) {
      const current = registry.listAll().find((view) => view.viewId === source.viewId) ?? source;
      process.stdout.write(
        `${JSON.stringify({ status: 'registered', projectId: current.projectId, worktreeId: current.worktreeId, viewId: current.viewId, rootPath: current.rootPath, dbPath: current.dbPath, state: current.state, generation: current.generation, integrationWarnings, restart: 'Restart the coding agent or reconnect its MCP server to load project configuration.' })}\n`
      );
    }
  } finally {
    await runtime.close();
    registry.close();
  }
}

export const initCommand = new Command('init')
  .description('Initialize global project storage and discover local Git worktrees')
  .argument('[path]', 'Project or worktree path', '.')
  .option('--name <name>', 'Unique project name')
  .option('--group <name>', 'Add this project to a group', 'default')
  .option('--no-index', 'Register without indexing')
  .option('--json', 'Output a structured result')
  .action(
    async (
      input: string,
      options: { name?: string; group: string; index: boolean; json?: boolean }
    ) => initializeProject(path.resolve(input), options)
  );
