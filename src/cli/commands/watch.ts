import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
export const watchCommand = new Command('watch')
  .description('Watch repositories and incrementally update their indexes')
  .option('--repo <repo>', 'Registered repository')
  .option('-w, --workspace <name>', 'Watch all members of a workspace')
  .action(async (opts: { repo?: string; workspace?: string }) => {
    const registry = new WorkspaceRegistry();
    if (!opts.repo && !opts.workspace && !registry.active(process.cwd()))
      registry.register(process.cwd());
    // Older watch -w <label> indexed the current directory without registration.
    if (opts.workspace && !opts.repo) {
      const exists = registry
        .workspaces()
        .some((workspace) => workspace.name === opts.workspace || workspace.id === opts.workspace);
      if (!exists) registry.ensureWorkspace(opts.workspace);
      if (!registry.list(opts.workspace).length)
        registry.register(process.cwd(), { workspace: opts.workspace });
    }
    const runtime = new WorkspaceRuntime(registry, opts.workspace);
    try {
      const scope = registry.select(
        { repo: opts.repo ? [opts.repo] : undefined, workspace: opts.workspace },
        process.cwd()
      );
      for (const source of scope.sources) await runtime.get(source).watch();
      console.log(`Watching: ${scope.sources.map((s) => s.name).join(', ')}`);
    } catch (error) {
      await runtime.close();
      registry.close();
      throw error;
    }
    // Delegating to another indexing owner must still preserve foreground watch behavior.
    const foreground = setInterval(() => {}, 60_000);
    const cleanup = () => {
      clearInterval(foreground);
      void runtime.close().then(() => {
        registry.close();
        process.exit(0);
      });
    };
    process.once('SIGINT', cleanup);
    process.once('SIGTERM', cleanup);
  });
