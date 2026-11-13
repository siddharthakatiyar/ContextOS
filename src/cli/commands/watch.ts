import { Command } from 'commander';
import { WorkspaceRegistry, type ScopeSelectors } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
export const watchCommand = new Command('watch')
  .description('Watch live project/worktree views and reconcile checkout changes')
  .option('--repo <repo>', 'Project selector (legacy alias)')
  .option('--project <project>', 'Project selector')
  .option('-w, --workspace <name>', 'Group selector (legacy alias)')
  .option('--group <name>', 'Group selector')
  .option('--worktree <worktree>', 'One checkout ID or path')
  .option('--branch <branch>', 'Live branch filter')
  .option('--all-worktrees', 'Watch every live checkout in the scope')
  .action(
    async (opts: {
      repo?: string;
      project?: string;
      workspace?: string;
      group?: string;
      worktree?: string;
      branch?: string;
      allWorktrees?: boolean;
    }) => {
      const registry = new WorkspaceRegistry();
      const group = opts.group ?? opts.workspace;
      // Preserve legacy `watch -w label` enrollment for a new/empty group.
      if (group) {
        registry.ensureWorkspace(group);
        if (!registry.list(group).length) registry.register(process.cwd(), { workspace: group });
      } else if (!opts.repo && !opts.project && !opts.worktree && !registry.active(process.cwd()))
        registry.register(process.cwd());
      const runtime = new WorkspaceRuntime(registry, group);
      const selectors: ScopeSelectors = {
        project: opts.project ? [opts.project] : undefined,
        repo: opts.repo ? [opts.repo] : undefined,
        group,
        worktree: opts.worktree,
        branch: opts.branch,
        allWorktrees: opts.allWorktrees || !!group
      };
      try {
        await runtime.refreshSelected(selectors, process.cwd());
        console.log(
          `Watching: ${registry
            .select(selectors, process.cwd())
            .sources.map((s) => s.name)
            .join(', ')}`
        );
      } catch (error) {
        await runtime.close();
        registry.close();
        throw error;
      }
      let running = false;
      const refresh = setInterval(() => {
        if (running) return;
        running = true;
        void runtime
          .refreshSelected(selectors, process.cwd())
          .catch((error) => console.error((error as Error).message))
          .finally(() => {
            running = false;
          });
      }, 1000);
      const cleanup = () => {
        clearInterval(refresh);
        void runtime.close().then(() => {
          registry.close();
          process.exit(0);
        });
      };
      process.once('SIGINT', cleanup);
      process.once('SIGTERM', cleanup);
    }
  );
