import { knowledgeWriteSchema } from '../knowledge-write-schema.js';
import { z } from 'zod';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const {
    server,
    context,
    selectors,
    verbose,
    writeResult,
    scopeFor,
    wrap,
    resolveWriteContext,
    forgetSession
  } = c;
  server.tool(
    'ctx_forget',
    'Remove one specific saved durable fact.',
    { ...knowledgeWriteSchema, ...selectors, ...verbose, id: z.string() },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const removed =
        forgetSession(args.id as string, scope, args) ||
        graph.forget(
          args.id as string,
          scope.repoIds,
          {
            projectIds: scope.sources.map((source) => source.projectId),
            groupId: scope.groupId ?? scope.workspaceId
          },
          resolveWriteContext(args)
        );
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
