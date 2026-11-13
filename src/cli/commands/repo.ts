import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { refreshWorkspaceDaemon } from '../../core/workspace/daemon.js';
import { initializeProject } from './init.js';
import { RepositoryRuntime } from '../../core/workspace/runtime.js';

export const repoCommand = new Command('project')
  .alias('repo')
  .description('Manage local repositories and workspace membership');
repoCommand
  .command('add <path>')
  .description('Register and index a local repository')
  .option('--workspace <name>', 'Workspace membership')
  .option('--group <name>', 'Group membership', 'default')
  .option('--name <name>', 'Unique repository display name')
  .option('--no-index', 'Register without indexing')
  .action(
    async (
      root: string,
      opts: { workspace?: string; group: string; name?: string; index: boolean }
    ) => {
      await initializeProject(root, {
        ...opts,
        group: opts.workspace ?? opts.group,
        integrations: false
      });
    }
  );
repoCommand
  .command('remove <repo>')
  .description('Detach group membership or explicitly purge project data')
  .option('--purge', 'Delete every stored view and knowledge record for this project')
  .option('--workspace <name>', 'Workspace membership', 'default')
  .action(async (selector: string, opts: { workspace: string; purge?: boolean }) => {
    const registry = new WorkspaceRegistry();
    try {
      if (opts.purge) {
        const ids = registry.views(selector).map((view) => view.repoId);
        await refreshWorkspaceDaemon('default', 'quiesce', ids);
        try {
          registry.purgeProject(selector);
        } finally {
          await refreshWorkspaceDaemon('default', 'resume', ids);
        }
        console.log(`Purged ${selector}. Source files retained.`);
        return;
      }
      registry.remove(selector, opts.workspace);
      await refreshWorkspaceDaemon(opts.workspace);
      console.log(`Removed ${selector} from ${opts.workspace}. Local data retained.`);
    } finally {
      registry.close();
    }
  });
for (const command of ['list', 'status']) {
  const sub = repoCommand
    .command(command === 'status' ? 'status [repo]' : 'list')
    .description(
      command === 'status' ? 'Show repository indexing status' : 'List registered repositories'
    )
    .option('--workspace <name>', 'Workspace membership', 'default')
    .option('--json', 'Return JSON');
  const run = async (selector: string | undefined, opts: { workspace: string; json?: boolean }) => {
    const registry = new WorkspaceRegistry();
    try {
      const sources = selector
        ? registry.select({ workspace: opts.workspace, repo: [selector] }, process.cwd()).sources
        : registry.list(opts.workspace);
      const rows = [];
      for (const source of sources) {
        let runtime: RepositoryRuntime | undefined;
        try {
          runtime = new RepositoryRuntime(source, registry);
          rows.push(runtime.status());
        } catch (error) {
          rows.push({ ...source, state: 'unavailable', lastError: (error as Error).message });
        } finally {
          await runtime?.close();
        }
      }
      if (opts.json)
        console.log(
          JSON.stringify(
            {
              workspace: opts.workspace,
              ready: rows.every((r) => r.state === 'ready'),
              repositories: rows
            },
            null,
            2
          )
        );
      else
        for (const row of rows)
          console.log(
            `${row.name}\t${row.repoId}\t${row.state}\t${row.rootPath}${row.lastError ? `\t${row.lastError}` : ''}`
          );
    } finally {
      registry.close();
    }
  };
  if (command === 'status') sub.action(run);
  else sub.action((opts) => run(undefined, opts));
}
