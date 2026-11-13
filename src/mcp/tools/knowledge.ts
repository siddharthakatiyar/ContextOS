import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { KnowledgeStore } from '../../core/memory/knowledge-store.js';
import { SessionStore } from '../../core/session/session-store.js';
import { getErrorMessage } from '../../utils/errors.js';

export function registerKnowledgeTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const store = new KnowledgeStore(primaryDb);
  const sessionStore = new SessionStore(primaryDb);

  server.tool(
    'ctx_remember',
    'Save important notes or context to memory. Can be session-specific (type=session_note) or cross-session (type=cross_session_fact). Use type=forget_fact to remove a fact.',
    {
      type: z
        .enum(['session_note', 'cross_session_fact', 'forget_fact'])
        .describe('Type of memory operation'),
      content: z.string().describe('The note, fact, or fact ID to operate on'),
      category: z.string().optional().describe('Optional category for cross_session_fact')
    },
    async ({ type, content, category }) => {
      try {
        if (type === 'forget_fact') {
          const success = store.forgetFact(content);
          if (success) {
            return { content: [{ type: 'text', text: `Successfully forgot fact ${content}` }] };
          }
          return { content: [{ type: 'text', text: `Fact ${content} not found.` }], isError: true };
        } else if (type === 'cross_session_fact') {
          const id = store.learnFact(content, category || 'general');
          return { content: [{ type: 'text', text: `Successfully learned fact. ID: ${id}` }] };
        } else {
          let session = sessionStore.getLatestSession();
          if (!session) session = sessionStore.createSession(process.cwd());
          sessionStore.addEvent({
            sessionId: session.id,
            eventType: 'system_response',
            content: content,
            relatedFiles: null
          });
          return {
            content: [{ type: 'text', text: `Successfully saved context note to session memory.` }]
          };
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error managing memory: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );
}

export function registerLegacyKnowledgeTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const store = new KnowledgeStore(primaryDb);

  server.tool(
    'learn_fact',
    'Store a cross-session memory fact. Use this to remember user preferences, architectural decisions, or recurring bugs across different chat sessions.',
    {
      fact: z.string().describe('The fact to remember'),
      category: z
        .string()
        .optional()
        .default('general')
        .describe('An optional category for the fact')
    },
    async ({ fact, category }) => {
      try {
        const id = store.learnFact(fact, category);
        return {
          content: [{ type: 'text', text: `Successfully learned fact. ID: ${id}` }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error learning fact: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'forget_fact',
    'Remove a previously learned cross-session memory fact using its ID.',
    {
      id: z.string().describe('The ID of the fact to forget')
    },
    async ({ id }) => {
      try {
        const success = store.forgetFact(id);
        if (success) {
          return {
            content: [{ type: 'text', text: `Successfully forgot fact ${id}` }]
          };
        } else {
          return {
            content: [{ type: 'text', text: `Fact ${id} not found.` }],
            isError: true
          };
        }
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error forgetting fact: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );
}

// Workspace tools deliberately open the small graph connection per operation. No connection
// lifetime or mutable selection is shared with another MCP client.
export function registerWorkspaceKnowledgeTools(
  server: McpServer,
  context: {
    select: (
      selectors?: import('../../core/workspace/registry.js').ScopeSelectors
    ) => import('../../core/workspace/registry.js').RetrievalScope;
    graph: () => import('../../core/knowledge/graph-store.js').GraphStore;
    clearCache: () => void;
    saveSession: (
      source: import('../../core/workspace/registry.js').RepositorySource,
      content: string
    ) => void;
    defaultGroup?: string;
    catalog?: () => unknown;
  }
): void {
  const selectors = {
    group: z.string().optional(),
    project: z.union([z.string(), z.array(z.string())]).optional(),
    worktree: z.string().optional(),
    branch: z.string().optional(),
    all_worktrees: z.boolean().optional(),
    repo: z.union([z.string(), z.array(z.string())]).optional(),
    workspace: z.string().optional(),
    all_repos: z.boolean().optional()
  };
  const scopeFor = (args: Record<string, unknown>) =>
    context.select({
      group: args.group,
      project: typeof args.project === 'string' ? [args.project] : args.project,
      worktree: args.worktree,
      branch: args.branch,
      allWorktrees: args.all_worktrees,
      repo: typeof args.repo === 'string' ? [args.repo] : args.repo,
      workspace: args.workspace,
      allRepos: args.all_repos
    } as import('../../core/workspace/registry.js').ScopeSelectors);
  const result = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }]
  });
  const wrap =
    (
      action: (
        args: Record<string, unknown>,
        graph: import('../../core/knowledge/graph-store.js').GraphStore
      ) => unknown
    ) =>
    async (args: Record<string, unknown>) => {
      const graph = context.graph();
      try {
        return result(await action(args, graph));
      } catch (error) {
        return { ...result({ error: getErrorMessage(error) }), isError: true };
      } finally {
        graph.close();
      }
    };
  server.tool(
    'ctx_scope',
    'Discover the current group/project/worktree/branch views and their qualified IDs and indexing generations. Use generations for verified knowledge writes.',
    selectors,
    async (args) => {
      try {
        return result({ ...scopeFor(args), catalog: context.catalog?.() });
      } catch (error) {
        return { ...result({ error: getErrorMessage(error) }), isError: true };
      }
    }
  );
  server.tool(
    'ctx_link',
    'Save a verified relationship after inspecting both endpoints and necessary dependency/routing/contract evidence. Matching names alone are insufficient. Save no guesses or ambiguous candidates. Writes validate source freshness, not semantic correctness.',
    {
      ...selectors,
      source: z.string(),
      target: z.string(),
      relationship: z.enum([
        'imports',
        'implements_contract',
        'calls_api',
        'publishes_event',
        'consumes_event',
        'reads_resource',
        'writes_resource'
      ]),
      rationale: z.string().min(1),
      evidence: z.array(z.string()).optional(),
      expected_generations: z.record(z.string(), z.number().int().nonnegative())
    },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const link = graph.link(
        {
          source: args.source as string,
          target: args.target as string,
          type: args.relationship as import('../../core/knowledge/graph-store.js').LinkType,
          rationale: args.rationale as string,
          evidenceRefs: args.evidence as string[] | undefined,
          expectedGenerations: args.expected_generations as Record<string, number>
        },
        scope.repoIds
      );
      context.clearCache();
      return { link, scope };
    })
  );
  server.tool(
    'ctx_links',
    'Inspect existing verified connections and their supporting evidence within selected views.',
    { ...selectors, refs: z.array(z.string()).optional() },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      return {
        links: graph.listLinks({ viewIds: scope.repoIds, refs: args.refs as string[] | undefined }),
        scope
      };
    })
  );
  server.tool(
    'ctx_unlink',
    'Remove one specific incorrect or obsolete verified connection.',
    { ...selectors, id: z.string() },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const removed = graph.unlink(args.id as string, scope.repoIds);
      context.clearCache();
      return { removed, scope };
    })
  );
  server.tool(
    'ctx_remember',
    'Save useful durable verified facts with explicit provenance. Code facts require indexed evidence and current generations. User provenance is only for an explicit user decision or preference. Defaults to the active view. Session notes remain temporary.',
    {
      ...selectors,
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
        context.saveSession(source, args.content as string);
        context.clearCache();
        return { saved: 'session_note', scope };
      }
      if (args.type === 'forget_fact') {
        const removed = graph.forget(args.content as string, scope.repoIds, {
          projectIds: scope.sources.map((source) => source.projectId),
          groupId: scope.groupId ?? scope.workspaceId
        });
        context.clearCache();
        return { removed, scope };
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
      return { fact, scope };
    })
  );
  server.tool(
    'ctx_forget',
    'Remove one specific saved durable fact.',
    { ...selectors, id: z.string() },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const removed = graph.forget(args.id as string, scope.repoIds, {
        projectIds: scope.sources.map((source) => source.projectId),
        groupId: scope.groupId ?? scope.workspaceId
      });
      context.clearCache();
      return { removed, scope };
    })
  );
}
