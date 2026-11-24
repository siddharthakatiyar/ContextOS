import { Command } from 'commander';
import { formatIndexWarning } from '../../core/daemon/index-status.js';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
export const statusCommand = new Command('status')
  .description('Show global project/worktree indexing status')
  .option('--json', 'Return JSON')
  .option('--group <name>', 'Group selector')
  .option('--workspace <name>', 'Alias for --group')
  .option('--project <project>', 'Show a project')
  .action(
    async (opts: { json?: boolean; group?: string; workspace?: string; project?: string }) => {
      const registry = new WorkspaceRegistry();
      const runtime = new WorkspaceRuntime(registry);
      try {
        registry.reconcile();
        const group = opts.group ?? opts.workspace;
        const views = group
          ? registry.list(group, true)
          : opts.project
            ? registry
                .listAll()
                .filter((v) => v.projectId === registry.resolve(opts.project!).projectId)
            : registry.active(process.cwd())
              ? [registry.active(process.cwd())!]
              : registry.listAll();
        const statuses = views.map((source) => {
          try {
            return runtime.get(source).status();
          } catch (error) {
            return { ...source, state: 'unavailable', error: (error as Error).message };
          }
        });
        if (opts.json) console.log(JSON.stringify({ views: statuses }, null, 2));
        else
          for (const source of statuses) {
            console.log(
              `${source.name}\t${source.branch ?? 'working/detached'}\t${source.state}\t${source.rootPath}\t${source.dbPath}`
            );
            const progress = 'progress' in source ? source.progress : undefined;
            const warning = formatIndexWarning(progress);
            if (warning) console.log(warning);
          }
      } finally {
        await runtime.close();
        registry.close();
      }
    }
  );
