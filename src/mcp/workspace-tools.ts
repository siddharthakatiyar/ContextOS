import path from 'node:path';
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
import { registerGetGraphTools } from './tools/get-graph.js';
import { registerListTopicsTool } from './tools/list-topics.js';
import { registerUpdateStatusTool } from './tools/update-status.js';
import { resolveWithinWorkspace } from '../utils/fs-guard.js';
import { getErrorMessage } from '../utils/errors.js';
import crypto from 'node:crypto';

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
  options: { cwd: string; activeRepoId?: string }
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
    runtime.select(selectors, options.cwd, options.activeRepoId);
  const choose = (selector?: string, file?: string): RepositorySource => {
    if (selector) return select({ repo: [selector] }).sources[0];
    if (file && path.isAbsolute(file)) {
      const candidates = runtime.workspace
        ? runtime.registry.list(runtime.workspace)
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
      repo: z.union([z.string(), z.array(z.string())]).optional(),
      workspace: z.string().optional(),
      all_repos: z.boolean().optional(),
      max_tokens: z.number().int().positive().max(8000).optional().default(1200),
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
          allRepos: args.all_repos
        });
        const key = JSON.stringify([
          args,
          scope.repoIds,
          scope.activeRepoId,
          runtime.registry.revision(),
          scope.sources.map((s) => s.generation)
        ]);
        const cached = cache.get(key);
        if (cached && Date.now() - cached.at < 30_000) return cached.result;
        const result = await retrieveWorkspace(runtime, scope, args.prompt, {
          layers: args.layers,
          explain: args.explain
        });
        for (const source of scope.sources) {
          if (result.unavailableSources?.some((s) => s.repoId === source.repoId)) continue;
          const repo = runtime.get(source);
          const state = session(source);
          const sessionChunks = args.layers.includes('session')
            ? await state.manager.getSessionContext()
            : [];
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
        }
        for (const chunk of result.chunks) {
          if (!chunk.repoId || !chunk.localId || !chunk.relativePath) continue;
          const fileKey = chunk.repoId + ':' + chunk.sourceFile;
          const entry = recent.get(fileKey);
          if (entry) entry.ids.push(chunk.localId);
          else recent.set(fileKey, { ids: [chunk.localId], at: Date.now() });
        }
        if (recent.size > 200) recent.clear();
        const budget = args.tier === 'stub' ? Math.min(args.max_tokens, 250) : args.max_tokens;
        const compiled = compile(result, {
          maxTokens: budget,
          maxExactTokens: budget,
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
  const definitions = (source: RepositorySource) => {
    const repo = runtime.get(source);
    return capture((mock) => {
      registerReadFileTool(mock, source.rootPath, (file) => {
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
    });
  };
  // Capture schemas without opening a repository. Factories only access DBs for symbol tools;
  // use a selected repository, which serve validates before accepting connections.
  const initial = choose();
  for (const definition of definitions(initial)) {
    server.tool(
      definition.name,
      definition.description,
      {
        ...definition.schema,
        repo: z.string().optional().describe('Repository ID or name; defaults to active repository')
      },
      async (args: Record<string, unknown>) => {
        try {
          const file = typeof args.filePath === 'string' ? args.filePath : undefined;
          const source = choose(typeof args.repo === 'string' ? args.repo : undefined, file);
          if (definition.name === 'ctx_expand') {
            const paths = args.paths as string[];
            const outputs: CallToolResult[] = [];
            for (const file of paths) {
              const target = choose(typeof args.repo === 'string' ? args.repo : undefined, file);
              const tool = definitions(target).find((d) => d.name === definition.name)!;
              outputs.push(await tool.handler({ ...args, paths: [file] }));
            }
            return {
              content: outputs.flatMap((o) => o.content),
              isError: outputs.some((o) => o.isError)
            };
          }
          const tool = definitions(source).find((d) => d.name === definition.name)!;
          const output = await tool.handler(args);
          if (definition.name === 'ctx_symbol' || definition.name === 'ctx_topics')
            output.content.unshift({
              type: 'text',
              text: `Repository: ${source.name} (${source.repoId})`
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
      repo: z.string().optional(),
      layer: z.enum(['global', 'workspace', 'repo', 'session']).optional().default('repo'),
      workspaceName: z.string().optional()
    },
    async (args) => {
      try {
        const source = choose(args.repo, args.path);
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
        repo: z.string().optional(),
        workspace: z.string().optional(),
        all_repos: z.boolean().optional()
      },
      async (args) => {
        try {
          const scope = select({
            repo: args.repo ? [args.repo] : undefined,
            workspace: args.workspace,
            allRepos: args.all_repos
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
  server.tool(
    'ctx_remember',
    'Store repository-specific facts or connection-specific session notes.',
    {
      type: z.enum(['session_note', 'cross_session_fact', 'forget_fact']),
      content: z.string(),
      category: z.string().optional(),
      repo: z.string().optional()
    },
    async (args) => {
      try {
        const ref = parseRef(args.content);
        const source = choose(args.repo ?? ref?.repoId);
        if (ref && ref.repoId !== source.repoId)
          throw new Error('Memory reference belongs to another repository');
        const repo = runtime.get(source);
        const store = new KnowledgeStore(repo.db);
        cache.clear();
        if (args.type === 'forget_fact')
          return response(
            store.forgetFact(ref?.localId ?? args.content) ? 'Fact removed.' : 'Fact not found.'
          );
        if (args.type === 'cross_session_fact')
          return response(
            `Saved fact: ${entityRef(source.repoId, 'memory', store.learnFact(args.content, args.category))}`
          );
        const state = session(source);
        state.store.addEvent({
          sessionId: state.manager.getSessionId(),
          eventType: 'system_response',
          content: args.content,
          relatedFiles: null
        });
        return response('Saved session note.');
      } catch (error) {
        return failure(error);
      }
    }
  );
  registerUpdateStatusTool(originalServer);
}
