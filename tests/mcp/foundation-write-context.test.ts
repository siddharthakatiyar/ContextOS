import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import { learnRetrievedImports } from '../../src/core/knowledge/import-learning.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { qualifyChunk } from '../../src/core/workspace/retrieval.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { exportCommand } from '../../src/cli/commands/export.js';
import { importCommand } from '../../src/cli/commands/import.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';

it('persists MCP/environment and deterministic contexts, then round-trips the CLI JSON', async () => {
  const f = await createFixtureGroup();
  const cwd = process.cwd();
  const exitCode = process.exitCode;
  const [a, b] = f.sources;
  const resolve = (id: string) => {
    const source = f.registry.resolve(id);
    return { source, db: f.runtime.get(source).db.getInstance() };
  };
  const graph = new GraphStore({ home: f.registry.home, resolve });
  const server = new McpServer({ name: 'foundation-context', version: 'test' });
  const client = new Client({ name: 'test', version: 'test' });
  try {
    vi.stubEnv('CONTEXTOS_AUTHOR', 'env-author');
    vi.stubEnv('CONTEXTOS_TASK_ID', 'env-task');
    vi.stubEnv('CONTEXTOS_MODEL', 'env-model');
    registerWorkspaceTools(server, f.runtime, { cwd: a.rootPath, activeRepoId: a.repoId });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    const remembered = await client.callTool({
      name: 'ctx_remember',
      arguments: {
        content: 'Foundation user choice',
        provenance: 'user'
      }
    });
    expect(remembered.isError).not.toBe(true);
    expect(graph.searchFacts('Foundation user', { viewIds: [a.repoId] })).toEqual([
      expect.objectContaining({
        author: 'env-author',
        taskId: 'env-task',
        model: 'env-model',
        status: 'verified'
      })
    ]);
    const aDb = f.runtime.get(a).db;
    const anchor = (file: string) => {
      const row = aDb
        .getInstance()
        .prepare(
          "SELECT id FROM chunks WHERE source_file=? AND section_title='File Structure' LIMIT 1"
        )
        .get(path.join(a.rootPath, 'src', file)) as { id: string };
      return entityRef(a.repoId, 'chunk', row.id);
    };
    const expiresAt = Date.now() + 60_000;
    const linked = await client.callTool({
      name: 'ctx_link',
      arguments: {
        source: anchor('client.ts'),
        target: anchor('server.ts'),
        relationship: 'calls_api',
        rationale: 'HTTP POST /orders from createOrder client to service A order handler.',
        expected_generations: { [a.repoId]: a.generation },
        author: 'explicit-author',
        task_id: 'explicit-task',
        model: 'explicit-model',
        status: 'proposed',
        namespace: 'task',
        expires_at: expiresAt
      }
    });
    expect(linked.isError).not.toBe(true);
    expect(graph.listLinks({ viewIds: [a.repoId] })).toEqual([
      expect.objectContaining({
        author: 'explicit-author',
        taskId: 'explicit-task',
        model: 'explicit-model',
        status: 'proposed',
        namespace: 'task',
        expiresAt
      })
    ]);
    const chunks = new ChunksRepo(resolve(b.repoId).db);
    const learned = await learnRetrievedImports(
      graph,
      f.sources,
      resolve,
      chunks
        .getByIds(chunks.getIdsBySource(path.join(b.rootPath, 'src/worker.ts')))
        .map((chunk) => qualifyChunk({ ...chunk, score: 1 }, b)),
      undefined,
      { taskId: 'resolver-task', author: 'resolver-author', status: 'verified' }
    );
    expect(learned.learnedLinks.length).toBeGreaterThan(0);
    expect(
      learned.learnedLinks.every(
        (link) => link.taskId === 'resolver-task' && link.author === 'contextos:deterministic'
      )
    ).toBe(true);
    // A later deterministic pass must preserve an existing author's context.
    expect(
      graph.linkResolvedImport(
        {
          ...learned.learnedLinks[0],
          expectedGenerations: Object.fromEntries(f.sources.map((s) => [s.repoId, s.generation])),
          taskId: 'replacement'
        },
        f.sources.map((s) => s.repoId)
      ).link.taskId
    ).toBe('resolver-task');
    const legacyStore = new KnowledgeStore(aDb);
    legacyStore.learnFact('Foundation legacy choice', 'general', {
      taskId: 'legacy-task',
      status: 'stale'
    });
    const file = path.join(f.root, 'knowledge.json');
    process.chdir(a.rootPath);
    await exportCommand.parseAsync(['node', 'export', file]);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(exported.data.knowledge_facts[0]).toMatchObject({
      task_id: 'legacy-task',
      status: 'stale'
    });
    expect(exported.data.knowledge.links[0]).toMatchObject({
      taskId: 'explicit-task',
      status: 'proposed'
    });
    const before = graph.exportKnowledge([a.repoId]);
    for (const link of before.links) graph.unlink(link.id, [a.repoId]);
    for (const fact of before.facts) graph.forget(fact.id, [a.repoId]);
    aDb.getInstance().exec('DELETE FROM knowledge_facts');
    process.exitCode = 0;
    await importCommand.parseAsync(['node', 'import', file]);
    expect(process.exitCode).toBe(0);
    expect(graph.exportKnowledge([a.repoId])).toEqual(before);
    expect(legacyStore.getAllFacts()[0]).toMatchObject({ task_id: 'legacy-task', status: 'stale' });
    // Truly old exports have neither knowledge section. They still import successfully.
    delete exported.data.knowledge;
    delete exported.data.knowledge_facts;
    fs.writeFileSync(file, JSON.stringify(exported));
    await importCommand.parseAsync(['node', 'import', file]);
    expect(process.exitCode).toBe(0);
  } finally {
    process.chdir(cwd);
    process.exitCode = exitCode;
    await client.close();
    await server.close();
    graph.close();
    vi.unstubAllEnvs();
    await f.cleanup();
  }
}, 30000);
