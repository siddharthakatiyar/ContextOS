import { listKnowledge } from '../../core/knowledge/review.js';
import {
  compactKnowledgeMetadata,
  knowledgeIsVisible
} from '../../core/knowledge/write-context.js';
import { z } from 'zod';

import { getErrorMessage } from '../../utils/errors.js';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, verbose, compactScope, scopeFor, result } = c;
  server.tool(
    'ctx_scope',
    'Discover the current group/project/worktree/branch views and their qualified IDs and indexing generations. Use generations for verified knowledge writes.',
    { ...selectors, ...verbose, include_worktrees: z.boolean().optional().default(false) },
    async (args) => {
      try {
        const scope = scopeFor(args);
        const metadata = listKnowledge({ scope })
          .filter((r) => knowledgeIsVisible(r))
          .flatMap((record) => {
            const fields = compactKnowledgeMetadata(record);
            return Object.keys(fields).length ? [{ id: record.id, ...fields }] : [];
          });
        const knowledge = metadata.length ? { knowledge: metadata } : {};
        if (args.verbose) return result({ ...scope, ...knowledge, catalog: context.catalog?.() });
        const catalog = context.catalog?.() as
          { views?: typeof scope.sources; groups?: unknown[] } | undefined;
        const views = [
          ...new Map((catalog?.views ?? scope.sources).map((s) => [s.repoId, s])).values()
        ];
        const projects = [...new Set(views.map((s) => s.projectId))].map((projectId) => {
          const candidates = views.filter((s) => s.projectId === projectId);
          const source =
            candidates.find((s) => scope.repoIds.includes(s.repoId)) ??
            candidates.find((s) => s.active) ??
            candidates[0];
          return {
            projectId,
            name: source.name,
            defaultViewId: source.repoId,
            branch: source.branch,
            state: source.state,
            generation: source.generation,
            ...(args.include_worktrees
              ? { views: compactScope({ ...scope, sources: candidates }).views }
              : {})
          };
        });
        return result({
          group: scope.groupId ?? scope.workspaceId ?? context.defaultGroup,
          ...knowledge,
          activeViewId: scope.activeRepoId,
          counts: { projects: projects.length, views: views.length },
          projects
        });
      } catch (error) {
        return { ...result({ error: getErrorMessage(error) }), isError: true };
      }
    }
  );
}
