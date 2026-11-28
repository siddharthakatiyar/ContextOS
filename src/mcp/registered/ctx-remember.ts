import { knowledgeWriteSchema } from '../knowledge-write-schema.js';
import { resolveKnowledgeWriteContext } from '../../core/knowledge/write-context.js';

import { z } from 'zod';

import { entityRef } from '../../core/workspace/identity.js';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, verbose, writeResult, scopeFor, wrap } = c;
  server.tool(
    'ctx_remember',
    'Save useful durable verified facts with explicit provenance. Code facts require indexed evidence and current generations. User provenance is only for an explicit user decision or preference. Defaults to the active view. Session notes remain temporary.',
    {
      ...knowledgeWriteSchema,
      ...selectors,
      ...verbose,
      type: z
        .enum(['session_note', 'cross_session_fact', 'forget_fact'])
        .default('cross_session_fact'),
      content: z.string(),
      category: z.string().optional(),
      scope: z
        .enum(['view', 'project', 'group'])
        .default('view')
        .describe(
          'View isolates branch/worktree facts. Explicit user decisions with project/group scope apply across branches; code evidence remains bound to its selected views.'
        ),
      provenance: z.enum(['code', 'user']).default('code'),
      evidence: z.array(z.string()).optional(),
      expected_generations: z.record(z.string(), z.number().int().nonnegative()).optional()
    },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const source = scope.sources.find((s) => s.repoId === scope.activeRepoId) ?? scope.sources[0];
      if (!source) throw new Error('No selected view.');
      if (args.type === 'session_note') {
        const id = context.saveSession(source, args.content as string);
        context.clearCache();
        return writeResult(
          args,
          {
            saved: 'session_note',
            id,
            ref: entityRef(source.repoId, 'memory', id),
            type: 'session_note',
            endpoints: [{ ref: entityRef(source.repoId, 'memory', id), name: source.name }]
          },
          scope
        );
      }
      if (args.type === 'forget_fact') {
        const removed =
          context.forgetSession?.(args.content as string, scope.sources) ||
          graph.forget(args.content as string, scope.repoIds, {
            projectIds: scope.sources.map((source) => source.projectId),
            groupId: scope.groupId ?? scope.workspaceId
          });
        context.clearCache();
        return writeResult(
          args,
          {
            removed,
            id: args.id ?? args.content,
            ...(!removed ? { reason: 'No matching record in the selected scope.' } : {})
          },
          scope
        );
      }
      const kind = args.scope as 'view' | 'project' | 'group';
      const projectId =
        (source as typeof source & { projectId?: string }).projectId ?? source.repoId;
      const groupId = scope.workspaceId;
      if (kind === 'group' && !groupId)
        throw new Error('Group facts require an explicitly selected group.');
      const viewIds =
        kind === 'view'
          ? [source.repoId]
          : kind === 'project'
            ? scope.sources
                .filter(
                  (s) =>
                    ((s as typeof s & { projectId?: string }).projectId ?? s.repoId) === projectId
                )
                .map((s) => s.repoId)
            : scope.repoIds;
      const fact = graph.remember(
        {
          ...resolveKnowledgeWriteContext(args),
          content: args.content as string,
          scope: kind,
          scopeId: kind === 'view' ? source.repoId : kind === 'project' ? projectId : groupId!,
          viewIds,
          provenance: args.provenance as 'code' | 'user',
          category: args.category as string | undefined,
          evidenceRefs: args.evidence as string[] | undefined,
          expectedGenerations: args.expected_generations as Record<string, number> | undefined
        },
        scope.repoIds,
        {
          projectIds: scope.sources.map((source) => source.projectId),
          groupId: scope.groupId ?? scope.workspaceId
        }
      );
      context.clearCache();
      return writeResult(
        args,
        {
          id: fact.id,
          fact: args.verbose ? fact : { id: fact.id, scope: fact.scope, scopeId: fact.scopeId },
          type: 'cross_session_fact',
          endpoints: [{ ref: entityRef(source.repoId, 'fact', fact.id), name: source.name }],
          generations: Object.fromEntries(fact.evidence.map((e) => [e.viewId, e.generation])),
          warnings: []
        },
        scope
      );
    })
  );
}
