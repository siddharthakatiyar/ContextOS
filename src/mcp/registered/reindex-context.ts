import { z } from 'zod';

import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const { response, failure, server, runtime, sent, cache, viewSchema, chooseView } = c;
  server.tool(
    'reindex_context',
    'Index a file in the selected repository through its indexing owner.',
    {
      path: z.string(),
      ...viewSchema,
      layer: z.enum(['global', 'workspace', 'repo', 'session']).optional().default('repo'),
      workspaceName: z.string().optional()
    },
    async (args) => {
      try {
        const source = chooseView(args, args.path);
        const result = await runtime.get(source).request({
          action: 'file',
          file: args.path,
          layer: args.layer,
          workspaceName: args.workspaceName
        });
        cache.clear();
        sent.invalidate();
        return response(JSON.stringify(result));
      } catch (error) {
        return failure(error);
      }
    }
  );
}
