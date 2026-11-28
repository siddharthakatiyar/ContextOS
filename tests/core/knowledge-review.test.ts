import { registerGetContextTool } from '../../src/mcp/tools/get-context.js';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import {
  listKnowledge,
  setKnowledgeStatus,
  deleteByTask
} from '../../src/core/knowledge/review.js';
import {
  compactKnowledgeMetadata,
  resolveKnowledgeWriteContext,
  resolveMcpKnowledgeWriteContext
} from '../../src/core/knowledge/write-context.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import {
  registerKnowledgeTools,
  registerLegacyKnowledgeTools
} from '../../src/mcp/tools/knowledge.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';
import { loadConfig, validateConfigJson } from '../../src/config/index.js';
import { retrieveWorkspace } from '../../src/core/workspace/retrieval.js';

it.each([
  [{}, {}, 'verified'],
  [{}, { env: { CONTEXTOS_REVIEW_MODE: '1' } }, 'proposed'],
  [{}, { review: true }, 'proposed'],
  [{ status: 'verified' }, { review: true }, 'verified'],
  [{ status: 'stale' }, { review: true }, 'stale'],
  [{ provenance: 'user', status: 'proposed' }, { review: true }, 'verified']
] as const)('applies MCP policy %j / %j', (params, options, status) => {
  expect(resolveMcpKnowledgeWriteContext(params, { env: {}, ...options }).status).toBe(status);
});

it('resolves attribution precedence without applying MCP policy to CLI/core writes', () => {
  const env = {
    CONTEXTOS_AUTHOR: 'env',
    CONTEXTOS_TASK_ID: 'task-env',
    CONTEXTOS_MODEL: 'model-env',
    CONTEXTOS_REVIEW_MODE: '1'
  };
  expect(resolveMcpKnowledgeWriteContext({}, { env, clientName: 'codex' })).toMatchObject({
    author: 'env',
    taskId: 'task-env',
    model: 'model-env',
    status: 'proposed'
  });
  expect(
    resolveMcpKnowledgeWriteContext(
      { author: 'explicit', task_id: 'task', model: 'model' },
      { env, clientName: 'codex' }
    )
  ).toMatchObject({ author: 'explicit', taskId: 'task', model: 'model' });
  expect(resolveMcpKnowledgeWriteContext({}, { env: {}, clientName: 'codex' }).author).toBe(
    'codex'
  );
  expect(resolveKnowledgeWriteContext({}, env).status).toBe('verified');
  expect(compactKnowledgeMetadata({ status: 'verified' })).toEqual({});
  expect(compactKnowledgeMetadata({ status: 'stale', author: 'a', taskId: 't' })).toEqual({
    status: 'stale',
    author: 'a',
    taskId: 't'
  });
  expect(validateConfigJson({ knowledge: { review: true } })).toEqual({
    knowledge: { review: true }
  });
  expect(validateConfigJson({ knowledge: { review: 'yes' } })).toBeNull();
});

async function fixture() {
  const f = await createFixtureGroup();
  const source = f.sources[0];
  const resolve = (id: string) => {
    const source = f.registry.resolve(id);
    return { source, db: f.runtime.get(source).db.getInstance() };
  };
  const graph = new GraphStore({ home: f.registry.home, resolve });
  const scope = f.registry.select({}, source.rootPath);
  const options = { scope, home: f.registry.home };
  const anchor = (file: string) => {
    const row = resolve(source.repoId)
      .db.prepare(
        "SELECT id FROM chunks WHERE source_file=? AND section_title='File Structure' LIMIT 1"
      )
      .get(path.join(source.rootPath, 'src', file)) as { id: string };
    return entityRef(source.repoId, 'chunk', row.id);
  };
  const input = {
    source: anchor('client.ts'),
    target: anchor('server.ts'),
    type: 'calls_api' as const,
    rationale: 'createOrder posts to the service A order handler.',
    expectedGenerations: { [source.repoId]: source.generation }
  };
  const store = new KnowledgeStore(f.runtime.get(source).db);
  return {
    ...f,
    source,
    graph,
    options,
    input,
    anchor,
    scope,
    store,
    cleanup: async () => {
      graph.close();
      await f.cleanup();
    }
  };
}

describe('persisted review operations', () => {
  it('lists filters, transitions every store, invalidates revisions and deletes only the selected task/scope', async () => {
    const f = await fixture();
    try {
      const context = { author: 'codex', taskId: 'a1', model: 'test', status: 'proposed' as const };
      const link = f.graph.link({ ...f.input, ...context }, f.scope.repoIds);
      const fact = f.graph.remember(
        {
          ...context,
          content: 'order handler architecture',
          scope: 'view',
          scopeId: f.source.repoId,
          viewIds: f.scope.repoIds,
          provenance: 'code',
          evidenceRefs: [f.input.source],
          expectedGenerations: f.input.expectedGenerations
        },
        f.scope.repoIds
      );
      const legacy = f.store.learnFact('order handler preference', 'general', context);
      f.store.learnFact('another task', 'general', { taskId: 'other' });
      const otherSource = f.sources[1];
      new KnowledgeStore(f.runtime.get(otherSource).db).learnFact(
        'outside selected view',
        'general',
        context
      );
      expect(
        listKnowledge({ ...f.options, status: 'proposed', taskId: 'a1', author: 'codex' })
      ).toHaveLength(3);
      expect(listKnowledge({ ...f.options, taskId: 'missing' })).toEqual([]);
      expect(
        listKnowledge({ cwd: f.source.rootPath, home: f.registry.home, taskId: 'a1' })
      ).toHaveLength(3);
      const ids = [link.id, fact.id, legacy];
      const revision = f.graph.revision();
      expect(() => setKnowledgeStatus([...ids, 'missing'], 'verified', f.options)).toThrow(
        'selected scope'
      );
      expect(listKnowledge({ ...f.options, status: 'proposed' })).toHaveLength(3);
      expect(
        setKnowledgeStatus(ids, 'verified', f.options).every((r) => r.status === 'verified')
      ).toBe(true);
      expect(f.graph.revision()).toBeGreaterThan(revision);
      expect(f.graph.getLink(link.id, f.scope.repoIds)).toMatchObject({
        status: 'verified',
        author: 'codex',
        taskId: 'a1',
        model: 'test',
        verifiedAt: expect.any(Number)
      });
      expect(f.store.getAllFacts().find((r) => r.id === legacy)?.verified_at).toEqual(
        expect.any(Number)
      );
      expect(() => setKnowledgeStatus(ids, 'proposed', f.options)).toThrow(
        'Invalid knowledge status transition'
      );
      setKnowledgeStatus(ids, 'stale', f.options);
      expect(f.graph.listLinks({ includeStale: true })[0].status).toBe('stale');
      expect(
        f.graph.trace({ start: f.input.source, target: f.input.target }, f.scope.repoIds).found
      ).toBe(false);
      setKnowledgeStatus(ids, 'verified', f.options);
      expect(deleteByTask('a1', { ...f.options, dryRun: true }).count).toBe(3);
      expect(listKnowledge({ ...f.options, taskId: 'a1' })).toHaveLength(3);
      expect(deleteByTask('a1', f.options)).toMatchObject({ count: 3, dryRun: false });
      expect(listKnowledge({ ...f.options, taskId: 'a1' })).toEqual([]);
      expect(f.store.getAllFacts()).toHaveLength(1);
      expect(new KnowledgeStore(f.runtime.get(otherSource).db).getAllFacts()).toHaveLength(1);
      expect(() => deleteByTask('', f.options)).toThrow('non-empty');
      expect(deleteByTask('missing', f.options).count).toBe(0);
      const audits = fs
        .readFileSync(path.join(f.registry.home, 'knowledge-audit.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      expect(audits.map((a) => a.id).sort()).toEqual(ids.sort());
    } finally {
      await f.cleanup();
    }
  }, 30000);

  it('keeps proposals out of confirmed paths, ranks them below verified facts and marks stale records', async () => {
    const f = await fixture();
    try {
      const link = f.graph.link(
        { ...f.input, status: 'proposed', taskId: 'proposal' },
        f.scope.repoIds
      );
      expect(f.graph.expand([f.input.source], f.scope.repoIds).links).toEqual([]);
      expect(
        f.graph.expand([f.input.source], f.scope.repoIds, 12, undefined, true).links
      ).toHaveLength(1);
      expect(
        f.graph.trace({ start: f.input.source, target: f.input.target }, f.scope.repoIds).found
      ).toBe(false);
      const trace = f.graph.trace(
        { start: f.input.source, target: f.input.target, includeProposed: true },
        f.scope.repoIds
      );
      expect(trace.found).toBe(true);
      expect(trace.coverage).toBe('recorded_links_including_proposed');
      expect(trace.links[0].status).toBe('proposed');
      f.store.learnFact('order architecture proposed legacy', 'general', { status: 'proposed' });
      f.store.learnFact('order architecture verified legacy', 'general', { status: 'verified' });
      expect(f.store.searchFacts('order architecture')[0].status).toBe('verified');
      const fact = {
        scope: 'view' as const,
        scopeId: f.source.repoId,
        viewIds: f.scope.repoIds,
        provenance: 'code' as const,
        evidenceRefs: [f.input.source],
        expectedGenerations: f.input.expectedGenerations
      };
      f.graph.remember(
        { ...fact, content: 'order architecture proposal', status: 'proposed', taskId: 'proposal' },
        f.scope.repoIds
      );
      f.graph.remember(
        { ...fact, content: 'order architecture verified', status: 'verified' },
        f.scope.repoIds
      );
      const stale = f.graph.remember(
        { ...fact, content: 'order architecture stale', status: 'stale' },
        f.scope.repoIds
      );
      expect(
        f.graph.searchFacts('order architecture', { viewIds: f.scope.repoIds })[0].status
      ).toBe('verified');
      const result = await retrieveWorkspace(f.runtime, f.scope, 'order architecture', {
        layers: ['repo']
      });
      const facts = result.chunks.filter((c) => c.sourceFile === 'memory.fact');
      expect(facts.find((c) => c.content.includes('verified'))!.score).toBeGreaterThan(
        facts.find((c) => c.content.includes('proposal'))!.score
      );
      // Stale knowledge (evidence no longer holds) is hidden from default retrieval.
      expect(facts.find((c) => c.localId === stale.id)).toBeUndefined();
      expect(result.knowledgeLinks).not.toContainEqual(expect.objectContaining({ id: link.id }));
      expect(f.graph.exportKnowledge(f.scope.repoIds).links).toContainEqual(
        expect.objectContaining({ id: link.id, status: 'proposed' })
      );
      const deterministic = f.graph.linkResolvedImport(
        { ...f.input, type: 'imports', author: 'override', status: 'proposed' },
        f.scope.repoIds
      );
      expect(deterministic.link).toMatchObject({
        author: 'contextos:deterministic',
        status: 'verified'
      });
      f.graph.link({ ...f.input, type: 'imports', status: 'proposed' }, f.scope.repoIds);
      expect(
        f.graph.linkResolvedImport({ ...f.input, type: 'imports' }, f.scope.repoIds).link.status
      ).toBe('verified');
    } finally {
      await f.cleanup();
    }
  }, 30000);
});

it('records real MCP client attribution, review config, compact reads and deletion provenance', async () => {
  const f = await fixture();
  const server = new McpServer({ name: 'a1-test', version: 'test' });
  const client = new Client({ name: 'codex-test-client', version: 'test' });
  try {
    vi.stubEnv('CONTEXTOS_AUTHOR', '');
    delete process.env.CONTEXTOS_AUTHOR;
    vi.stubEnv('CONTEXTOS_TASK_ID', 'mcp-task');
    vi.stubEnv('CONTEXTOS_MODEL', 'mcp-model');
    vi.stubEnv('CONTEXTOS_REVIEW_MODE', '1');
    registerWorkspaceTools(server, f.runtime, {
      cwd: f.source.rootPath,
      activeRepoId: f.source.repoId
    });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result.structuredContent as Record<string, unknown>;
    };
    const remembered = await call('ctx_remember', {
      content: 'order architecture agent',
      provenance: 'code',
      evidence: [f.input.source],
      expected_generations: f.input.expectedGenerations
    });
    const id = remembered.id as string;
    expect(listKnowledge({ ...f.options, taskId: 'mcp-task' })).toContainEqual(
      expect.objectContaining({
        id,
        author: 'codex-test-client',
        status: 'proposed',
        model: 'mcp-model'
      })
    );
    await call('ctx_remember', {
      content: 'order architecture user',
      provenance: 'user',
      status: 'proposed'
    });
    expect(
      f.graph
        .searchFacts('order architecture user', { viewIds: f.scope.repoIds })
        .find((r) => r.provenance === 'user')?.status
    ).toBe('verified');
    const linked = await call('ctx_link', {
      source: f.input.source,
      target: f.input.target,
      relationship: f.input.type,
      rationale: f.input.rationale,
      expected_generations: f.input.expectedGenerations
    });
    const linkId = (linked.link as { id: string }).id;
    expect((await call('ctx_links', {})).total).toBe(0);
    expect((await call('ctx_links', { include_proposed: true })).links).toEqual([
      expect.objectContaining({
        id: linkId,
        author: 'codex-test-client',
        taskId: 'mcp-task',
        status: 'proposed'
      })
    ]);
    expect((await call('ctx_trace', { start: f.input.source, target: f.input.target })).found).toBe(
      false
    );
    expect(
      (
        await call('ctx_trace', {
          start: f.input.source,
          target: f.input.target,
          include_proposed: true
        })
      ).found
    ).toBe(true);
    expect((await call('ctx_scope', {})).knowledge).toContainEqual(
      expect.objectContaining({ id, status: 'proposed', author: 'codex-test-client' })
    );
    const retrieved = await call('get_context', {
      prompt: 'order architecture',
      tier: 'full',
      include_proposed: true
    });
    expect(retrieved.knowledgeLinks).toContainEqual(
      expect.objectContaining({ id: linkId, status: 'proposed' })
    );
    expect(retrieved.chunks).toContainEqual(
      expect.objectContaining({
        status: 'proposed',
        author: 'codex-test-client',
        taskId: 'mcp-task'
      })
    );
    await call('ctx_forget', {
      id,
      author: 'deleter',
      task_id: 'delete-task',
      model: 'delete-model'
    });
    await call('ctx_unlink', { id: linkId, author: 'unlinker', task_id: 'unlink-task' });
    const audits = fs
      .readFileSync(path.join(f.registry.home, 'knowledge-audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(audits).toContainEqual(
      expect.objectContaining({
        operation: 'forget',
        id,
        author: 'deleter',
        taskId: 'delete-task',
        model: 'delete-model'
      })
    );
    expect(audits).toContainEqual(
      expect.objectContaining({
        operation: 'unlink',
        id: linkId,
        author: 'unlinker',
        taskId: 'unlink-task',
        model: 'mcp-model'
      })
    );
    const note = await call('ctx_remember', {
      content: 'temporary task context',
      type: 'session_note'
    });
    await call('ctx_forget', { id: note.id });
    const noteAudits = fs
      .readFileSync(path.join(f.registry.home, 'knowledge-audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(noteAudits).toContainEqual(
      expect.objectContaining({
        operation: 'remember_session',
        id: note.id,
        author: 'codex-test-client',
        taskId: 'mcp-task'
      })
    );
    expect(noteAudits).toContainEqual(
      expect.objectContaining({ operation: 'forget', id: note.id, author: 'codex-test-client' })
    );
    vi.stubEnv('CONTEXTOS_REVIEW_MODE', '0');
    fs.mkdirSync(path.join(f.source.rootPath, '.contextos'), { recursive: true });
    fs.writeFileSync(
      path.join(f.source.rootPath, '.contextos/config.json'),
      JSON.stringify({ knowledge: { review: true } })
    );
    loadConfig({ cwd: f.source.rootPath, forceReload: true });
    await call('ctx_remember', {
      content: 'order configuration review',
      provenance: 'code',
      evidence: [f.input.source],
      expected_generations: f.input.expectedGenerations
    });
    expect(
      f.graph.searchFacts('configuration review', { viewIds: f.scope.repoIds })[0].status
    ).toBe('proposed');
  } finally {
    await client.close();
    await server.close();
    vi.unstubAllEnvs();
    await f.cleanup();
  }
}, 30000);

it('supports legacy MCP writes and deletions while direct core writes stay verified in review mode', async () => {
  const f = await fixture();
  const server = new McpServer({ name: 'legacy-a1', version: 'test' });
  const client = new Client({ name: 'legacy-client', version: 'test' });
  try {
    vi.stubEnv('CONTEXTOS_REVIEW_MODE', '1');
    vi.stubEnv('CONTEXTOS_TASK_ID', 'legacy-task');
    vi.stubEnv('CONTEXTOS_MODEL', 'legacy-model');
    registerKnowledgeTools(server, [f.runtime.get(f.source).db]);
    registerLegacyKnowledgeTools(server, [f.runtime.get(f.source).db]);
    registerGetContextTool(server, [f.runtime.get(f.source).db]);
    const [left, right] = InMemoryTransport.createLinkedPair();
    await server.connect(left);
    await client.connect(right);
    const remember = await client.callTool({
      name: 'ctx_remember',
      arguments: { type: 'cross_session_fact', content: 'Legacy remembered fact' }
    });
    expect(remember.isError).not.toBe(true);
    const learned = await client.callTool({
      name: 'learn_fact',
      arguments: { fact: 'Legacy learned fact', author: 'explicit' }
    });
    expect(learned.isError).not.toBe(true);
    const facts = f.store.getAllFacts();
    expect(facts).toContainEqual(
      expect.objectContaining({
        author: 'legacy-client',
        status: 'proposed',
        task_id: 'legacy-task',
        model: 'legacy-model'
      })
    );
    expect(facts).toContainEqual(
      expect.objectContaining({ author: 'explicit', status: 'proposed' })
    );
    const contextResult = await client.callTool({
      name: 'get_context',
      arguments: { prompt: 'Legacy remembered fact', tier: 'full', include_proposed: true }
    });
    expect(contextResult.isError, JSON.stringify(contextResult)).not.toBe(true);
    expect(JSON.stringify(contextResult.content)).toContain('proposed');
    expect(JSON.stringify(contextResult.content)).toContain('legacy-client');
    const learnedId = facts.find((r) => r.author === 'explicit')!.id;
    const rememberedId = facts.find((r) => r.author === 'legacy-client')!.id;
    expect(
      (
        await client.callTool({
          name: 'forget_fact',
          arguments: { id: learnedId, author: 'legacy-deleter' }
        })
      ).isError
    ).not.toBe(true);
    expect(
      (
        await client.callTool({
          name: 'ctx_remember',
          arguments: { type: 'forget_fact', content: rememberedId, author: 'remember-deleter' }
        })
      ).isError
    ).not.toBe(true);
    expect(f.store.getAllFacts()).toHaveLength(0);
    const directId = f.store.learnFact('Direct CLI-compatible write');
    expect(f.store.getAllFacts().find((r) => r.id === directId)?.status).toBe('verified');
    const audits = fs
      .readFileSync(path.join(f.registry.home, 'knowledge-audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
    expect(audits).toContainEqual(
      expect.objectContaining({
        id: learnedId,
        author: 'legacy-deleter',
        taskId: 'legacy-task',
        model: 'legacy-model'
      })
    );
    expect(audits).toContainEqual(
      expect.objectContaining({ id: rememberedId, author: 'remember-deleter' })
    );
  } finally {
    await client.close();
    await server.close();
    vi.unstubAllEnvs();
    await f.cleanup();
  }
}, 30000);
