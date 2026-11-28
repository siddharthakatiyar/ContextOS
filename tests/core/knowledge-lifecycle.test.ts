import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import { SessionStore } from '../../src/core/session/session-store.js';
import { recordKnowledgeOperation } from '../../src/core/knowledge/audit.js';
import {
  listKnowledge,
  setKnowledgeStatus,
  listTasks,
  deleteByTask,
  promoteKnowledge,
  sweepExpiredKnowledge
} from '../../src/core/knowledge/review.js';
import {
  resolveKnowledgeWriteContext,
  knowledgeIsVisible
} from '../../src/core/knowledge/write-context.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';

async function fixture() {
  const f = await createFixtureGroup();
  const source = f.sources[0],
    db = f.runtime.get(source).db;
  const scope = f.registry.select({}, source.rootPath);
  const options = { scope, home: f.registry.home };
  const graph = new GraphStore({
    home: f.registry.home,
    resolve: (id) => {
      const source = f.registry.resolve(id);
      return { source, db: f.runtime.get(source).db.getInstance() };
    }
  });
  const anchor = (file: string) => {
    const chunk = db
      .getInstance()
      .prepare("SELECT id FROM chunks WHERE source_file=? AND section_title='File Structure'")
      .get(path.join(source.rootPath, 'src', file)) as { id: string };
    return entityRef(source.repoId, 'chunk', chunk.id);
  };
  const linkInput = {
    source: anchor('client.ts'),
    target: anchor('server.ts'),
    type: 'calls_api' as const,
    rationale: 'Order creation posts to handler',
    expectedGenerations: { [source.repoId]: source.generation }
  };
  const factInput = {
    content: 'Order creation architecture',
    scope: 'view' as const,
    scopeId: source.repoId,
    viewIds: [source.repoId],
    provenance: 'code' as const,
    evidenceRefs: [linkInput.source],
    expectedGenerations: linkInput.expectedGenerations
  };
  const store = new KnowledgeStore(db);
  const cli = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../../dist/bin/contextos.js', import.meta.url)), ...args],
      {
        cwd: source.rootPath,
        env: { ...process.env, HOME: f.home, CONTEXTOS_HOME: f.registry.home },
        encoding: 'utf8'
      }
    );
  const audits = () =>
    fs
      .readFileSync(path.join(f.registry.home, 'knowledge-audit.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s));
  return {
    ...f,
    source,
    db,
    graph,
    scope,
    options,
    store,
    factInput,
    linkInput,
    cli,
    audits,
    cleanup: async () => {
      graph.close();
      await f.cleanup();
    }
  };
}

it('applies temporary TTL defaults, preserves explicit expiry, and isolates task namespaces', () => {
  const now = Date.now();
  expect(
    resolveKnowledgeWriteContext({ namespace: 'session' }, {}).expiresAt
  ).toBeGreaterThanOrEqual(now + 24 * 3_600_000);
  expect(
    resolveKnowledgeWriteContext({ namespace: 'task:t' }, { CONTEXTOS_SESSION_TTL_HOURS: '2' })
      .expiresAt
  ).toBeLessThanOrEqual(Date.now() + 2 * 3_600_000);
  expect(
    resolveKnowledgeWriteContext({ namespace: 'session', expiresAt: null }, {}).expiresAt
  ).toBeNull();
  expect(resolveKnowledgeWriteContext({ namespace: 'project' }, {}).expiresAt).toBeUndefined();
  expect(knowledgeIsVisible({ namespace: 'task:t' }, 'other')).toBe(false);
  expect(knowledgeIsVisible({ namespace: 'task:t' }, 't')).toBe(true);
  expect(knowledgeIsVisible({ expiresAt: now }, 't', now)).toBe(false);
});

describe('review, rollback and lifecycle', () => {
  it('rolls back all task writes including notes, with exact dry-run and audited scoped deletion', async () => {
    const f = await fixture();
    try {
      const metadata = {
        taskId: 'task-one',
        author: 'codex',
        model: 'test',
        status: 'proposed' as const
      };
      const fact = f.graph.remember({ ...f.factInput, ...metadata }, f.scope.repoIds);
      const link = f.graph.link({ ...f.linkInput, ...metadata }, f.scope.repoIds);
      const legacy = f.store.learnFact('Legacy task note', 'general', metadata);
      const sessions = new SessionStore(f.db),
        session = sessions.createSession(f.source.rootPath);
      const event = sessions.addEvent({
        sessionId: session.id,
        eventType: 'system_response',
        content: 'temporary task note',
        relatedFiles: null
      });
      const note = `session:note:${session.id}:${event.id}`;
      recordKnowledgeOperation(
        'remember_session',
        note,
        { ...metadata, namespace: 'session' },
        f.registry.home
      );
      new KnowledgeStore(f.runtime.get(f.sources[1]).db).learnFact(
        'outside scope',
        'general',
        metadata
      );
      f.store.learnFact('unrelated task', 'general', { taskId: 'other' });
      expect(listTasks(f.options)).toContainEqual(
        expect.objectContaining({
          taskId: 'task-one',
          count: 4,
          authors: ['codex'],
          models: ['test'],
          statuses: { proposed: 4 }
        })
      );
      const preview = deleteByTask('task-one', { ...f.options, dryRun: true });
      expect(preview.records.map((r) => r.id).sort()).toEqual(
        [fact.id, link.id, legacy, note].sort()
      );
      expect(() => deleteByTask('task-one', { ...f.options, expectedIds: [] })).toThrow(
        'changed after preview'
      );
      expect(listKnowledge({ ...f.options, taskId: 'task-one' })).toHaveLength(4);
      expect(
        deleteByTask('task-one', { ...f.options, expectedIds: preview.records.map((r) => r.id) })
          .count
      ).toBe(4);
      expect(sessions.getRecentEvents(session.id)).toEqual([]);
      expect(f.audits().filter((a) => a.operation === 'rollback')).toHaveLength(4);
      expect(new KnowledgeStore(f.runtime.get(f.sources[1]).db).getAllFacts()).toHaveLength(1);
    } finally {
      await f.cleanup();
    }
  }, 30000);

  it('hides expired and foreign-task facts/links before limits and traversal, then sweeps with audit', async () => {
    const f = await fixture();
    try {
      const expired = { namespace: 'session', expiresAt: Date.now() - 1, taskId: 'expired' };
      const fact = f.graph.remember({ ...f.factInput, ...expired }, f.scope.repoIds);
      const link = f.graph.link({ ...f.linkInput, ...expired }, f.scope.repoIds);
      f.store.learnFact('Order creation expired legacy', 'general', expired);
      const privateFact = f.graph.remember(
        { ...f.factInput, namespace: 'task:secret' },
        f.scope.repoIds
      );
      const privateLink = f.graph.link(
        { ...f.linkInput, namespace: 'task:secret' },
        f.scope.repoIds
      );
      const privateLegacy = f.store.learnFact('Order creation private', 'general', {
        namespace: 'task:secret'
      });
      const publicFact = f.graph.remember(
        { ...f.factInput, content: 'Order creation public', namespace: 'session' },
        f.scope.repoIds
      );
      f.store.learnFact('Order creation public legacy');
      expect(
        f.graph
          .searchFacts('Order creation', { viewIds: f.scope.repoIds, limit: 1 })
          .map((r) => r.id)
      ).toEqual([publicFact.id]);
      expect(f.graph.listLinks()).toEqual([]);
      expect(f.graph.getLink(link.id, f.scope.repoIds)).toBeUndefined();
      expect(f.graph.expand([f.linkInput.source], f.scope.repoIds).links).toEqual([]);
      expect(
        f.graph.trace({ start: f.linkInput.source, target: f.linkInput.target }, f.scope.repoIds)
          .found
      ).toBe(false);
      expect(f.store.getAllFacts()).toHaveLength(1);
      expect(f.store.searchFacts('Order creation', 1)).toHaveLength(1);
      expect(f.store.getRelevantFactsByCategory('general', 1)).toHaveLength(1);
      f.graph.setTaskContext('secret');
      expect(f.graph.listLinks().map((r) => r.id)).toEqual([privateLink.id]);
      expect(
        f.graph.searchFacts('Order creation', { viewIds: f.scope.repoIds }).map((r) => r.id)
      ).toContain(privateFact.id);
      expect(new KnowledgeStore(f.db, 'secret').getAllFacts().map((r) => r.id)).toContain(
        privateLegacy
      );
      expect(sweepExpiredKnowledge(f.options).count).toBe(3);
      expect(listKnowledge(f.options).some((r) => r.id === fact.id)).toBe(false);
      expect(sweepExpiredKnowledge(f.options).count).toBe(0);
      expect(f.audits().filter((r) => r.operation === 'expire')).toHaveLength(3);
    } finally {
      await f.cleanup();
    }
  }, 30000);

  it('filters session notes before limits, expires them and rolls them up by task', async () => {
    const f = await fixture();
    try {
      const store = new SessionStore(f.db),
        session = store.createSession();
      for (const [content, namespace, expiresAt] of [
        ['public note', 'session', Date.now() + 10000],
        ['expired note', 'session', Date.now() - 1],
        ['private note', 'task:secret', Date.now() + 10000]
      ] as const) {
        const event = store.addEvent({
          sessionId: session.id,
          eventType: 'system_response',
          content,
          relatedFiles: null
        });
        recordKnowledgeOperation(
          'remember_session',
          `session:note:${session.id}:${event.id}`,
          { namespace, expiresAt, taskId: 'notes' },
          f.registry.home
        );
      }
      expect(store.getRecentEvents(session.id, 1).map((e) => e.content)).toEqual(['public note']);
      expect(store.searchSessionEvents('note').map((e) => e.content)).toEqual(['public note']);
      expect(store.getRecentEvents(session.id, 10, 'secret')).toHaveLength(2);
      expect(store.getKnowledgeNotes().map((e) => e.content)).toEqual(['public note']);
      const publicNote = listKnowledge(f.options).find((r) => r.content === 'public note')!;
      // Review transitions on session notes persist in the audit sidecar.
      recordKnowledgeOperation(
        'remember_session',
        publicNote.id,
        { namespace: 'session', taskId: 'notes', status: 'proposed' },
        f.registry.home
      );
      setKnowledgeStatus([publicNote.id], 'verified', { ...f.options, reviewer: 'human' });
      expect(listKnowledge(f.options).find((r) => r.id === publicNote.id)).toMatchObject({
        status: 'verified',
        verifiedAt: expect.any(Number)
      });
      expect(sweepExpiredKnowledge(f.options).count).toBe(1);
      expect(listTasks(f.options)[0].count).toBe(2);
    } finally {
      await f.cleanup();
    }
  }, 30000);

  it('promotes verified or accepted proposals with fresh evidence and rejects invalid whole batches', async () => {
    const f = await fixture();
    try {
      const fact = f.graph.remember(
        { ...f.factInput, namespace: 'task:promote', status: 'proposed' },
        f.scope.repoIds
      );
      expect(() => promoteKnowledge([fact.id], 'project', f.options)).toThrow('verified');
      expect(() =>
        promoteKnowledge([fact.id, 'missing'], 'project', { ...f.options, accept: true })
      ).toThrow('not found');
      expect(listKnowledge(f.options)[0].status).toBe('proposed');
      const promoted = promoteKnowledge([fact.id], 'project', {
        ...f.options,
        accept: true,
        reviewer: 'human'
      });
      expect(promoted[0]).toMatchObject({
        namespace: 'project',
        scope: 'project',
        scopeId: f.source.projectId,
        expiresAt: null,
        status: 'verified'
      });
      expect(
        f.graph.searchFacts('Order creation', {
          viewIds: f.scope.repoIds,
          projectIds: [f.source.projectId]
        })[0].id
      ).toBe(fact.id);
      // Normal writes share the promoted identity rather than duplicating it.
      expect(
        f.graph.remember(
          { ...f.factInput, scope: 'project', scopeId: f.source.projectId },
          f.scope.repoIds
        ).id
      ).toBe(fact.id);
      const groupOptions = {
        ...f.options,
        scope: f.registry.select({ group: f.group.id }, f.source.rootPath)
      };
      expect(promoteKnowledge([fact.id], 'group', groupOptions)[0]).toMatchObject({
        namespace: 'group',
        scope: 'group',
        scopeId: f.group.id
      });
      const link = f.graph.link({ ...f.linkInput, namespace: 'task:promote' }, f.scope.repoIds);
      expect(promoteKnowledge([link.id], 'project', f.options)[0]).toMatchObject({
        namespace: 'project',
        expiresAt: null,
        status: 'verified'
      });
      const legacy = f.store.learnFact('No code evidence');
      expect(() => promoteKnowledge([legacy], 'project', f.options)).toThrow('explicit provenance');
      const bad = f.graph.remember(
        { ...f.factInput, content: 'Order changed code', namespace: 'session' },
        f.scope.repoIds
      );
      fs.appendFileSync(path.join(f.source.rootPath, 'src/client.ts'), '\n// changed evidence\n');
      expect(() => promoteKnowledge([bad.id], 'project', f.options)).toThrow();
      expect(listKnowledge(f.options).find((r) => r.id === bad.id)?.namespace).toBe('session');
      expect(f.audits()).toContainEqual(
        expect.objectContaining({ operation: 'accept', id: fact.id, author: 'human' })
      );
      expect(f.audits()).toContainEqual(
        expect.objectContaining({ operation: 'promote', id: fact.id })
      );
    } finally {
      await f.cleanup();
    }
  }, 30000);

  it('implements real CLI list/show/accept/reject and requires rollback consent after printing exact list', async () => {
    const f = await fixture();
    try {
      const id = f.store.learnFact('CLI proposal', 'general', {
        status: 'proposed',
        taskId: 'cli-task',
        author: 'agent'
      });
      const list = f.cli(
        'review',
        'list',
        '--status',
        'proposed',
        '--task',
        'cli-task',
        '--author',
        'agent',
        '--json'
      );
      expect(list.status, list.stderr).toBe(0);
      expect(JSON.parse(list.stdout)).toContainEqual(expect.objectContaining({ id }));
      const show = f.cli('review', 'show', id, '--json');
      expect(JSON.parse(show.stdout)).toMatchObject({ id, content: 'CLI proposal' });
      const accept = f.cli('review', 'accept', id, '--json');
      expect(accept.status, accept.stderr).toBe(0);
      expect(listKnowledge(f.options)[0]).toMatchObject({
        status: 'verified',
        verifiedAt: expect.any(Number)
      });
      const rollback = f.cli('task', 'rollback', 'cli-task', '--json');
      expect(rollback.status).toBe(1);
      expect(JSON.parse(rollback.stdout).preview.records[0].id).toBe(id);
      expect(listKnowledge(f.options)).toHaveLength(1);
      expect(f.cli('task', 'rollback', 'cli-task', '--dry-run', '--json').status).toBe(0);
      expect(f.cli('task', 'rollback', 'cli-task', '--yes', '--json').status).toBe(0);
      f.store.learnFact('Accept batch one', 'general', { status: 'proposed', taskId: 'batch' });
      f.store.learnFact('Accept batch two', 'general', { status: 'proposed', taskId: 'batch' });
      expect(f.cli('review', 'accept', '--all-proposed', '--json').status).toBe(0);
      expect(
        listKnowledge({ ...f.options, taskId: 'batch' }).every((r) => r.status === 'verified')
      ).toBe(true);
      expect(JSON.parse(f.cli('task', 'list', '--json').stdout)).toContainEqual(
        expect.objectContaining({ taskId: 'batch', count: 2 })
      );
      const reject = f.store.learnFact('Reject proposal', 'general', { taskId: 'reject-task' });
      expect(f.cli('review', 'reject', '--task', 'reject-task').status).toBe(0);
      expect(listKnowledge(f.options).find((r) => r.id === reject)).toBeUndefined();
      expect(f.audits().some((a) => a.operation === 'reject' && a.id === reject)).toBe(true);
    } finally {
      await f.cleanup();
    }
  }, 30000);

  it('allows MCP list/show but gates every mutation and persists write namespaces/expiry', async () => {
    const f = await fixture();
    const server = new McpServer({ name: 'lifecycle', version: 'test' });
    const client = new Client({ name: 'reviewer-agent', version: 'test' });
    try {
      registerWorkspaceTools(server, f.runtime, {
        cwd: f.source.rootPath,
        activeRepoId: f.source.repoId
      });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await server.connect(left);
      await client.connect(right);
      const call = (name: string, args: Record<string, unknown>) =>
        client.callTool({ name, arguments: args });
      const expires = Date.now() + 10000;
      const write = await call('ctx_remember', {
        content: 'Order creation private MCP',
        provenance: 'code',
        evidence: [f.linkInput.source],
        expected_generations: f.linkInput.expectedGenerations,
        namespace: 'task:mcp',
        task_id: 'mcp',
        expires_at: expires,
        status: 'proposed'
      });
      expect(write.isError, JSON.stringify(write)).not.toBe(true);
      const id = (write.structuredContent as { id: string }).id;
      expect(listKnowledge(f.options)).toContainEqual(
        expect.objectContaining({ id, namespace: 'task:mcp', expiresAt: expires })
      );
      expect((await call('ctx_review', { action: 'list', task_id: 'mcp' })).isError).not.toBe(true);
      const show = await call('ctx_review', { action: 'show', id });
      expect(
        (show.structuredContent as { record: { evidence: unknown[] } }).record.evidence
      ).toHaveLength(1);
      const withoutTask = await call('get_context', {
        prompt: 'Order creation private MCP',
        layers: ['repo'],
        tier: 'full',
        include_proposed: true
      });
      expect(JSON.stringify(withoutTask.structuredContent)).not.toContain(
        'Order creation private MCP'
      );
      const withTask = await call('get_context', {
        prompt: 'Order creation private MCP',
        layers: ['repo'],
        tier: 'full',
        include_proposed: true,
        task_id: 'mcp'
      });
      expect(JSON.stringify(withTask.structuredContent)).toContain('Order creation private MCP');
      const hiddenProposal = await call('get_context', {
        prompt: 'Order creation private MCP',
        layers: ['repo'],
        tier: 'full',
        task_id: 'mcp'
      });
      expect(JSON.stringify(hiddenProposal.structuredContent)).not.toContain(
        'Order creation private MCP'
      );
      vi.stubEnv('CONTEXTOS_ALLOW_AGENT_REVIEW', '0');
      for (const action of ['accept', 'reject', 'promote'])
        expect((await call('ctx_review', { action, ids: [id], to: 'project' })).isError).toBe(true);
      expect(listKnowledge(f.options)[0].status).toBe('proposed');
      vi.stubEnv('CONTEXTOS_ALLOW_AGENT_REVIEW', '1');
      expect((await call('ctx_review', { action: 'accept', ids: [id] })).isError).not.toBe(true);
      expect(
        (await call('ctx_review', { action: 'promote', ids: [id], to: 'project' })).isError
      ).not.toBe(true);
      expect(f.audits()).toContainEqual(
        expect.objectContaining({ operation: 'accept', id, author: 'reviewer-agent' })
      );
      expect((await call('ctx_review', { action: 'reject', ids: [id] })).isError).not.toBe(true);
      expect(listKnowledge(f.options)).toEqual([]);
      const linked = await call('ctx_link', {
        source: f.linkInput.source,
        target: f.linkInput.target,
        relationship: 'calls_api',
        rationale: 'Order handler',
        expected_generations: f.linkInput.expectedGenerations,
        namespace: 'task:mcp',
        expires_at: expires
      });
      expect(linked.isError).not.toBe(true);
      expect((await call('ctx_links', {})).structuredContent).toMatchObject({ total: 0 });
      expect((await call('ctx_links', { task_id: 'mcp' })).structuredContent).toMatchObject({
        total: 1
      });
      expect(
        (
          await call('ctx_trace', {
            task_id: 'mcp',
            start: f.linkInput.source,
            target: f.linkInput.target
          })
        ).structuredContent
      ).toMatchObject({ found: true });
    } finally {
      vi.unstubAllEnvs();
      await client.close();
      await server.close();
      await f.cleanup();
    }
  }, 30000);
});

it('runs expiry in an isolated daemon worker, including group user facts', async () => {
  const f = await fixture();
  const { startExpiryScheduler } = (await import(
    new URL('../../dist/src/core/knowledge/expiry-scheduler.js', import.meta.url).href
  )) as typeof import('../../src/core/knowledge/expiry-scheduler.js');
  let scheduler: ReturnType<typeof startExpiryScheduler> | undefined;
  try {
    f.store.learnFact('Expired worker legacy', 'general', { expiresAt: Date.now() - 1 });
    const scope = f.registry.select({ group: f.group.id }, f.source.rootPath);
    const fact = f.graph.remember(
      {
        content: 'Expired group preference',
        provenance: 'user',
        scope: 'group',
        scopeId: f.group.id,
        viewIds: scope.repoIds,
        expiresAt: Date.now() - 1
      },
      scope.repoIds,
      { groupId: f.group.id }
    );
    scheduler = startExpiryScheduler(f.registry.home);
    const deadline = Date.now() + 15_000;
    while (
      listKnowledge({ ...f.options, scope, includeExpired: true }).some((r) => r.id === fact.id) &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(listKnowledge({ ...f.options, scope, includeExpired: true })).toEqual([]);
    expect(f.audits().filter((a) => a.operation === 'expire')).toHaveLength(2);
  } finally {
    await scheduler?.stop();
    await f.cleanup();
  }
}, 30000);
