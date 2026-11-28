import { prepareFactForContext, applyFactMetadata } from '../../core/knowledge/presentation.js';
import {
  compactKnowledgeMetadata,
  compactKnowledgeRecord
} from '../../core/knowledge/write-context.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import type { RepositorySource } from '../../core/workspace/registry.js';
import { retrieveWorkspace } from '../../core/workspace/retrieval.js';
import { entityRef, parseRef } from '../../core/workspace/identity.js';
import { compile } from '../../core/compiler/index.js';

import { KnowledgeStore } from '../../core/memory/knowledge-store.js';
import { mergeMemoryPipeline } from '../../core/session/memory-merge.js';

import { getErrorMessage } from '../../utils/errors.js';
import crypto from 'node:crypto';
import { boundResponse } from '../response-budget.js';

import { ReadinessChangedError, unavailableError } from '../../core/workspace/readiness.js';
import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const { response, failure, server, runtime, sent, recent, cache, session, select, graph } = c;
  server.tool(
    'get_context',
    'Retrieve engineering context from the active repository, explicit repositories, or the entire workspace. Use repo/workspace/all_repos to select scope.',
    {
      prompt: z.string(),
      include_proposed: z.boolean().optional(),
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
          includeProposed: args.include_proposed,
          layers: args.layers,
          explain: args.explain
        });
        const markUnavailable = (source: RepositorySource, error: unknown) => {
          result.unavailableSources ??= [];
          if (!result.unavailableSources.some((item) => item.repoId === source.repoId))
            result.unavailableSources.push({
              repoId: source.repoId,
              name: source.name,
              error: getErrorMessage(error),
              retryable: error instanceof ReadinessChangedError
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
              ? new KnowledgeStore(repo.db).searchFacts(args.prompt, 2).map(prepareFactForContext)
              : [];
            const memories = mergeMemoryPipeline([], sessionChunks, facts, result.intent).map(
              (chunk) => {
                return {
                  ...applyFactMetadata(chunk, facts),
                  id: entityRef(source.repoId, 'memory', chunk.id),
                  localId: chunk.id,
                  repoId: source.repoId,
                  repoName: source.name,
                  relativePath: chunk.sourceFile,
                  layer: chunk.sourceFile === 'memory.fact' ? ('repo' as const) : chunk.layer
                };
              }
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
          throw unavailableError(
            'All selected views changed or became unavailable during retrieval; refresh and retry.',
            result.unavailableSources ?? []
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
          // The included IDs also drive the compact hit list, even without inspector output.
          explain: true
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
            chunks: result.chunks
              .filter((chunk) =>
                compiled.diagnostics?.includedChunks.some((item) => item.id === chunk.id)
              )
              .map((chunk) => ({
                ...compactKnowledgeMetadata(chunk),
                ref: chunk.id,
                viewId: chunk.repoId,
                projectId:
                  chunk.projectId ??
                  scope.sources.find((s) => s.repoId === chunk.repoId)?.projectId,
                projectName:
                  chunk.repoName ?? scope.sources.find((s) => s.repoId === chunk.repoId)?.name,
                ...(chunk.sourceFile === 'memory.fact' ? { text: chunk.content } : {}),
                worktreeId: chunk.worktreeId,
                branch: chunk.branch,
                head: chunk.head,
                relativePath: chunk.relativePath,
                sourceFile: chunk.sourceFile,
                startLine: chunk.startLine,
                endLine: chunk.endLine
              })),
            sources: scope.sources.map((s) => ({
              viewId: s.repoId,
              projectId: s.projectId,
              name: s.name,
              generation: s.generation,
              checkoutGeneration: s.checkoutGeneration,
              worktreeId: s.worktreeId,
              branch: s.branch,
              state: s.state
            })),
            knowledgeLinks: result.knowledgeLinks?.map(compactKnowledgeRecord),
            learnedLinks: result.learnedLinks?.map(compactKnowledgeRecord),
            linkSuggestions: result.linkSuggestions,
            ...(args.explain
              ? { explanation: result.explanation, compilation: compiled.diagnostics }
              : {})
          }
        };
        if (args.max_tokens !== undefined) boundResponse(output, args.max_tokens);
        cache.set(key, { at: Date.now(), result: output });
        while (cache.size > 8) cache.delete(cache.keys().next().value!);
        return output;
      } catch (error) {
        if (error instanceof ReadinessChangedError) throw error;
        return failure(error);
      }
    }
  );
}
