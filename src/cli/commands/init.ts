import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { discoverProject } from '../../core/workspace/discovery.js';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';
import { mergeContextosMcpConfig, validateJsonConfigs } from '../utils/mcp-config.js';
import { installAgentInstructions } from '../utils/agent-instructions.js';
import { loadConfig } from '../../config/index.js';

export async function initializeProject(
  input: string,
  options: {
    name?: string;
    group?: string;
    workspace?: string;
    index?: boolean;
    integrations?: boolean;
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
    const globalMcp = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
    const configs = [
      path.join(cwd, '.mcp.json'),
      ...(fs.existsSync(path.join(cwd, '.cursor')) ? [path.join(cwd, '.cursor', 'mcp.json')] : []),
      ...(fs.existsSync(path.join(cwd, '.agents'))
        ? [path.join(cwd, '.agents', 'mcp_config.json')]
        : []),
      path.join(cwd, '.vscode', 'cline_mcp_settings.json'),
      path.join(cwd, '.vscode', 'roo_mcp_settings.json'),
      globalMcp
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
    if (integrations) {
      const generated = generateCursorConfig({
        projectRoot: source.rootPath,
        workspaceName: options.group ?? options.workspace
      });
      // Existing explicit client entries are preserved by the merge helper.
      for (const config of configs) mergeContextosMcpConfig(config, generated);
    }
    console.log(
      `Registered ${source.name} in ${options.group ?? options.workspace ?? 'default'} (${views.length} checkout${views.length === 1 ? '' : 's'}).`
    );
    if (options.index !== false) {
      await Promise.all(
        views.map(async (view) => {
          await runtime.get(view).index();
        })
      );
      console.log(
        `Indexed ${source.name}. Data: ${path.dirname(path.dirname(path.dirname(source.dbPath)))}`
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
  .action(async (input: string, options: { name?: string; group: string; index: boolean }) =>
    initializeProject(path.resolve(input), options)
  );
