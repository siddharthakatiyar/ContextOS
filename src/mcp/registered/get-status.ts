import { z } from 'zod';

import { getErrorMessage } from '../../utils/errors.js';

import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const { response, failure, server, runtime, select, viewSchema } = c;
  const toolName = 'get_status';
  server.tool(
    toolName,
    'Show selected repository or workspace indexing status.',
    {
      ...viewSchema,
      group: z.string().optional(),
      workspace: z.string().optional(),
      all_worktrees: z.boolean().optional(),
      all_repos: z.boolean().optional()
    },
    async (args) => {
      try {
        const scope = select({
          repo: args.repo ? [args.repo] : undefined,
          workspace: args.workspace,
          allRepos: args.all_repos,
          group: args.group,
          project: args.project ? [args.project] : undefined,
          worktree: args.worktree,
          branch: args.branch,
          allWorktrees: args.all_worktrees
        });
        const rows = scope.sources.map((source) => {
          try {
            return runtime.get(source).status();
          } catch (error) {
            return { ...source, state: 'unavailable', lastError: getErrorMessage(error) };
          }
        });
        return response(
          JSON.stringify(
            { repositories: rows, ready: rows.every((row) => row.state === 'ready') },
            null,
            2
          )
        );
      } catch (error) {
        return failure(error);
      }
    }
  );
}
