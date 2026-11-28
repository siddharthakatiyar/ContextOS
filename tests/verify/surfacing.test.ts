import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { getStalenessSummary, verifyKnowledge } from '../../src/core/verify/index.js';
import { inspectKnowledgeFreshness, collectDoctorReport } from '../../src/cli/commands/doctor.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';

let f: Awaited<ReturnType<typeof createFixtureGroup>>;
let graph: GraphStore;
let store: Database.Database;
let client: Client;
let server: McpServer;
let chunk: { id: string; source_file: string };
const scope = () => ({ home: f.registry.home, viewIds: [f.sources[0].repoId] });
const remember = (
  content: string,
  status: 'verified' | 'stale' | 'proposed' = 'verified',
  owner = 0
) => {
  const source = f.sources[owner];
  const row = f.runtime
    .get(source)
    .db.getInstance()
    .prepare(
      "SELECT id FROM chunks WHERE source_file LIKE '%client.ts' OR source_file LIKE '%worker.ts' OR source_file LIKE '%index.ts' ORDER BY source_file,id LIMIT 1"
    )
    .get() as { id: string };
  return graph.remember(
    {
      content,
      status,
      scope: 'view',
      scopeId: source.repoId,
      viewIds: [source.repoId],
      provenance: 'code',
      evidenceRefs: [entityRef(source.repoId, 'chunk', row.id)],
      expectedGenerations: { [source.repoId]: source.generation }
    },
    [source.repoId]
  );
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const reply = (await client.callTool({ name, arguments: args })) as CallToolResult;
  expect(reply.isError).not.toBe(true);
  return {
    ...reply,
    structuredContent: reply.structuredContent as Record<string, unknown> | undefined
  };
};

beforeEach(async () => {
  f = await createFixtureGroup();
  graph = new GraphStore({
    home: f.registry.home,
    resolve: (id) => {
      const source = f.registry.resolve(id);
      return { source, db: f.runtime.get(source).db.getInstance() };
    }
  });
  store = new Database(path.join(f.registry.home, 'graph.db'));
  chunk = f.runtime
    .get(f.sources[0])
    .db.getInstance()
    .prepare(
      "SELECT id,source_file FROM chunks WHERE source_file LIKE '%client.ts' ORDER BY id LIMIT 1"
    )
    .get() as typeof chunk;
  server = new McpServer({ name: 'freshness-test', version: '1' });
  registerWorkspaceTools(server, f.runtime, {
    cwd: f.sources[0].rootPath,
    workspace: 'foundation-130'
  });
  client = new Client({ name: 'freshness-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  store?.close();
  graph?.close();
  await f?.cleanup();
  vi.unstubAllEnvs();
});

describe('knowledge freshness surfacing', { timeout: 30_000 }, () => {
  it('persists complete sweep coverage without letting dry or limited checks refresh it', async () => {
    const fact = remember('Client freshness evidence');
    expect(getStalenessSummary(scope())).toMatchObject({
      lastSweepAt: null,
      oldestUnverifiedAt: fact.createdAt
    });
    await verifyKnowledge({ scope: scope(), dryRun: true });
    await verifyKnowledge({ scope: scope(), limit: 1 });
    await verifyKnowledge({ scope: scope(), since: 0 });
    expect(getStalenessSummary(scope()).lastSweepAt).toBeNull();
    await verifyKnowledge({ scope: scope() });
    const summary = getStalenessSummary(scope());
    expect(summary).toMatchObject({
      oldestUnverifiedAt: null,
      lastSweepAt: expect.any(Number),
      byStatus: { verified: 1, proposed: 0, stale: 0 }
    });
    expect(summary.projects[f.sources[0].projectId].total).toBe(1);
    expect(summary.groups[f.group.id].total).toBe(1);
    expect(getStalenessSummary({ home: f.registry.home }).lastSweepAt).toBeNull();
    expect(
      getStalenessSummary({ home: f.registry.home, viewIds: [f.sources[1].repoId] }).total
    ).toBe(0);
    await verifyKnowledge({ scope: { home: f.registry.home } });
    expect(getStalenessSummary({ home: f.registry.home }).lastSweepAt).toEqual(expect.any(Number));
  });

  it('reports exact overdue boundaries, stale reasons, and structured doctor data', async () => {
    vi.stubEnv('CONTEXTOS_VERIFY_INTERVAL_MS', '1000');
    remember('Client freshness evidence');
    await verifyKnowledge({ scope: scope() });
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const setTime = (at: number) =>
        store
          .prepare('UPDATE graph_metadata SET value=? WHERE key=?')
          .run(String(at), `verification.lastSweep.view:${f.sources[0].repoId}`);
      setTime(now - 2000);
      expect(inspectKnowledgeFreshness(f.sources[0].rootPath, f.home).status).toBe('pass');
      setTime(now - 2001);
      expect(inspectKnowledgeFreshness(f.sources[0].rootPath, f.home)).toMatchObject({
        status: 'warn',
        details: { sweepOverdue: true, recommendedCommand: 'contextos verify --fix' }
      });
      vi.stubEnv('CONTEXTOS_VERIFY_INTERVAL_MS', '0');
      expect(getStalenessSummary(scope()).sweepOverdue).toBe(false);
      fs.unlinkSync(chunk.source_file);
      await verifyKnowledge({ scope: scope() });
      const report = await collectDoctorReport({
        cwd: f.sources[0].rootPath,
        homeDirectory: f.home,
        noninteractive: true
      });
      expect(report.checks.find((c) => c.id === 'knowledge-freshness')).toMatchObject({
        status: 'warn',
        details: { byStatus: { stale: 1 }, byReason: { 'file deleted': 1 } }
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('warns for old never-swept knowledge and leaves an unregistered checkout untouched', () => {
    vi.stubEnv('CONTEXTOS_VERIFY_INTERVAL_MS', '1000');
    const fact = remember('Client freshness evidence');
    const payload = JSON.parse(
      (
        store.prepare('SELECT payload FROM verified_facts WHERE id=?').get(fact.id) as {
          payload: string;
        }
      ).payload
    );
    payload.createdAt = Date.now() - 3000;
    store
      .prepare('UPDATE verified_facts SET payload=? WHERE id=?')
      .run(JSON.stringify(payload), fact.id);
    expect(getStalenessSummary(scope())).toMatchObject({ lastSweepAt: null, sweepOverdue: true });
    const unregistered = path.join(f.root, 'unregistered');
    fs.mkdirSync(unregistered);
    expect(inspectKnowledgeFreshness(unregistered, f.home).status).toBe('unknown');
    expect(fs.readdirSync(unregistered)).toEqual([]);
  });

  it('hints only for matching hidden stale facts, respects proposals and flags opt-in stale results', async () => {
    const stale = remember('Quasar billing stale design', 'stale');
    const verified = remember('Quasar billing verified design');
    const proposed = remember('Quasar billing proposed design', 'proposed');
    const query = { prompt: 'Quasar billing', tier: 'full', layers: ['repo'], max_tokens: 8000 };
    const normal = await call('get_context', query);
    expect(normal.structuredContent?.knowledgeHealth).toMatch(/^1 stale knowledge item hidden;/);
    const chunks = normal.structuredContent?.chunks as { ref: string; status?: string }[];
    expect(chunks.some((c) => c.ref.endsWith(verified.id))).toBe(true);
    expect(chunks.some((c) => c.ref.endsWith(stale.id) || c.ref.endsWith(proposed.id))).toBe(false);
    expect(
      (await call('get_context', { ...query, prompt: 'unrelated wombat' })).structuredContent
    ).not.toHaveProperty('knowledgeHealth');
    const xml = await call('get_context', { ...query, output_format: 'xml' });
    const xmlText = (xml.content as { type: string; text?: string }[]).find(
      (c) => c.type === 'text'
    )!.text!;
    expect(xmlText).toMatch(/^<!-- [^]*? -->\n<contextos_context>/);
    expect(xmlText.slice(4, xmlText.indexOf('-->'))).not.toContain('--');
    const included = await call('get_context', {
      ...query,
      include_stale: true,
      include_proposed: true
    });
    expect(included.structuredContent).not.toHaveProperty('knowledgeHealth');
    const hits = included.structuredContent?.chunks as { ref: string; status?: string }[];
    expect(hits.find((c) => c.ref.endsWith(stale.id))?.status).toBe('stale');
    expect(hits.find((c) => c.ref.endsWith(proposed.id))?.status).toBe('proposed');
    expect(hits.at(-1)?.status).toBe('stale');
    expect((await call('ctx_scope')).structuredContent).toMatchObject({
      knowledgeSummary: { stale: 1, proposed: 1 }
    });
    expect((await call('ctx_scope', { verbose: true })).structuredContent).toMatchObject({
      knowledgeSummary: { stale: 1, proposed: 1 }
    });
    expect(
      (await call('get_context', { ...query, layers: ['session'] })).structuredContent
    ).not.toHaveProperty('knowledgeHealth');
  });

  it('keeps hidden-stale hints scoped to selected available views', async () => {
    remember('Andromeda deployment design', 'stale', 1);
    const query = { prompt: 'Andromeda deployment', tier: 'full', layers: ['repo'] };
    expect((await call('get_context', query)).structuredContent).not.toHaveProperty(
      'knowledgeHealth'
    );
    expect(
      (await call('get_context', { ...query, all_repos: true })).structuredContent?.knowledgeHealth
    ).toMatch(/^1 stale/);
    remember('Pegasus proposed design', 'proposed');
    const proposal = await call('get_context', { ...query, prompt: 'Pegasus' });
    expect(proposal.structuredContent).not.toHaveProperty('knowledgeHealth');
    expect(proposal.structuredContent?.chunks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'proposed' })])
    );
  });

  it('includes legacy stale matches in the health hint and opt-in retrieval', async () => {
    const legacy = new KnowledgeStore(f.runtime.get(f.sources[0]).db);
    legacy.learnFact('Nebula legacy freshness', 'general', { status: 'stale' });
    const query = { prompt: 'Nebula', tier: 'full', layers: ['repo'] };
    expect((await call('get_context', query)).structuredContent?.knowledgeHealth).toMatch(
      /^1 stale/
    );
    const reply = await call('get_context', { ...query, include_stale: true });
    expect(reply.structuredContent).not.toHaveProperty('knowledgeHealth');
    expect(reply.structuredContent?.chunks).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'stale' })])
    );
  });

  it('surfaces stale links last as trace diagnostics without establishing confirmed paths', async () => {
    const source = f.sources[0];
    const other = f.runtime
      .get(source)
      .db.getInstance()
      .prepare("SELECT id FROM chunks WHERE source_file LIKE '%server.ts' ORDER BY id LIMIT 1")
      .get() as { id: string };
    const start = entityRef(source.repoId, 'chunk', other.id);
    const target = entityRef(source.repoId, 'chunk', chunk.id);
    const link = graph.link(
      {
        source: start,
        target,
        type: 'calls_api',
        rationale: 'Pulsar stale integration',
        status: 'stale',
        expectedGenerations: { [source.repoId]: source.generation }
      },
      [source.repoId]
    );
    graph.link(
      {
        source: start,
        target,
        type: 'imports',
        rationale: 'Verified integration',
        expectedGenerations: { [source.repoId]: source.generation }
      },
      [source.repoId]
    );
    expect((await call('ctx_links')).structuredContent?.total).toBe(1);
    const links = (await call('ctx_links', { include_stale: true })).structuredContent?.links as {
      id: string;
      status?: string;
    }[];
    expect(links.at(-1)).toMatchObject({ id: link.id, status: 'stale' });
    const normal = await call('ctx_trace', { start, target, relationships: ['calls_api'] });
    expect(normal.structuredContent).toMatchObject({ found: false, links: [] });
    const trace = await call('ctx_trace', {
      start,
      target,
      relationships: ['calls_api'],
      include_stale: true
    });
    expect(trace.structuredContent).toMatchObject({
      found: false,
      paths: [],
      partial: true,
      coverage: 'recorded_links_including_stale',
      links: [expect.objectContaining({ id: link.id, status: 'stale' })]
    });
    expect(
      (await call('get_context', { prompt: 'Pulsar', layers: ['repo'] })).structuredContent
        ?.knowledgeHealth
    ).toMatch(/^1 stale/);
    const bounded = await call('ctx_trace', { start, target, include_stale: true, max_edges: 1 });
    expect(bounded.structuredContent).toMatchObject({
      found: true,
      links: [expect.objectContaining({ relationship: 'imports' })]
    });
    fs.unlinkSync(chunk.source_file);
    const historical = await call('ctx_trace', { start: target, include_stale: true });
    expect(historical.structuredContent?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: target, status: 'stale' })])
    );
  });

  it('reports persisted sweep timestamps in status JSON and human doctor output', async () => {
    remember('Client freshness evidence', 'stale');
    await verifyKnowledge({ scope: scope() });
    const bin = path.resolve('dist/bin/contextos.js');
    const cli = (...args: string[]) =>
      execFileSync(process.execPath, [bin, ...args], {
        cwd: f.sources[0].rootPath,
        env: { ...process.env, HOME: f.home },
        encoding: 'utf8'
      });
    expect(JSON.parse(cli('status', '--json'))).toMatchObject({
      knowledgeFreshness: { lastSweepAt: expect.any(Number) }
    });
    const doctor = JSON.parse(cli('doctor', '--json', '--noninteractive'));
    expect(doctor.checks.find((c: { id: string }) => c.id === 'knowledge-freshness')).toMatchObject(
      { details: { lastSweepAt: expect.any(Number) } }
    );
    expect(cli('doctor', '--noninteractive')).toContain('Knowledge freshness');
  });

  it('runs daemon sweeps through stale reporting and exact-evidence recovery after reindex', async () => {
    vi.stubEnv('CONTEXTOS_VERIFY_INTERVAL_MS', '100');
    const fact = remember('Client daemon freshness evidence');
    const original = fs.readFileSync(chunk.source_file, 'utf8');
    fs.unlinkSync(chunk.source_file);
    const { startVerificationScheduler } = await import(
      new URL('../../dist/src/core/verify/scheduler.js', import.meta.url).href
    );
    const scheduler = startVerificationScheduler(f.registry.home, scope().viewIds);
    try {
      await vi.waitFor(
        () =>
          expect(getStalenessSummary(scope())).toMatchObject({
            byStatus: { stale: 1 },
            lastSweepAt: expect.any(Number)
          }),
        { timeout: 15_000, interval: 50 }
      );
      expect(inspectKnowledgeFreshness(f.sources[0].rootPath, f.home)).toMatchObject({
        status: 'warn',
        details: { byStatus: { stale: 1 }, byReason: { 'file deleted': 1 } }
      });
      fs.writeFileSync(chunk.source_file, original);
      await f.runtime.get(f.sources[0]).index();
      await vi.waitFor(
        () =>
          expect(
            store.prepare('SELECT status FROM verified_facts WHERE id=?').get(fact.id)
          ).toEqual({ status: 'verified' }),
        { timeout: 15_000, interval: 50 }
      );
      expect(inspectKnowledgeFreshness(f.sources[0].rootPath, f.home)).toMatchObject({
        status: 'pass',
        details: { byStatus: { verified: 1, stale: 0 } }
      });
    } finally {
      await scheduler.stop();
    }
  });
});
