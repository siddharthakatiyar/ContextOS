import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
export const worktreeCommand = new Command('worktree').description(
  'Inspect local project checkouts'
);
worktreeCommand
  .command('list')
  .option('--project <project>', 'Select a project')
  .option('--json', 'Return JSON')
  .action((opts: { project?: string; json?: boolean }) => {
    const registry = new WorkspaceRegistry();
    try {
      registry.reconcile();
      const project = opts.project ? registry.resolve(opts.project).projectId : undefined;
      const views = registry.listAll().filter((view) => !project || view.projectId === project);
      if (opts.json) console.log(JSON.stringify(views, null, 2));
      else
        for (const view of views)
          console.log(
            `${view.name}\t${view.worktreeId}\t${view.branch ?? 'working/detached'}\t${view.rootPath}`
          );
    } finally {
      registry.close();
    }
  });
