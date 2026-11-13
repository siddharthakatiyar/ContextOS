import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
export const reindexCommand = new Command('reindex')
  .description('Rebuild selected indexes while preserving memories and history')
  .option('--repo <repo>', 'Project selector (legacy alias)')
  .option('--project <project>', 'Project selector')
  .option('--group <group>', 'Reindex a group')
  .option('--worktree <worktree>', 'Select one worktree')
  .option('--branch <branch>', 'Select one live branch')
  .option('--all-worktrees', 'Reindex all live worktrees')
  .option('--embeddings', 'Backfill embeddings without rebuilding content')
  .action(
    async (opts: {
      repo?: string;
      project?: string;
      group?: string;
      worktree?: string;
      branch?: string;
      allWorktrees?: boolean;
      embeddings?: boolean;
    }) => {
      const registry = new WorkspaceRegistry();
      const runtime = new WorkspaceRuntime(registry);
      try {
        if (
          !opts.project &&
          !opts.repo &&
          !opts.group &&
          !opts.worktree &&
          !registry.active(process.cwd())
        )
          registry.register(process.cwd());
        const scope = registry.select(
          {
            ...opts,
            project: opts.project ? [opts.project] : undefined,
            repo: opts.repo ? [opts.repo] : undefined
          },
          process.cwd()
        );
        await Promise.all(
          scope.sources.map(async (source) => {
            await runtime
              .get(source)
              .request({ action: opts.embeddings ? 'embeddings' : 'index', force: true });
            console.log(
              `Reindexed ${source.name} [${source.branch ?? 'working/detached'}]. Memories and history retained.`
            );
          })
        );
      } finally {
        await runtime.close();
        registry.close();
      }
    }
  );
