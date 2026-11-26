import { refreshWorkspaceDaemon } from '../../core/workspace/daemon.js';
import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
export const cleanCommand = new Command('clean')
  .description(
    'Reconcile removed worktrees and deleted branch caches without deleting source files'
  )
  .option('--dry-run', 'Show obsolete stored views without deleting data')
  .option('--rebuild', 'Reindex the current checkout, preserving knowledge and history')
  .option('--global', 'Compatibility flag: cleanup now uses global project storage')
  .action(async (opts: { dryRun?: boolean; rebuild?: boolean }) => {
    const registry = new WorkspaceRegistry();
    const runtime = new WorkspaceRuntime(registry);
    try {
      if (opts.rebuild && !opts.dryRun) {
        const source = registry.active(process.cwd());
        if (!source)
          throw new Error('No initialized project in this directory. Run contextos init.');
        await runtime.get(source).index(true);
      }
      const pending = registry.cleanup({ dryRun: true });
      const ids = pending.flatMap((action) => action.viewIds);
      if (!opts.dryRun) await refreshWorkspaceDaemon('default', 'quiesce', ids);
      let actions;
      try {
        actions = opts.dryRun ? pending : registry.cleanup();
      } finally {
        if (!opts.dryRun) await refreshWorkspaceDaemon('default', 'resume', ids);
      }
      console.log(JSON.stringify({ dryRun: !!opts.dryRun, actions }, null, 2));
    } finally {
      await runtime.close();
      registry.close();
    }
  });
