import path from 'node:path';
import fs from 'node:fs';
import { DB, getContextOSHome } from '../core/storage/database.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { WorkspaceRuntime } from '../core/workspace/runtime.js';
import type { RepositorySource, ScopeSelectors } from '../core/workspace/registry.js';
import { retrieveWorkspace } from '../core/workspace/retrieval.js';
import { entityRef, parseRef } from '../core/workspace/identity.js';
import { compile } from '../core/compiler/index.js';
import { SentRegistry } from '../core/session/sent-registry.js';
import { SessionManager, SessionStore } from '../core/session/index.js';
import { PromptsRepo } from '../core/storage/prompts-repo.js';
import { KnowledgeStore } from '../core/memory/knowledge-store.js';
import { mergeMemoryPipeline } from '../core/session/memory-merge.js';
import { FeedbackTracker } from '../core/feedback/tracker.js';
import { registerReadFileTool } from './tools/read-file.js';
import { registerExpandTool } from './tools/expand.js';
import { registerExecuteTool } from './tools/execute.js';
import { registerGetGraphTools, registerLegacyGetGraphTools } from './tools/get-graph.js';
import { registerListTopicsTool, registerLegacyListTopicsTool } from './tools/list-topics.js';
import { registerUpdateStatusTool } from './tools/update-status.js';
import { resolveWithinWorkspace } from '../utils/fs-guard.js';
import { getErrorMessage } from '../utils/errors.js';
import crypto from 'node:crypto';
import { registerLegacyReadTopicTool } from './tools/read-topic.js';
import { registerSaveContextTool } from './tools/save-context.js';
import { ChunksRepo } from '../core/storage/chunks-repo.js';
import { GraphStore } from '../core/knowledge/graph-store.js';
import { registerWorkspaceKnowledgeTools } from './tools/knowledge.js';

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
export function registerWorkspaceTools(
  server: McpServer,
  runtime: WorkspaceRuntime,
  options: { cwd: string; activeRepoId?: string; workspace?: string }
): void {
  const originalServer = server;
  server = {
    tool: (name: string, description: string, schema: z.ZodRawShape, handler: Handler) =>
      originalServer.tool(name, description, schema, (args) =>
        runtime.withSnapshot(() => handler(args))
      )
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
  server.tool(
    'get_context',
    'Retrieve engineering context from the active repository, explicit repositories, or the entire workspace. Use repo/workspace/all_repos to select scope.',
    {
      prompt: z.string(),
      group: z.string().optional(),
      project: z.union([z.string(), z.array(z.string())]).optional(),
      worktree: z.string().optional(),
      branch: z.string().optional(),
      all_worktrees: z.boolean().optional(),
      repo: z.union([z.string(), z.array(z.string())]).optional(),
      workspace: z.string().optional(),
      all_repos: z.boolean().optional(),
      max_tokens: z.number().int().positive().max(8000).optional(),
      layers: z
        .array(z.enum(['global', 'workspace', 'repo', 'session']))
        .optional()
        .default(['session', 'workspace', 'repo']),
      tier: z.enum(['stub', 'full']).optional().default('stub'),
      output_format: z.enum(['markdown', 'xml']).optional().default('markdown'),
      explain: z.boolean().optional()
    },
    async (args) => {
      try {
        const scope = select({
          repo: typeof args.repo === 'string' ? [args.repo] : args.repo,
          workspace: args.workspace,
          allRepos: args.all_repos,
          group: args.group,
          project: typeof args.project === 'string' ? [args.project] : args.project,
          worktree: args.worktree,
          branch: args.branch,
          allWorktrees: args.all_worktrees
        });
        const knowledgeGraph = graph();
        let graphRevision: number;
        try {
          knowledgeGraph.pruneInvalid({ viewIds: scope.repoIds });
          graphRevision = knowledgeGraph.revision();
        } finally {
          knowledgeGraph.close();
        }
        const key = JSON.stringify([
          graphRevision,
          args,
          scope.repoIds,
          scope.activeRepoId,
          runtime.registry.revision(),
          scope.sources.map((s) => s.generation)
        ]);
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < 30_000) {
          try {
            for (const source of scope.sources) runtime.get(source).assertReadable();
            if (!cached.result.structuredContent?.partial) return cached.result;
          } catch {
            /* Recompute to isolate unavailable sources instead of returning stale cached content. */
          }
          cache.delete(key);
        }
        const result = await retrieveWorkspace(runtime, scope, args.prompt, {
          layers: args.layers,
          explain: args.explain
        });
        const markUnavailable = (source: RepositorySource, error: unknown) => {
          result.unavailableSources ??= [];
          if (!result.unavailableSources.some((item) => item.repoId === source.repoId))
            result.unavailableSources.push({
              repoId: source.repoId,
              name: source.name,
              error: getErrorMessage(error)
            });
          result.partial = true;
        };
        for (const source of scope.sources) {
          if (result.unavailableSources?.some((s) => s.repoId === source.repoId)) continue;
          try {
            const repo = runtime.get(source);
            const state = session(source);
            const sessionChunks = args.layers.includes('session')
              ? await state.manager.getSessionContext()
              : [];
            repo.assertReadable();
            const facts = args.layers.includes('repo')
              ? new KnowledgeStore(repo.db).searchFacts(args.prompt, 2)
              : [];
            const memories = mergeMemoryPipeline([], sessionChunks, facts, result.intent).map(
              (chunk) => ({
                ...chunk,
                id: entityRef(source.repoId, 'memory', chunk.id),
                localId: chunk.id,
                repoId: source.repoId,
                repoName: source.name,
                relativePath: chunk.sourceFile,
                layer: chunk.sourceFile === 'memory.fact' ? ('repo' as const) : chunk.layer
              })
            );
            result.chunks.push(...memories);
            state.store.addEvent({
              sessionId: state.manager.getSessionId(),
              eventType: 'user_prompt',
              content: args.prompt.slice(0, 2000),
              relatedFiles: null
            });
          } catch (error) {
            markUnavailable(source, error);
          }
        }
        // Session retrieval is asynchronous: a checkout can change after the core search.
        for (const source of scope.sources) {
          if (result.unavailableSources?.some((item) => item.repoId === source.repoId)) continue;
          try {
            runtime.get(source).assertReadable();
          } catch (error) {
            markUnavailable(source, error);
          }
        }
        const failed = new Set(result.unavailableSources?.map((source) => source.repoId));
        result.chunks = result.chunks.filter((chunk) => !chunk.repoId || !failed.has(chunk.repoId));
        result.expandedEntities = result.expandedEntities.filter(
          (entity) => !entity.repoId || !failed.has(entity.repoId)
        );
        result.knowledgeLinks = result.knowledgeLinks?.filter((link) =>
          link.evidence.every((item) => !failed.has(item.viewId))
        );
        result.learnedLinks = result.learnedLinks?.filter((link) =>
          link.evidence.every((item) => !failed.has(item.viewId))
        );
        result.linkSuggestions = result.linkSuggestions?.filter(
          (item) => !failed.has(parseRef(item.source)?.repoId ?? '')
        );
        if (result.explanation) {
          for (const ref of Object.keys(result.explanation.chunks)) {
            const owner = /^contextos:([^:]+):/.exec(ref)?.[1];
            if (owner && failed.has(owner)) delete result.explanation.chunks[ref];
          }
        }
        if (scope.sources.every((source) => failed.has(source.repoId)))
          throw new Error(
            'All selected views changed or became unavailable during retrieval; refresh and retry.'
          );
        for (const chunk of result.chunks) {
          if (!chunk.repoId || !chunk.localId || !chunk.relativePath) continue;
          const fileKey = chunk.repoId + ':' + chunk.sourceFile;
          const entry = recent.get(fileKey);
          if (entry) entry.ids.push(chunk.localId);
          else recent.set(fileKey, { ids: [chunk.localId], at: Date.now() });
        }
        if (recent.size > 200) recent.clear();
        const responseSource =
          scope.sources.find((s) => s.repoId === scope.activeRepoId && !failed.has(s.repoId)) ??
          scope.sources.find((s) => !failed.has(s.repoId))!;
        const responseConfig = runtime.get(responseSource).config;
        const requestedBudget = args.max_tokens ?? Math.min(responseConfig.maxTokenBudget, 8000);
        const budget = args.tier === 'stub' ? Math.min(requestedBudget, 250) : requestedBudget;
        const compiled = compile(result, {
          maxTokens: budget,
          maxExactTokens:
            args.max_tokens !== undefined || args.tier === 'stub'
              ? budget
              : Math.min(responseConfig.maxExactTokenBudget, 8000),
          framingReserve: responseConfig.framingReserve,
          sentRegistry: sent,
          outputFormat: args.output_format,
          explain: args.explain
        });
        for (const source of scope.sources) {
          if (result.unavailableSources?.some((s) => s.repoId === source.repoId)) continue;
          const state = session(source);
          state.prompts.insert({
            id: crypto.randomUUID(),
            prompt: args.prompt.slice(0, 2000),
            extractedConcepts: JSON.stringify(result.intent.concepts),
            retrievedChunkIds: JSON.stringify(
              result.chunks.filter((c) => c.repoId === source.repoId).map((c) => c.id)
            ),
            compiledTokenCount: compiled.tokenCount,
            latencyMs: result.latencyMs,
            createdAt: Date.now()
          });
        }
        const omitted = scope.sources
          .filter((s) => !compiled.output.includes(s.name + '/'))
          .map((s) => s.name);
        const warning = result.partial
          ? `Partial results: ${result.unavailableSources?.map((s) => `${s.name}: ${s.error}`).join('; ')}`
          : '';
        const text =
          (warning
            ? args.output_format === 'xml'
              ? `<!-- ${warning.replace(/--/g, '—')} -->\n`
              : warning + '\n\n'
            : '') + compiled.output;
        const output: CallToolResult = {
          ...response(text),
          structuredContent: {
            scope: {
              workspaceId: scope.workspaceId,
              repoIds: scope.repoIds,
              activeRepoId: scope.activeRepoId
            },
            partial: result.partial,
            unavailableSources: result.unavailableSources,
            omittedRepositories: omitted,
            tokens: compiled.tokenCount,
            chunks: result.chunks.map((chunk) => ({
              ref: chunk.id,
              viewId: chunk.repoId,
              projectId: chunk.projectId,
              worktreeId: chunk.worktreeId,
              branch: chunk.branch,
              head: chunk.head,
              relativePath: chunk.relativePath,
              sourceFile: chunk.sourceFile,
              startLine: chunk.startLine,
              endLine: chunk.endLine
            })),
            sources: scope.sources,
            knowledgeLinks: result.knowledgeLinks,
            learnedLinks: result.learnedLinks,
            linkSuggestions: result.linkSuggestions,
            ...(args.explain
              ? { explanation: result.explanation, compilation: compiled.diagnostics }
              : {})
          }
        };
        cache.set(key, { at: Date.now(), result: output });
        while (cache.size > 8) cache.delete(cache.keys().next().value!);
        return output;
      } catch (error) {
        return failure(error);
      }
    }
  );
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
  for (const definition of definitions(initial)) {
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
              output.structuredContent = provenance(target, args, file);
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
          output.structuredContent = provenance(source, args, file);
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
  }
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
  for (const toolName of ['contextos_status', 'get_status'])
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
  const knowledgeDefinitions = capture((mock) =>
    registerWorkspaceKnowledgeTools(mock, {
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
        state.store.addEvent({
          sessionId: state.manager.getSessionId(),
          eventType: 'system_response',
          content,
          relatedFiles: null
        });
      }
    })
  );
  for (const definition of knowledgeDefinitions)
    server.tool(definition.name, definition.description, definition.schema, definition.handler);
  if (legacyEnabled) {
    const remember = knowledgeDefinitions.find((definition) => definition.name === 'ctx_remember')!;
    server.tool(
      'learn_fact',
      'Deprecated alias for verified ctx_remember. Code facts require evidence and expected_generations. Use provenance=user only for an explicit user decision or preference.',
      {
        ...Object.fromEntries(
          Object.entries(remember.schema).filter(([key]) => !['content', 'type'].includes(key))
        ),
        fact: z.string()
      },
      (args) => remember.handler({ ...args, content: args.fact, type: 'cross_session_fact' })
    );
    const forget = knowledgeDefinitions.find((definition) => definition.name === 'ctx_forget')!;
    server.tool(
      'forget_fact',
      'Deprecated alias for ctx_forget; removes one fact within the selected scope.',
      forget.schema,
      forget.handler
    );
    server.tool(
      'rate_chunk',
      'Rate a chunk in its owning project/worktree. Qualified chunk references are preferred; historical bare IDs resolve against the active or selected view.',
      {
        ...viewSchema,
        chunk_id: z.string(),
        adjustment: z.number().min(-5).max(5),
        reason: z.string().optional()
      },
      async (args) => {
        try {
          const ref = parseRef(args.chunk_id);
          if (ref && ref.kind !== 'chunk')
            throw new Error('Feedback requires a qualified chunk reference.');
          const explicit = args.repo || args.project || args.worktree || args.branch;
          if (ref?.repoId === 'global') {
            if (explicit)
              throw new Error('Global chunks cannot be rated with a project/worktree selector.');
            const globalPath = path.join(getContextOSHome(), 'index.db');
            if (!fs.existsSync(globalPath)) throw new Error('Global index is unavailable.');
            const globalDb = new DB(globalPath);
            try {
              const chunk = new ChunksRepo(globalDb.getInstance()).getByIds([ref.localId])[0];
              if (!chunk || chunk.layer !== 'global')
                throw new Error('Global chunk does not exist in the shared global index.');
              const id = new FeedbackTracker(globalDb).recordFeedback(
                ref.localId,
                args.adjustment,
                args.reason
              );
              cache.clear();
              return {
                ...response('Recorded feedback.'),
                structuredContent: {
                  source: { repoId: 'global' },
                  ref: entityRef('global', 'feedback', id),
                  chunk: args.chunk_id
                }
              };
            } finally {
              globalDb.close();
            }
          }
          const source = ref && !explicit ? choose(ref.repoId) : chooseView(args);
          if (ref && ref.repoId !== source.repoId)
            throw new Error('Chunk belongs to another selected project/worktree.');
          const owner = runtime.get(source);
          await owner.prepareRead();
          const localId = ref?.localId ?? args.chunk_id;
          if (!new ChunksRepo(owner.db.getInstance()).getByIds([localId]).length)
            throw new Error('Chunk does not exist in the selected view.');
          owner.assertReadable();
          const id = new FeedbackTracker(owner.db).recordFeedback(
            localId,
            args.adjustment,
            args.reason
          );
          cache.clear();
          return {
            ...response('Recorded feedback.'),
            structuredContent: {
              source,
              ref: entityRef(source.repoId, 'feedback', id),
              chunk: entityRef(source.repoId, 'chunk', localId)
            }
          };
        } catch (error) {
          return failure(error);
        }
      }
    );
  }
  registerUpdateStatusTool(originalServer);
}
