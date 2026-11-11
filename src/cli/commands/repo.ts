import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { RepositoryRuntime } from '../../core/workspace/runtime.js';

export const repoCommand = new Command('repo').description(
  'Manage local repositories and workspace membership'
);
repoCommand
  .command('add <path>')
  .description('Register and index a local repository')
  .option('--workspace <name>', 'Workspace membership', 'default')
  .option('--name <name>', 'Unique repository display name')
  .option('--no-index', 'Register without indexing')
  .action(async (root: string, opts: { workspace: string; name?: string; index: boolean }) => {
    const registry = new WorkspaceRegistry();
    let runtime: RepositoryRuntime | undefined;
    try {
      const repo = registry.register(root, opts);
      console.log(
        `Registered ${repo.name} (${repo.repoId}) in ${opts.workspace}: ${repo.rootPath}`
      );
      if (opts.index) {
        runtime = new RepositoryRuntime(repo, registry);
        await runtime.request({ action: 'index', force: true });
        console.log(`Indexed ${repo.name}.`);
      }
    } finally {
      await runtime?.close();
      registry.close();
    }
  });
repoCommand
  .command('remove <repo>')
  .description('Detach a repository without deleting its local data')
  .option('--workspace <name>', 'Workspace membership', 'default')
  .action(async (selector: string, opts: { workspace: string }) => {
    const registry = new WorkspaceRegistry();
    try {
      registry.remove(selector, opts.workspace);
      const { refreshWorkspaceDaemon } = await import('../../core/workspace/daemon.js');
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
