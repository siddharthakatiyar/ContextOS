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
    const source = registry.register(cwd, {
      name: options.name,
      workspace: options.group ?? options.workspace ?? 'default'
    });
    const views = registry.listAll().filter((view) => view.projectId === source.projectId);
    for (const view of views)
      if (fs.existsSync(view.rootPath)) installAgentInstructions(view.rootPath);
    const integrationWarnings: string[] = [];
    if (integrations) {
      const generated = generateCursorConfig({
        projectRoot: source.rootPath,
        workspaceName: options.group ?? options.workspace
      });
      // Existing explicit client entries are preserved by the merge helper.
      for (const config of configs) mergeContextosMcpConfig(config, generated);
      integrationWarnings.push(...installProjectAgentConfigs(cwd, generated).warnings);
    } else integrationWarnings.push('Automatic project MCP configuration is disabled.');
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
