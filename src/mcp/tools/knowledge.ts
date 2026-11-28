import { recordKnowledgeOperation } from '../../core/knowledge/audit.js';
import { loadConfig } from '../../config/index.js';
import { knowledgeWriteSchema } from '../knowledge-write-schema.js';
import {
  compactKnowledgeMetadata,
  resolveMcpKnowledgeWriteContext
} from '../../core/knowledge/write-context.js';
import { workspaceToolRegistry } from '../tool-registry.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { KnowledgeStore } from '../../core/memory/knowledge-store.js';
import { SessionStore } from '../../core/session/session-store.js';
import { getErrorMessage } from '../../utils/errors.js';
import path from 'node:path';
import type { VerifiedLink } from '../../core/knowledge/graph-store.js';
import { parseRef } from '../../core/workspace/identity.js';

export function registerKnowledgeTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const store = new KnowledgeStore(primaryDb);
  const sessionStore = new SessionStore(primaryDb);

  server.tool(
    'ctx_remember',
    'Save important notes or context to memory. Can be session-specific (type=session_note) or cross-session (type=cross_session_fact). Use type=forget_fact to remove a fact.',
    {
      ...knowledgeWriteSchema,
      type: z
        .enum(['session_note', 'cross_session_fact', 'forget_fact'])
        .describe('Type of memory operation'),
      content: z.string().describe('The note, fact, or fact ID to operate on'),
      category: z.string().optional().describe('Optional category for cross_session_fact')
    },
    async ({ type, content, category, ...writeContext }) => {
      try {
        if (type === 'forget_fact') {
          const success = store.forgetFact(
            content,
            resolveMcpKnowledgeWriteContext(writeContext, {
              clientName: server.server?.getClientVersion()?.name
            })
          );
          if (success) {
            return { content: [{ type: 'text', text: `Successfully forgot fact ${content}` }] };
          }
          return { content: [{ type: 'text', text: `Fact ${content} not found.` }], isError: true };
        } else if (type === 'cross_session_fact') {
          const id = store.learnFact(
            content,
            category || 'general',
            resolveMcpKnowledgeWriteContext(writeContext, {
              clientName: server.server?.getClientVersion()?.name,
              review: loadConfig().knowledge?.review
            })
          );
          return { content: [{ type: 'text', text: `Successfully learned fact. ID: ${id}` }] };
        } else {
          let session = sessionStore.getLatestSession();
          if (!session) session = sessionStore.createSession(process.cwd());
          const event = sessionStore.addEvent({
            sessionId: session.id,
            eventType: 'system_response',
            content: content,
            relatedFiles: null
          });
          recordKnowledgeOperation(
            'remember_session',
            `session:note:${event.sessionId}:${event.id}`,
            resolveMcpKnowledgeWriteContext(
              { ...writeContext, namespace: writeContext.namespace ?? 'session' },
              {
                clientName: server.server?.getClientVersion()?.name
              }
            )
          );
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
      ...knowledgeWriteSchema,
      fact: z.string().describe('The fact to remember'),
      category: z
        .string()
        .optional()
        .default('general')
        .describe('An optional category for the fact')
    },
    async ({ fact, category, ...writeContext }) => {
      try {
        const id = store.learnFact(
          fact,
          category,
          resolveMcpKnowledgeWriteContext(writeContext, {
            clientName: server.server?.getClientVersion()?.name,
            review: loadConfig().knowledge?.review
          })
        );
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
      ...knowledgeWriteSchema,
      id: z.string().describe('The ID of the fact to forget')
    },
    async ({ id, ...writeContext }) => {
      try {
        const success = store.forgetFact(
          id,
          resolveMcpKnowledgeWriteContext(writeContext, {
            clientName: server.server?.getClientVersion()?.name
          })
        );
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
export function createWorkspaceKnowledgeContext(
  server: McpServer,
  context: {
    select: (
      selectors?: import('../../core/workspace/registry.js').ScopeSelectors
    ) => import('../../core/workspace/registry.js').RetrievalScope;
    graph: () => import('../../core/knowledge/graph-store.js').GraphStore;
    resolve?: (viewId: string) => import('../../core/knowledge/graph-store.js').GraphSource;
    clearCache: () => void;
    saveSession: (
      source: import('../../core/workspace/registry.js').RepositorySource,
      content: string
    ) => string;
    forgetSession?: (
      id: string,
      sources: import('../../core/workspace/registry.js').RepositorySource[]
    ) => boolean;
    defaultGroup?: string;
    catalog?: () => unknown;
  }
) {
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
  const verbose = { verbose: z.boolean().optional().default(false) };
  const compactScope = (scope: ReturnType<typeof scopeFor>) => ({
    groupId: scope.groupId ?? scope.workspaceId,
    activeViewId: scope.activeRepoId,
    views: scope.sources.map((s) => ({
      viewId: s.repoId,
      projectId: s.projectId,
      name: s.name,
      branch: s.branch,
      state: s.state,
      generation: s.generation
    }))
  });
  const writeResult = (
    args: Record<string, unknown>,
    value: Record<string, unknown>,
    scope: ReturnType<typeof scopeFor>
  ) =>
    args.verbose
      ? { ...value, scope }
      : { ok: true, warnings: [], generations: {}, endpoints: [], ...value };
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
  const endpoint = (ref: string) => {
    const parsed = parseRef(ref)!;
    const resolved = context.resolve?.(parsed.repoId);
    const chunk = resolved?.db
      .prepare('SELECT source_file,start_line,end_line FROM chunks WHERE id=?')
      .get(parsed.localId) as
      { source_file: string; start_line: number | null; end_line: number | null } | undefined;
    return {
      ref,
      project: resolved?.source.name,
      file:
        chunk && resolved
          ? path.relative(resolved.source.rootPath, chunk.source_file).split(path.sep).join('/')
          : undefined,
      lines: [chunk?.start_line ?? null, chunk?.end_line ?? null]
    };
  };
  const compactLink = (link: VerifiedLink) => ({
    ...compactKnowledgeMetadata(link),
    id: link.id,
    relationship: link.type,
    source: endpoint(link.source),
    target: endpoint(link.target),
    rationale: link.rationale.slice(0, 240),
    truncated: link.rationale.length > 240,
    evidence: { count: link.evidence.length, refs: [...new Set(link.evidence.map((e) => e.ref))] }
  });
  const result = (value: unknown) => ({
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    ...(value && typeof value === 'object' && !Array.isArray(value)
      ? { structuredContent: value as Record<string, unknown> }
      : {})
  });
  const wrap =
    (
      action: (
        args: Record<string, unknown>,
        graph: import('../../core/knowledge/graph-store.js').GraphStore
      ) => unknown,
      compact = false
    ) =>
    async (args: Record<string, unknown>) => {
      const graph = context.graph();
      graph.setTaskContext(args.task_id as string | undefined);
      try {
        const output = result(await action(args, graph));
        // Send graph payloads once: repeating structuredContent as JSON text doubles
        // the agent budget. Verbose retains the full text fallback for inspection.
        if (compact && !args.verbose) output.content = [];
        return output;
      } catch (error) {
        return { ...result({ error: getErrorMessage(error) }), isError: true };
      } finally {
        graph.close();
      }
    };

  const resolveWriteContext = (args: Record<string, unknown>) => {
    const scope = scopeFor(args);
    const source = scope.sources.find((s) => s.repoId === scope.activeRepoId) ?? scope.sources[0];
    return resolveMcpKnowledgeWriteContext(args, {
      clientName: server.server?.getClientVersion()?.name,
      sessionTtlHours: loadConfig({ cwd: source?.rootPath }).knowledge?.sessionTtlHours,
      review: loadConfig({ cwd: source?.rootPath }).knowledge?.review
    });
  };
  return {
    resolveWriteContext,
    forgetSession: (
      id: string,
      scope: ReturnType<typeof scopeFor>,
      args: Record<string, unknown>
    ) => {
      const removed = context.forgetSession?.(id, scope.sources) ?? false;
      if (removed) recordKnowledgeOperation('forget', id, resolveWriteContext(args));
      return removed;
    },
    server,
    context,
    selectors,
    verbose,
    compactScope,
    writeResult,
    scopeFor,
    endpoint,
    compactLink,
    result,
    wrap
  };
}
export type WorkspaceKnowledgeContext = ReturnType<typeof createWorkspaceKnowledgeContext>;
export function registerWorkspaceKnowledgeTools(
  ...args: Parameters<typeof createWorkspaceKnowledgeContext>
): void {
  const c = createWorkspaceKnowledgeContext(...args);
  for (const entry of workspaceToolRegistry) if (entry.kind === 'knowledge') entry.register(c);
}
