import { z } from 'zod';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, verbose, writeResult, scopeFor, wrap } = c;
  server.tool(
    'ctx_forget',
    'Remove one specific saved durable fact.',
    { ...selectors, ...verbose, id: z.string() },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const removed =
        context.forgetSession?.(args.id as string, scope.sources) ||
        graph.forget(args.id as string, scope.repoIds, {
          projectIds: scope.sources.map((source) => source.projectId),
          groupId: scope.groupId ?? scope.workspaceId
        });
      context.clearCache();
      return writeResult(
        args,
        {
          removed,
          type: 'memory',
          id: args.id ?? args.content,
          ...(!removed ? { reason: 'No matching record in the selected scope.' } : {})
        },
        scope
      );
    })
  );
}
