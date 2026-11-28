import { knowledgeWriteSchema } from '../knowledge-write-schema.js';
import { z } from 'zod';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, verbose, writeResult, scopeFor, wrap, resolveWriteContext } =
    c;
  server.tool(
    'ctx_unlink',
    'Remove one specific incorrect or obsolete verified connection.',
    { ...knowledgeWriteSchema, ...selectors, ...verbose, id: z.string() },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const link = graph.getLink(args.id as string, scope.repoIds);
      const removed = graph.unlink(args.id as string, scope.repoIds, resolveWriteContext(args));
      context.clearCache();
      return writeResult(
        args,
        {
          removed,
          id: args.id ?? args.content,
          ...(link
            ? {
                type: link.type,
                endpoints: [link.source, link.target].map((ref) => ({
                  ref,
                  name: scope.sources.find((source) =>
                    ref.startsWith(`contextos:${source.repoId}:`)
                  )?.name
                }))
              }
            : {}),
          ...(!removed ? { reason: 'No matching record in the selected scope.' } : {})
        },
        scope
      );
    })
  );
}
