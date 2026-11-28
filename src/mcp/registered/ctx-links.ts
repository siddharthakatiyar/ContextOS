import { z } from 'zod';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, selectors, verbose, scopeFor, compactLink, wrap } = c;
  server.tool(
    'ctx_links',
    'Inspect verified connections within selected views. Defaults to 20 compact links with endpoint locations, 240-character rationales and evidence refs. Use verbose for full evidence metadata.',
    {
      ...selectors,
      ...verbose,
      include_proposed: z.boolean().optional(),
      include_stale: z.boolean().optional(),
      refs: z.array(z.string()).optional(),
      limit: z.number().int().min(1).max(500).default(20),
      offset: z.number().int().nonnegative().default(0)
    },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const links = [
        ...new Map(
          graph
            .listLinks({
              viewIds: scope.repoIds,
              refs: args.refs as string[] | undefined,
              includeStale: args.include_stale as boolean | undefined
            })
            .filter((link) => args.include_proposed || link.status !== 'proposed')
            .map((link) => [link.id, link])
        ).values()
      ].sort(
        (a, b) =>
          Number(a.status === 'stale') - Number(b.status === 'stale') || a.id.localeCompare(b.id)
      );
      const offset = (args.offset as number) ?? 0,
        limit = (args.limit as number) ?? 20;
      return {
        links: links.slice(offset, offset + limit).map((link) =>
          args.verbose
            ? link
            : {
                ...compactLink(link),
                ...(link.status === 'stale'
                  ? { status: link.status, staleReason: link.staleReason }
                  : {})
              }
        ),
        next_offset: offset + limit < links.length ? offset + limit : null,
        total: links.length,
        offset,
        limit,
        ...(args.verbose ? { scope } : {})
      };
    }, true)
  );
}
