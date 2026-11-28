import { Command } from 'commander';
import fs from 'node:fs';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
import { workspaceImpact } from '../../core/impact/adapter.js';
import { getErrorMessage } from '../../utils/errors.js';

export const impactCommand = new Command('impact')
  .description('Analyze recorded consumers and deployment associations before a change')
  .option('--group <name>', 'Select an indexed group')
  .option('--project <name...>', 'Select projects')
  .option('--worktree <id>', 'Select an input worktree')
  .option('--base <ref>', 'Base revision (head defaults to HEAD)')
  .option('--head <ref>', 'Head revision (base defaults to HEAD)')
  .option('--diff-file <file>', 'Unified diff file, or - for stdin')
  .option('--depth <n>', 'Traversal depth, 1–12', '2')
  .option('--json', 'Print structured output')
  .action(
    async (opts: {
      group?: string;
      project?: string[];
      worktree?: string;
      base?: string;
      head?: string;
      diffFile?: string;
      depth: string;
      json?: boolean;
    }) => {
      const registry = new WorkspaceRegistry();
      const runtime = new WorkspaceRuntime(registry);
      try {
        const scope = registry.select(
          { group: opts.group, project: opts.project, worktree: opts.worktree },
          process.cwd()
        );
        const result = await workspaceImpact(runtime, scope, {
          base: opts.base,
          head: opts.head,
          diff:
            opts.diffFile === undefined
              ? undefined
              : fs.readFileSync(opts.diffFile === '-' ? 0 : opts.diffFile, 'utf8'),
          depth: Number(opts.depth),
          limit: 100,
          verbose: true
        });
        console.log(
          opts.json
            ? JSON.stringify(result, null, 2)
            : `${result.summary}\n${result.impacted.map((i) => `${i.repo}/${i.file}${i.symbol ? ':' + i.symbol : ''} (${i.relation})`).join('\n')}\nCoverage: ${JSON.stringify(result.coverage)}\nDeployment: ${result.deployment.coverage.note}\n${result.warnings.join('\n')}`
        );
      } catch (error) {
        console.error(`Impact failed: ${getErrorMessage(error)}`);
        process.exitCode = 1;
      } finally {
        await runtime.close();
        registry.close();
      }
    }
  );
