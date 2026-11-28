import { workspaceToolRegistry } from './tool-registry.js';
import path from 'node:path';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WorkspaceRuntime } from '../core/workspace/runtime.js';
import type { RepositorySource, ScopeSelectors } from '../core/workspace/registry.js';

import { entityRef, parseRef } from '../core/workspace/identity.js';

import { SentRegistry } from '../core/session/sent-registry.js';
import { SessionManager, SessionStore } from '../core/session/index.js';
import { PromptsRepo } from '../core/storage/prompts-repo.js';

import { FeedbackTracker } from '../core/feedback/tracker.js';
import { registerReadFileTool } from './tools/read-file.js';
import { registerExpandTool } from './tools/expand.js';
import { registerExecuteTool } from './tools/execute.js';
import { registerGetGraphTools, registerLegacyGetGraphTools } from './tools/get-graph.js';
import { registerListTopicsTool, registerLegacyListTopicsTool } from './tools/list-topics.js';

import { resolveWithinWorkspace } from '../utils/fs-guard.js';
import { getErrorMessage } from '../utils/errors.js';

import { registerLegacyReadTopicTool } from './tools/read-topic.js';
import { registerSaveContextTool } from './tools/save-context.js';
import { ChunksRepo } from '../core/storage/chunks-repo.js';
import { GraphStore } from '../core/knowledge/graph-store.js';
import { createWorkspaceKnowledgeContext } from './tools/knowledge.js';
import { ReadinessChangedError } from '../core/workspace/readiness.js';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type Definition = { name: string; description: string; schema: z.ZodRawShape; handler: Handler };
function capture(register: (server: McpServer) => void): Definition[] {
  const definitions: Definition[] = [];
  register({
    tool: (name: string, description: string, schema: z.ZodRawShape, handler: Handler) =>
      definitions.push({ name, description, schema, handler })
  } as unknown as McpServer);
  return definitions;
}
const response = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });
const failure = (error: unknown): CallToolResult => ({
  ...response(getErrorMessage(error)),
  isError: true
});

/** All mutable conversation state belongs to this MCP connection. */
export function createWorkspaceToolContext(
  server: McpServer,
  runtime: WorkspaceRuntime,
  options: { cwd: string; activeRepoId?: string; workspace?: string }
) {
  const originalServer = server;
  server = {
    tool: (name: string, description: string, schema: z.ZodRawShape, handler: Handler) =>
      originalServer.tool(name, description, schema, async (args) => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await runtime.withSnapshot(() => handler(args));
          } catch (error) {
            if (name !== 'get_context' || attempt > 0 || !(error instanceof ReadinessChangedError))
              return failure(error);
            // Leave the failed snapshot before waiting for startup watchers or
            // retiring stale runtimes. Refresh may itself be waiting for readers.
            try {
              await runtime.refreshReadState();
            } catch (refreshError) {
              return failure(refreshError);
            }
          }
        }
      })
  } as unknown as McpServer;
  const sent = new SentRegistry();
  const sessions = new Map<
    string,
    { manager: SessionManager; store: SessionStore; prompts: PromptsRepo; db: object }
  >();
  const recent = new Map<string, { ids: string[]; at: number }>();
  const cache = new Map<string, { at: number; result: CallToolResult }>();
  const session = (source: RepositorySource) => {
    let value = sessions.get(source.repoId);
    const repo = runtime.get(source);
    if (!value || value.db !== repo.db) {
      const store = new SessionStore(repo.db);
      const prompts = new PromptsRepo(repo.db.getInstance());
      value = {
        db: repo.db,
        store,
        prompts,
        manager: new SessionManager(prompts, store, { root: source.rootPath, fresh: true })
      };
      sessions.set(source.repoId, value);
    }
    return value;
  };
  const select = (selectors: ScopeSelectors = {}) =>
    runtime.select(
      selectors,
      options.cwd,
      runtime.registry.active(options.cwd)?.repoId ?? options.activeRepoId,
      options.workspace
    );
  const graph = () =>
    new GraphStore({
      resolve: (viewId) => {
        const source = runtime.registry.resolve(viewId);
        return { source, db: runtime.get(source).db.getInstance() };
      }
    });
  const choose = (selector?: string, file?: string): RepositorySource => {
    if (selector) return select({ repo: [selector] }).sources[0];
    if (file && path.isAbsolute(file)) {
      const candidates = options.workspace
        ? runtime.registry.list(options.workspace, true)
        : select().sources;
      const owner = candidates
        .filter((source) => resolveWithinWorkspace(source.rootPath, file))
        .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
      if (!owner) throw new Error('File is outside the available registered repositories');
      return owner;
    }
    return select().sources[0];
  };

  const viewSchema = {
    repo: z.string().optional(),
    project: z.string().optional(),
    worktree: z.string().optional(),
    branch: z.string().optional()
  };
  const chooseView = (args: Record<string, unknown>, file?: string) => {
    if (args.project || args.worktree || args.branch) {
      const scope = select({
        project: args.project ? [String(args.project)] : undefined,
        repo: args.repo ? [String(args.repo)] : undefined,
        worktree: args.worktree as string | undefined,
        branch: args.branch as string | undefined
      });
      if (scope.sources.length !== 1)
        throw new Error('This operation requires one project/worktree view.');
      return scope.sources[0];
    }
    return choose(typeof args.repo === 'string' ? args.repo : undefined, file);
  };
  const provenance = (source: RepositorySource, args: Record<string, unknown>, file?: string) => {
    const chunks =
      typeof args.symbolName === 'string' || file
        ? new ChunksRepo(runtime.get(source).db.getInstance())
        : undefined;
    const records =
      typeof args.symbolName === 'string'
        ? chunks!.findBySymbolName(args.symbolName)
        : file
          ? chunks!.getByIds(chunks!.getIdsBySource(path.resolve(source.rootPath, file)))
          : [];
    return {
      source,
      chunks: records.map((chunk) => ({
        ref: entityRef(source.repoId, 'chunk', chunk.id),
        file: chunk.sourceFile,
        startLine: chunk.startLine,
        endLine: chunk.endLine
      }))
    };
  };
  let legacyEnabled = false;
  const definitions = (source: RepositorySource) => {
    const repo = runtime.get(source);
    return capture((mock) => {
      registerReadFileTool(mock, source.rootPath, (file) => {
        repo.assertReadable();
        const entry = recent.get(source.repoId + ':' + file);
        if (entry && Date.now() - entry.at < 300_000) {
          const tracker = new FeedbackTracker(repo.db);
          for (const id of new Set(entry.ids))
            tracker.recordFeedback(id, 1, 'implicit:ctx_read_file');
          cache.clear();
        }
      });
      registerExpandTool(mock, [repo.db], source.rootPath);
      registerExecuteTool(mock, source.rootPath);
      registerGetGraphTools(mock, repo.db);
      registerListTopicsTool(mock, repo.db);
      if (legacyEnabled) {
        registerLegacyGetGraphTools(mock, repo.db);
        registerLegacyListTopicsTool(mock, repo.db);
        registerLegacyReadTopicTool(mock, repo.db);
        registerSaveContextTool(mock, repo.db);
      }
    });
  };
  // Capture schemas without opening a repository. Factories only access DBs for symbol tools;
  // use a selected repository, which serve validates before accepting connections.
  const initial = choose();
  legacyEnabled = runtime.get(initial).config.legacyTools;
  const registerViewTool = (name: string) => {
    const definition = definitions(initial).find((d) => d.name === name);
    if (!definition) return;

    server.tool(
      definition.name,
      definition.description,
      {
        ...definition.schema,
        ...viewSchema
      },
      async (args: Record<string, unknown>) => {
        try {
          const file = typeof args.filePath === 'string' ? args.filePath : undefined;
          const source = chooseView(args, file);
          if (definition.name === 'save_context') {
            const owner = runtime.get(source);
            await owner.prepareRead();
            const relatedFiles = typeof args.related_files === 'string' ? args.related_files : null;
            if (
              relatedFiles
                ?.split(',')
                .some((file) => !resolveWithinWorkspace(source.rootPath, file.trim()))
            )
              throw new Error('Related files must stay within the selected project/worktree.');
            owner.assertReadable();
            const state = session(source);
            state.store.addEvent({
              sessionId: state.manager.getSessionId(),
              eventType: 'system_response',
              content: String(args.note),
              relatedFiles
            });
            cache.clear();
            return {
              ...response('Saved connection-specific session note.'),
              structuredContent: { source }
            };
          }
          if (definition.name === 'ctx_expand') {
            const paths = args.paths as string[];
            const outputs: CallToolResult[] = [];
            for (const file of paths) {
              const target = chooseView(args, file);
              if (!resolveWithinWorkspace(target.rootPath, file))
                throw new Error('Access denied: path is outside the selected project/worktree.');
              const owner = runtime.get(target);
              await owner.prepareRead();
              const tool = definitions(target).find((d) => d.name === definition.name)!;
              const output = await tool.handler({ ...args, paths: [file] });
              owner.assertReadable();
              output.structuredContent = {
                ...output.structuredContent,
                ...provenance(target, args, file)
              };
              output.content.unshift({
                type: 'text',
                text: `Project: ${target.name}; branch: ${target.branch ?? 'detached/non-Git'}; worktree: ${target.worktreeId}; view: ${target.repoId}`
              });
              outputs.push(output);
            }
            for (const output of outputs) {
              const source = output.structuredContent?.source as RepositorySource | undefined;
              if (source) runtime.get(source).assertReadable();
            }
            return {
              content: outputs.flatMap((o) => o.content),
              isError: outputs.some((o) => o.isError),
              structuredContent: { sources: outputs.map((o) => o.structuredContent) }
            };
          }
          const reading = definition.name !== 'ctx_execute';
          const owner = runtime.get(source);
          if (reading) await owner.prepareRead();
          const tool = definitions(source).find((d) => d.name === definition.name)!;
          const output = await tool.handler(args);
          if (reading) owner.assertReadable();
          output.structuredContent = {
            ...output.structuredContent,
            ...provenance(source, args, file)
          };
          output.content.unshift({
            type: 'text',
            text: `Project: ${source.name}; branch: ${source.branch ?? 'detached/non-Git'}; worktree: ${source.worktreeId}; view: ${source.repoId}`
          });
          return output;
        } catch (error) {
          return failure(error);
        }
      }
    );
  };

  const knowledgeContext = createWorkspaceKnowledgeContext(server, {
    select,
    graph,
    resolve: (viewId) => {
      const source = runtime.registry.resolve(viewId);
      return { source, db: runtime.get(source).db.getInstance() };
    },
    clearCache: () => cache.clear(),
    defaultGroup: options.workspace,
    catalog: () => {
      const views = options.workspace
        ? runtime.registry.list(options.workspace, true)
        : runtime.registry.listAll().filter((source) => source.active);
      const projects = new Set(views.map((source) => source.projectId));
      return {
        groups: options.workspace
          ? [runtime.registry.workspace(options.workspace)]
          : runtime.registry.workspaces(),
        projects: runtime.registry.projects().filter((project) => projects.has(project.id)),
        worktrees: runtime.registry
          .worktrees()
          .filter((worktree) => projects.has(worktree.projectId)),
        views
      };
    },
    saveSession: (source, content) => {
      const state = session(source);
      const event = state.store.addEvent({
        sessionId: state.manager.getSessionId(),
        eventType: 'system_response',
        content,
        relatedFiles: null
      });
      return `session:note:${event.sessionId}:${event.id}`;
    },
    forgetSession: (id, sources) => {
      const ref = parseRef(id);
      const local = ref?.kind === 'memory' ? ref.localId : id.replace(/^memory:/, '');
      const note = /^session:note:([^:]+):(\d+)$/.exec(local);
      const events = /^session:events:([^:]+)$/.exec(local);
      if (!note && !events) return false;
      const candidates = ref ? sources.filter((s) => s.repoId === ref.repoId) : sources;
      let removed = false;
      for (const source of candidates) {
        const db = runtime.get(source).db.getInstance();
        const change = note
          ? db
              .prepare(
                "DELETE FROM session_events WHERE session_id=? AND id=? AND event_type='system_response'"
              )
              .run(note[1], Number(note[2]))
          : db
              .prepare(
                "DELETE FROM session_events WHERE session_id=? AND event_type='system_response'"
              )
              .run(events![1]);
        removed ||= change.changes > 0;
      }
      return removed;
    }
  });
  const knowledgeDefinitions = capture((mock) => {
    const c = { ...knowledgeContext, server: mock };
    for (const entry of workspaceToolRegistry) if (entry.kind === 'knowledge') entry.register(c);
  });

  return {
    response,
    failure,
    server,
    originalServer,
    runtime,
    options,
    sent,
    sessions,
    recent,
    cache,
    session,
    select,
    graph,
    choose,
    viewSchema,
    chooseView,
    provenance,
    legacyEnabled,
    definitions,
    initial,
    knowledgeDefinitions,
    registerViewTool,
    knowledgeContext
  };
}
export type WorkspaceToolContext = ReturnType<typeof createWorkspaceToolContext>;
export function registerWorkspaceTools(
  ...args: Parameters<typeof createWorkspaceToolContext>
): void {
  const c = createWorkspaceToolContext(...args);
  for (const entry of workspaceToolRegistry) {
    if (entry.kind === 'workspace') entry.register(c);
    else entry.register(c.knowledgeContext);
  }
}
