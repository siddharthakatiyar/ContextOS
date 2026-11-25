import { Command } from 'commander';
import { nestedProjectWarning } from '../../core/workspace/project-boundary.js';
import fs from 'node:fs';
import path from 'node:path';
import { discoverProject } from '../../core/workspace/discovery.js';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
import { refreshWorkspaceDaemon } from '../../core/workspace/daemon.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';
import { mergeContextosMcpConfig, validateJsonConfigs } from '../utils/mcp-config.js';
import { AGENT_BLOCK_START, installAgentInstructions } from '../utils/agent-instructions.js';
import { loadConfig } from '../../config/index.js';
import { projectGitFiles } from '../utils/project-git-files.js';
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
  if (integrations) validateJsonConfigs(configs.filter(projectGitFiles(cwd).canWrite));
  return { configs, integrations };
}

/** Refresh checkout integration without changing registration or group membership. */
export function refreshProjectSetup(
  cwd: string,
  options: { group?: string; integrations?: boolean } = {},
  plan = projectSetupPlan(cwd, options)
): string[] {
  if (!plan.integrations)
    return ['Automatic project integrations are disabled; no checkout files were changed.'];
  const git = projectGitFiles(cwd);
  const instructionFiles = ['AGENTS.md', 'CLAUDE.md'].map((name) => path.join(cwd, name));
  const excludableInstructions = instructionFiles.filter(
    (file) => !fs.existsSync(file) || fs.readFileSync(file, 'utf8').includes(AGENT_BLOCK_START)
  );
  installAgentInstructions(cwd, git.canWrite);
  const generated = generateCursorConfig({ projectRoot: cwd, workspaceName: options.group });
  const written = excludableInstructions.filter(git.canWrite);
  for (const config of plan.configs) {
    if (!git.canWrite(config)) continue;
    mergeContextosMcpConfig(config, generated);
    written.push(config);
  }
  const agents = installProjectAgentConfigs(cwd, generated, git.canWrite);
  git.exclude([...written, ...agents.configured]);
  return agents.warnings;
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
    const boundaryWarning = nestedProjectWarning(cwd, registry);
    if (boundaryWarning && !options.json) console.warn(boundaryWarning);
    const plan = projectSetupPlan(cwd, options);
    const source = registry.register(cwd, {
      name: options.name,
      workspace: options.group ?? options.workspace ?? 'default'
    });
    const views = registry.listAll().filter((view) => view.projectId === source.projectId);
    const integrationWarnings = refreshProjectSetup(
      cwd,
      { ...options, group: options.group ?? options.workspace },
      plan
    );
    for (const root of new Set(views.map((view) => view.rootPath))) {
      if (root === cwd || !fs.existsSync(root)) continue;
      integrationWarnings.push(
        ...refreshProjectSetup(root, {
          ...options,
          group: options.group ?? options.workspace
        })
      );
    }
    if (boundaryWarning) integrationWarnings.push(boundaryWarning);
    if (!options.json)
      for (const warning of integrationWarnings.filter((warning) => warning !== boundaryWarning))
        console.warn(warning);
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
  // Release this command's indexing leases before handing new memberships to
  // the live service. Waiting for its refresh prevents immediate reads racing
  // the periodic watcher's first scan after a project is re-added.
  if (options.index !== false)
    await refreshWorkspaceDaemon(options.group ?? options.workspace ?? 'default');
}

export const initCommand = new Command('init')
  .description('Initialize global project storage and discover local Git worktrees')
  .argument('[path]', 'Project or worktree path', '.')
  .option('--name <name>', 'Unique project name')
  .option('--group <name>', 'Add this project to a group', 'default')
  .option('--no-index', 'Register without indexing')
  .option('--no-integrations', 'Register without writing project instructions or client config')
  .option('--json', 'Output a structured result')
  .action(
    async (
      input: string,
      options: {
        name?: string;
        group: string;
        index: boolean;
        integrations: boolean;
        json?: boolean;
      }
    ) => initializeProject(path.resolve(input), options)
  );
