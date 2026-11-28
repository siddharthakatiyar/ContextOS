import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import { retrieveWorkspace } from '../../src/core/workspace/retrieval.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import {
  rankSavedKnowledge,
  knowledgeRelevance,
  rawChunkMultiplier
} from '../../src/core/retrieval/knowledge-ranking.js';
import { compileRankedContext } from '../../src/core/retrieval/knowledge-assembly.js';
import type { RetrievalResult } from '../../src/core/retrieval/types.js';
import { detectIntent } from '../../src/core/retrieval/intent-detector.js';
import { responseTokens } from '../../src/mcp/response-budget.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';
import { estimateTokens } from '../../src/utils/tokens.js';
import { scoreChunks } from '../../src/core/retrieval/scorer.js';

describe('knowledge ranking', () => {
  it('excerpts oversized saved knowledge within compact budgets and preserves XML framing', () => {
    const content = 'Billing refunds require a signed credit note <ledger> & approval. '.repeat(
      200
    );
    const result: RetrievalResult = {
      chunks: [
        {
          id: 'saved',
          content,
          score: 100,
          sourceFile: 'memory.fact',
          sectionTitle: 'verified knowledge',
          repoName: 'billing & ledger',
          layer: 'repo',
          hash: 'saved',
          tokenCount: estimateTokens(content)
        } as RetrievalResult['chunks'][number]
      ],
      intent: detectIntent('billing refunds'),
      expandedEntities: [],
      latencyMs: 0
    };
    for (const maxTokens of [80, 250, 2000]) {
      for (const outputFormat of ['markdown', 'xml'] as const) {
        const compiled = compileRankedContext(result, {
          maxTokens,
          maxExactTokens: maxTokens,
          outputFormat,
          explain: true
        });
        expect(compiled.tokenCount).toBe(estimateTokens(compiled.output));
        expect(compiled.tokenCount).toBeLessThanOrEqual(maxTokens);
        expect(compiled.output).toContain('Billing refunds');
        expect(compiled.diagnostics?.includedChunks).toEqual([
          { id: 'saved', representation: 'excerpt' }
        ]);
        expect(compiled.diagnostics?.omittedChunkIds).toEqual([]);
        if (outputFormat === 'xml') {
          expect(compiled.output).toMatch(
            /^<contextos_context>\n<knowledge[\s\S]*<\/knowledge>\n<\/contextos_context>\n$/
          );
          expect(compiled.output).toContain('repo="billing &amp; ledger"');
          expect(compiled.output).not.toContain('<ledger>');
        }
      }
    }
  });

  it('requires meaningful exact tokens and demotes config only when not explicitly requested', () => {
    expect(knowledgeRelevance('What does it do?', 'it does the work')).toBe(0);
    expect(knowledgeRelevance('billing', 'rebilling')).toBe(0);
    expect(knowledgeRelevance('billing refunds', 'billing refunds require a credit')).toBe(3);
    for (const file of [
      'package.json',
      'pnpm-lock.yaml',
      'settings.toml',
      '.env',
      'service.config.ts'
    ]) {
      const chunk = { sourceFile: file } as RetrievalResult['chunks'][number];
      expect(rawChunkMultiplier('billing refunds', chunk)).toBe(0.2);
      expect(rawChunkMultiplier('config for billing refunds', chunk)).toBe(1);
      expect(rawChunkMultiplier(`show ${file}`, chunk)).toBe(1);
    }
    expect(
      rawChunkMultiplier('billing refunds', {
        sourceFile: 'billing.ts'
      } as RetrievalResult['chunks'][number])
    ).toBe(1);
    const chunk = {
      id: 'config',
      sourceFile: '/app/settings.json',
      content: 'billing refunds',
      score: 20,
      layer: 'repo',
      importance: 5
    } as RetrievalResult['chunks'][number];
    const score = (prompt: string) =>
      scoreChunks([chunk], [], {}, { prompt, selectedRepo: true })[0].score;
    expect(score('billing refunds') / score('config billing refunds')).toBeCloseTo(0.2);
    const lock = { ...chunk, sourceFile: '/app/yarn.lock' };
    expect(scoreChunks([lock], [], {}, { prompt: 'show yarn.lock' })).toHaveLength(1);
    expect(scoreChunks([lock], [], {}, { prompt: 'billing refunds' })).toHaveLength(0);
  });

  it('reads lifecycle columns, reserves verified facts/links, boosts evidence and keeps deterministic ties', async () => {
    const f = await createFixtureGroup();
    const graph = new GraphStore({
      home: f.registry.home,
      resolve: (id) => {
        const source = f.registry.resolve(id);
        return { source, db: f.runtime.get(source).db.getInstance() };
      }
    });
    try {
      const [a, b] = f.sources;
      const ids = f.sources.map((s) => s.repoId);
      const expectedGenerations = Object.fromEntries(
        f.sources.map((s) => [s.repoId, s.generation])
      );
      const ref = (source: typeof a) => {
        const row = f.runtime
          .get(source)
          .db.getInstance()
          .prepare("SELECT id FROM chunks WHERE source_file LIKE '%/src/%' ORDER BY id LIMIT 1")
          .get() as { id: string };
        return entityRef(source.repoId, 'chunk', row.id);
      };
      const fact = graph.remember(
        {
          content: 'Billing authorization requires a signed ledger entry',
          scope: 'view',
          scopeId: a.repoId,
          viewIds: [a.repoId],
          provenance: 'code',
          evidenceRefs: [ref(a)],
          expectedGenerations
        },
        ids
      );
      const proposed = graph.remember(
        {
          content: 'Billing authorization proposed policy',
          scope: 'view',
          scopeId: a.repoId,
          viewIds: [a.repoId],
          provenance: 'code',
          evidenceRefs: [ref(a)],
          expectedGenerations,
          status: 'proposed'
        },
        ids
      );
      const stale = graph.remember(
        {
          content: 'Billing authorization stale policy',
          scope: 'view',
          scopeId: a.repoId,
          viewIds: [a.repoId],
          provenance: 'code',
          evidenceRefs: [ref(a)],
          expectedGenerations,
          status: 'stale'
        },
        ids
      );
      const link = graph.link(
        {
          source: ref(a),
          target: ref(b),
          type: 'calls_api',
          rationale: 'Billing authorization calls the worker',
          expectedGenerations
        },
        ids
      );
      const proposedLink = graph.link(
        {
          source: ref(a),
          target: ref(b),
          type: 'publishes_event',
          rationale: 'Billing authorization proposed relationship',
          expectedGenerations,
          status: 'proposed'
        },
        ids
      );
      const staleLink = graph.link(
        {
          source: ref(a),
          target: ref(b),
          type: 'consumes_event',
          rationale: 'Billing authorization stale relationship',
          expectedGenerations,
          status: 'stale'
        },
        ids
      );
      const legacy = new KnowledgeStore(f.runtime.get(a).db);
      const old = legacy.learnFact('Billing authorization uses a proposed legacy flow', 'general', {
        status: 'proposed'
      });
      const scope = f.registry.select(
        { group: f.group.id, allRepos: true },
        a.rootPath,
        f.group.id,
        a.repoId
      );
      const base: RetrievalResult = {
        chunks: [
          {
            id: ref(a),
            content: 'billing authorization',
            score: 100,
            sourceFile: 'handler.ts',
            layer: 'repo',
            hash: 'evidence'
          } as RetrievalResult['chunks'][number]
        ],
        scope,
        intent: detectIntent('billing authorization'),
        expandedEntities: [],
        latencyMs: 0
      };
      const run = () => {
        const result = structuredClone(base);
        rankSavedKnowledge(result, f.runtime, graph, new Map([[a.repoId, legacy.getAllFacts()]]));
        return result;
      };
      const result = run();
      expect(
        result.chunks
          .slice(0, 2)
          .map((c) => c.localId)
          .sort()
      ).toEqual([fact.id, link.id].sort());
      expect(result.chunks.find((c) => c.id === ref(a))?.score).toBe(130);
      const positions = new Map(result.chunks.map((c, i) => [c.localId, i]));
      expect(positions.has(proposed.id)).toBe(true);
      expect(positions.has(stale.id)).toBe(false);
      expect(positions.get(proposedLink.id)).toBeGreaterThan(1);
      expect(positions.has(staleLink.id)).toBe(false);
      expect(positions.get(old)).toBeGreaterThan(1);
      expect(run().chunks.map((c) => [c.id, c.score])).toEqual(
        result.chunks.map((c) => [c.id, c.score])
      );
      expect(
        graph.searchFacts('Billing', { viewIds: ids, limit: 100 }).find((v) => v.id === proposed.id)
          ?.status
      ).toBe('proposed');
      for (const outputFormat of ['markdown', 'xml'] as const) {
        const compiled = compileRankedContext(result, {
          maxTokens: 250,
          maxExactTokens: 250,
          outputFormat,
          explain: true
        });
        expect(compiled.tokenCount).toBeLessThanOrEqual(250);
        expect(compiled.output).toContain('Billing authorization');
        if (compiled.output.includes('handler.ts'))
          expect(compiled.output.indexOf('Billing authorization')).toBeLessThan(
            compiled.output.indexOf('handler.ts')
          );
        expect(compiled.diagnostics?.includedChunks[0].id).toBe(result.chunks[0].id);
        if (outputFormat === 'xml')
          expect(compiled.output).toMatch(/^<contextos_context>[\s\S]*<\/contextos_context>\n$/);
      }
    } finally {
      graph.close();
      await f.cleanup();
    }
  }, 30000);

  it('keeps role anchors without repeated repo names and rejects foreign/unavailable scope', async () => {
    const f = await createFixtureGroup();
    const graph = new GraphStore({
      home: f.registry.home,
      resolve: (id) => {
        const source = f.registry.resolve(id);
        return { source, db: f.runtime.get(source).db.getInstance() };
      }
    });
    try {
      const [a, b] = f.sources;
      const ids = f.sources.map((s) => s.repoId);
      const anchor = graph.remember(
        {
          content: 'Owns order intake and payment orchestration',
          category: 'role',
          scope: 'view',
          scopeId: b.repoId,
          viewIds: [b.repoId],
          provenance: 'user'
        },
        ids
      );
      const foreign = graph.remember(
        {
          content: 'service-b foreign group secret',
          scope: 'group',
          scopeId: 'foreign-group',
          viewIds: [a.repoId],
          provenance: 'user'
        },
        ids,
        { groupId: 'foreign-group' }
      );
      const scope = f.registry.select(
        { group: f.group.id, allRepos: true },
        a.rootPath,
        f.group.id,
        a.repoId
      );
      const make = (): RetrievalResult => ({
        scope,
        chunks: [],
        expandedEntities: [],
        latencyMs: 0,
        intent: detectIntent('What does service-b do?')
      });
      const result = make();
      rankSavedKnowledge(result, f.runtime, graph);
      expect(result.chunks[0].localId).toBe(anchor.id);
      expect(result.chunks.some((c) => c.localId === foreign.id)).toBe(false);
      const failed = make();
      failed.unavailableSources = [{ repoId: b.repoId, name: b.name, error: 'changed' }];
      rankSavedKnowledge(failed, f.runtime, graph);
      expect(failed.chunks.some((c) => c.localId === anchor.id)).toBe(false);
      const scoped = make();
      scoped.scope = f.registry.select(
        { project: [a.projectId] },
        a.rootPath,
        f.group.id,
        a.repoId
      );
      rankSavedKnowledge(scoped, f.runtime, graph);
      expect(scoped.chunks).toHaveLength(0);
      const legacy = new KnowledgeStore(f.runtime.get(b).db);
      const legacyRole = legacy.learnFact('Runs fulfillment tasks', 'overview');
      graph.forget(anchor.id, ids);
      const legacyResult = make();
      rankSavedKnowledge(
        legacyResult,
        f.runtime,
        graph,
        new Map([[b.repoId, legacy.getAllFacts()]])
      );
      expect(legacyResult.chunks[0].localId).toBe(legacyRole);
    } finally {
      graph.close();
      await f.cleanup();
    }
  }, 30000);

  it('surfaces verified knowledge in compact MCP text, bounds envelopes and honors layers', async () => {
    const f = await createFixtureGroup();
    const graph = new GraphStore({
      home: f.registry.home,
      resolve: (id) => {
        const source = f.registry.resolve(id);
        return { source, db: f.runtime.get(source).db.getInstance() };
      }
    });
    const server = new McpServer({ name: 'ranking', version: 'test' });
    const client = new Client({ name: 'test', version: 'test' });
    try {
      const a = f.sources[0];
      graph.remember(
        {
          content: 'Billing refunds require a credit note',
          scope: 'view',
          scopeId: a.repoId,
          viewIds: [a.repoId],
          provenance: 'user'
        },
        [a.repoId]
      );
      registerWorkspaceTools(server, f.runtime, { cwd: a.rootPath, activeRepoId: a.repoId });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(left);
      await client.connect(right);
      for (const output_format of ['markdown', 'xml']) {
        const response = await client.callTool({
          name: 'get_context',
          arguments: {
            prompt: 'billing refunds',
            all_repos: true,
            output_format,
            layers: ['repo']
          }
        });
        const text = (response.content as { text: string }[])[0].text;
        expect(text).toContain('Billing refunds require a credit note');
        expect(estimateTokens(text)).toBeLessThanOrEqual(250);
      }
      const bounded = await client.callTool({
        name: 'get_context',
        arguments: {
          prompt: 'billing refunds',
          all_repos: true,
          max_tokens: 600,
          layers: ['repo']
        }
      });
      expect(responseTokens(bounded as Parameters<typeof responseTokens>[0])).toBeLessThanOrEqual(
        600
      );
      expect(JSON.stringify(bounded.content)).toContain('Billing refunds');
      const excluded = await client.callTool({
        name: 'get_context',
        arguments: {
          prompt: 'billing refunds',
          all_repos: true,
          layers: ['session']
        }
      });
      expect(JSON.stringify(excluded.content)).not.toContain('credit note');
      // Ranking never writes lifecycle status or creates knowledge records.
      expect(graph.exportKnowledge(f.sources.map((s) => s.repoId)).facts).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
      graph.close();
      await f.cleanup();
    }
  }, 30000);

  it('uses fresh graph evidence and does not resurrect invalidated facts', async () => {
    const f = await createFixtureGroup();
    const graph = new GraphStore({
      home: f.registry.home,
      resolve: (id) => {
        const source = f.registry.resolve(id);
        return { source, db: f.runtime.get(source).db.getInstance() };
      }
    });
    try {
      const a = f.sources[0];
      const row = f.runtime
        .get(a)
        .db.getInstance()
        .prepare(
          "SELECT id, source_file FROM chunks WHERE source_file LIKE '%/src/%' ORDER BY id LIMIT 1"
        )
        .get() as { id: string; source_file: string };
      const fact = graph.remember(
        {
          content: 'Billing refunds code evidence',
          scope: 'view',
          scopeId: a.repoId,
          viewIds: [a.repoId],
          provenance: 'code',
          evidenceRefs: [entityRef(a.repoId, 'chunk', row.id)],
          expectedGenerations: { [a.repoId]: a.generation }
        },
        [a.repoId]
      );
      fs.appendFileSync(row.source_file, '\n// changed billing evidence\n');
      const scope = f.registry.select(
        { group: f.group.id, allRepos: true },
        a.rootPath,
        f.group.id,
        a.repoId
      );
      const result = await retrieveWorkspace(f.runtime, scope, 'Billing refunds');
      rankSavedKnowledge(result, f.runtime, graph);
      expect(result.chunks.some((c) => c.localId === fact.id)).toBe(false);
    } finally {
      graph.close();
      await f.cleanup();
    }
  }, 30000);
});
