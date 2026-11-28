import { z } from 'zod';
import type { WorkspaceToolContext } from '../workspace-tools.js';
import { workspaceImpact } from '../../core/impact/adapter.js';

export default function register(c: WorkspaceToolContext): void {
  const range = z.object({ start: z.number().int().min(1), end: z.number().int().min(1) });
  c.server.tool(
    'ctx_impact',
    'Call before changing exported symbols, API contracts or queue names. Analyze a diff or files against indexed imports, saved consumers and recorded deployment facts. Defaults to working-tree diff versus HEAD. Coverage and summary always explain gaps; absence of recorded impact does not establish no impact. Compact by default; verbose adds evidence. Pagination is bounded to 500 impacted items.',
    {
      ...c.knowledgeContext.selectors,
      view: z.string().optional(),
      diff: z
        .string()
        .max(4 * 1024 * 1024)
        .optional(),
      files: z
        .array(z.object({ path: z.string(), range: range.optional() }))
        .max(1000)
        .optional(),
      base: z.string().optional(),
      head: z.string().optional(),
      depth: z.number().int().min(1).max(12).optional(),
      include_proposed: z.boolean().optional(),
      include_stale: z.boolean().optional(),
      verbose: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(10),
      offset: z.number().int().min(0).max(499).default(0)
    },
    async (args) => {
      try {
        const scope = c.knowledgeContext.scopeFor({
          ...args,
          ...(args.view ? { worktree: args.view } : {})
        });
        const output = await workspaceImpact(c.runtime, scope, {
          diff: args.diff,
          files: args.files?.map((f) => ({
            path: f.path,
            ranges: f.range ? [f.range] : undefined
          })),
          base: args.base,
          head: args.head,
          depth: args.depth,
          includeProposed: args.include_proposed,
          includeStale: args.include_stale,
          verbose: args.verbose,
          limit: args.limit,
          offset: args.offset
        });
        return {
          content: args.verbose ? [{ type: 'text' as const, text: JSON.stringify(output) }] : [],
          structuredContent: output
        };
      } catch (error) {
        return c.failure(error);
      }
    }
  );
}
