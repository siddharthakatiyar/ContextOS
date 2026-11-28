import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore, type LinkType } from '../../src/core/knowledge/graph-store.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { scenarios } from '../../validation/ranking-benchmark/questions.js';

it('surfaces saved group knowledge in the first five compiled hits within budget', async () => {
  const f = await createFixtureGroup();
  const graph = new GraphStore({
    home: f.registry.home,
    resolve: (id) => {
      const source = f.registry.resolve(id);
      return { source, db: f.runtime.get(source).db.getInstance() };
    }
  });
  const server = new McpServer({ name: 'ranking', version: 'test' });
  const client = new Client({ name: 'benchmark', version: 'test' });
  try {
    // Real indexed JSON distractors repeat domain terms without containing the answers.
    for (const source of f.sources) {
      for (let i = 0; i < 12; i++)
        fs.writeFileSync(
          path.join(source.rootPath, `settings-${i}.json`),
          JSON.stringify({
            billing: 'refunds taxes subscription proration failed charges',
            infra: 'ledger database checkout sessions cache invoice snapshots payment secrets',
            config:
              'settlement retry limit connection pooling receipt processing currency rounding',
            queues:
              'fulfillment queue receipt queue fraud gateway exchange adapter inventory resource',
            owner: source.name,
            index: i
          })
        );
      await f.runtime.get(source).index();
    }
    const sources = f.sources.map((s) => f.registry.resolve(s.repoId));
    const ids = sources.map((s) => s.repoId);
    const generations = Object.fromEntries(sources.map((s) => [s.repoId, s.generation]));
    const refs = sources.map((s) => {
      const row = f.runtime
        .get(s)
        .db.getInstance()
        .prepare("SELECT id FROM chunks WHERE source_file LIKE '%/src/%' ORDER BY id LIMIT 1")
        .get() as { id: string };
      return entityRef(s.repoId, 'chunk', row.id);
    });
    const expected = scenarios.map(([category, , content], i) => {
      if (category === 'link') {
        const types: LinkType[] = [
          'calls_api',
          'publishes_event',
          'consumes_event',
          'calls_api',
          'reads_resource'
        ];
        const n = i - 15;
        return graph.link(
          {
            source: refs[n === 3 ? 1 : 0],
            target: refs[n >= 3 ? 2 : 1],
            type: types[n],
            rationale: content,
            expectedGenerations: generations
          },
          ids
        ).id;
      }
      const owner = sources[category === 'role' || category === 'overview' ? i - 12 : i % 3];
      return graph.remember(
        {
          content,
          category,
          scope: 'view',
          scopeId: owner.repoId,
          viewIds: [owner.repoId],
          provenance: 'user'
        },
        ids
      ).id;
    });
    registerWorkspaceTools(server, f.runtime, { cwd: sources[0].rootPath, activeRepoId: ids[0] });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    const rows = [];
    for (let i = 0; i < scenarios.length; i++) {
      const [category, prompt] = scenarios[i];
      const response = await client.callTool({
        name: 'get_context',
        arguments: {
          prompt,
          all_repos: true,
          layers: ['repo'],
          tier: 'full',
          max_tokens: 2000
        }
      });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const data = response.structuredContent as { chunks: { ref: string }[]; tokens: number };
      const position = data.chunks.findIndex((c) => c.ref.endsWith(':' + expected[i]));
      rows.push({
        category,
        prompt,
        firstExpectedRank: position < 0 ? null : position + 1,
        recallAt5: position >= 0 && position < 5 ? 1 : 0,
        tokens: data.tokens
      });
    }
    const metrics = {
      questions: rows.length,
      recallAt5: rows.reduce((s, r) => s + r.recallAt5, 0) / rows.length,
      surfaced: rows.filter((r) => r.firstExpectedRank !== null).length,
      meanFirstExpectedRank:
        rows.reduce((s, r) => s + (r.firstExpectedRank ?? 31), 0) / rows.length,
      meanTokens: rows.reduce((s, r) => s + r.tokens, 0) / rows.length,
      maxTokens: Math.max(...rows.map((r) => r.tokens)),
      rows
    };
    if (process.env.RANKING_BENCHMARK_OUTPUT)
      fs.writeFileSync(
        process.env.RANKING_BENCHMARK_OUTPUT,
        JSON.stringify(metrics, null, 2) + '\n'
      );
    console.log(JSON.stringify({ ...metrics, rows: undefined }));
    if (process.env.RANKING_BASELINE !== '1') {
      expect(metrics.recallAt5).toBeGreaterThanOrEqual(0.95);
      expect(metrics.surfaced).toBe(20);
      expect(metrics.meanFirstExpectedRank).toBeLessThanOrEqual(3);
    }
    expect(metrics.maxTokens).toBeLessThanOrEqual(2000);
  } finally {
    await client.close();
    await server.close();
    graph.close();
    await f.cleanup();
  }
}, 60000);
