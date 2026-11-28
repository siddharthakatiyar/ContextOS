import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore, type VerifiedFact } from '../../src/core/knowledge/graph-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { verifyKnowledge, getStalenessSummary } from '../../src/core/verify/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';
import { hashContent } from '../../src/utils/hash.js';

let fixture: Awaited<ReturnType<typeof createFixtureGroup>>;
let graph: GraphStore;
let indexes: Database.Database[];
let store: Database.Database;
let fact: VerifiedFact;
let chunk: { id: string; source_file: string; hash: string };
const scope = () => ({ home: fixture.registry.home, viewIds: [fixture.sources[0].repoId] });
const read = () =>
  store.prepare('SELECT * FROM verified_facts WHERE id=?').get(fact.id) as {
    status: string;
    verified_at: number | null;
    stale_reason: string | null;
    payload: string;
  };
const verify = (dryRun = false) => verifyKnowledge({ scope: scope(), dryRun });

beforeEach(async () => {
  fixture = await createFixtureGroup();
  indexes = fixture.sources.map((s) => new Database(s.dbPath));
  graph = new GraphStore({
    home: fixture.registry.home,
    resolve: (id) => ({
      source: fixture.registry.resolve(id),
      db: indexes[fixture.sources.findIndex((s) => s.repoId === id)]
    })
  });
  const source = fixture.sources[0];
  chunk = indexes[0]
    .prepare(
      "SELECT id,source_file,hash FROM chunks WHERE source_file LIKE '%client.ts' ORDER BY id LIMIT 1"
    )
    .get() as typeof chunk;
  fact = graph.remember(
    {
      content: 'Client uses shared imports',
      scope: 'view',
      scopeId: source.repoId,
      viewIds: [source.repoId],
      provenance: 'code',
      evidenceRefs: [entityRef(source.repoId, 'chunk', chunk.id)],
      expectedGenerations: { [source.repoId]: source.generation }
    },
    [source.repoId]
  );
  store = new Database(path.join(fixture.registry.home, 'graph.db'));
});
afterEach(async () => {
  store?.close();
  graph?.close();
  for (const index of indexes ?? []) index.close();
  await fixture?.cleanup();
});

describe('knowledge re-verification', { timeout: 30_000 }, () => {
  it('retains invalid facts through visible/prune/invalidate and recovers them', async () => {
    const contents = fs.readFileSync(chunk.source_file, 'utf8');
    fs.unlinkSync(chunk.source_file);
    expect(graph.searchFacts('Client', { viewIds: scope().viewIds })).toEqual([]);
    expect(read()).toMatchObject({ status: 'stale', stale_reason: 'file deleted' });
    const revision = graph.revision();
    expect(graph.pruneInvalid()).toBe(0);
    expect(graph.revision()).toBe(revision);
    expect(
      graph.searchFacts('Client', { viewIds: scope().viewIds, includeStale: true })[0]
    ).toMatchObject({ id: fact.id, status: 'stale' });
    fs.writeFileSync(chunk.source_file, contents);
    expect(graph.searchFacts('Client', { viewIds: scope().viewIds })).toEqual([]);
    await verify();
    expect(graph.searchFacts('Client', { viewIds: scope().viewIds })[0].id).toBe(fact.id);
    expect(graph.invalidateView(fixture.sources[0].repoId)).toBe(1);
    expect(read()).toMatchObject({ status: 'stale', stale_reason: 'view missing' });
    expect(graph.forget(fact.id, scope().viewIds)).toBe(true);
    expect(read()).toBeUndefined();
  });
  it('retains facts through real reindex invalidation and verifies restored evidence', async () => {
    const contents = fs.readFileSync(chunk.source_file, 'utf8');
    const source = fixture.sources[0];
    fs.writeFileSync(chunk.source_file, 'export const replacement = true;\n');
    await fixture.runtime.get(fixture.registry.resolve(source.repoId)).index(true);
    expect(read()).toMatchObject({ status: 'stale' });
    expect(graph.searchFacts('Client', { viewIds: [source.repoId] })).toEqual([]);
    fs.writeFileSync(chunk.source_file, contents);
    await fixture.runtime.get(fixture.registry.resolve(source.repoId)).index(true);
    await verify();
    expect(read()).toMatchObject({ status: 'verified', stale_reason: null });
    expect(graph.searchFacts('Client', { viewIds: [source.repoId] })[0].id).toBe(fact.id);
  });
  it('hides stale links from default, expansion, trace and exposes flagged MCP results', async () => {
    const source = fixture.sources[0];
    const other = indexes[0]
      .prepare('SELECT id FROM chunks WHERE source_file<>? ORDER BY id LIMIT 1')
      .get(chunk.source_file) as { id: string };
    const input = {
      source: entityRef(source.repoId, 'chunk', other.id),
      target: fact.evidence[0].ref,
      type: 'imports' as const,
      rationale: 'Fixture evidence',
      expectedGenerations: { [source.repoId]: source.generation }
    };
    const link = graph.link(input, [source.repoId]);
    indexes[0].prepare('UPDATE chunks SET hash=? WHERE id=?').run('changed', chunk.id);
    expect(graph.pruneInvalid()).toBe(2);
    expect(graph.listLinks()).toEqual([]);
    expect(graph.expand([input.source], [source.repoId]).links).toEqual([]);
    expect(graph.trace({ start: input.source }, [source.repoId]).links).toEqual([]);
    expect(graph.listLinks({ includeStale: true })[0]).toMatchObject({
      id: link.id,
      status: 'stale',
      staleReason: 'content changed'
    });
    const server = new McpServer({ name: 'verify-test', version: '1' });
    registerWorkspaceTools(server, fixture.runtime, {
      cwd: source.rootPath,
      workspace: 'foundation-130'
    });
    const client = new Client({ name: 'verify-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a);
      await client.connect(b);
      const result = await client.callTool({
        name: 'ctx_links',
        arguments: { include_stale: true }
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        links: [{ id: link.id, status: 'stale', staleReason: 'content changed' }]
      });
    } finally {
      await client.close();
      await server.close();
    }
    indexes[0].prepare('UPDATE chunks SET hash=? WHERE id=?').run(chunk.hash, chunk.id);
    await verify();
    expect(graph.listLinks()[0].id).toBe(link.id);
    expect(graph.invalidateFile(source.repoId, chunk.source_file)).toBe(2);
    // Fresh deterministic proof replaces the retained stale identity, never duplicates it.
    expect(graph.linkResolvedImport(input, [source.repoId]).link).toMatchObject({
      id: link.id,
      status: 'verified'
    });
    expect(graph.unlink(link.id, [source.repoId])).toBe(true);
    expect(graph.listLinks({ includeStale: true })).toEqual([]);
  });
  it('persists verification timestamps and preserves proposed review status', async () => {
    store.prepare("UPDATE verified_facts SET status='proposed' WHERE id=?").run(fact.id);
    expect((await verify()).counts['still-valid']).toBe(1);
    expect(read()).toMatchObject({
      status: 'proposed',
      verified_at: expect.any(Number),
      stale_reason: null
    });
    expect(getStalenessSummary(scope())).toEqual({
      total: 1,
      byStatus: { proposed: 1, verified: 0, stale: 0 },
      byReason: {}
    });
  });
  it('dry run reports file deletion without changing any stored bytes or graph revision', async () => {
    const before = read();
    const revision = graph.revision();
    fs.unlinkSync(chunk.source_file);
    expect((await verify(true)).items[0]).toMatchObject({
      outcome: 'stale',
      reason: 'file deleted',
      applied: false
    });
    expect(read()).toEqual(before);
    expect(graph.revision()).toBe(revision);
  });
  it('marks deleted files stale and restores stale items when the exact evidence returns', async () => {
    const contents = fs.readFileSync(chunk.source_file, 'utf8');
    fs.unlinkSync(chunk.source_file);
    await verify();
    expect(read()).toMatchObject({ status: 'stale', stale_reason: 'file deleted' });
    expect(getStalenessSummary(scope()).byReason).toEqual({ 'file deleted': 1 });
    fs.writeFileSync(chunk.source_file, contents);
    await verify();
    expect(read()).toMatchObject({
      status: 'verified',
      stale_reason: null,
      verified_at: expect.any(Number)
    });
  });
  it('marks removed chunks stale without deleting the fact', async () => {
    indexes[0].prepare('DELETE FROM chunks WHERE id=?').run(chunk.id);
    expect((await verify()).items[0]).toMatchObject({ outcome: 'stale', reason: 'chunk removed' });
    expect(read().status).toBe('stale');
  });
  it('rejects edited files even before reindexing', async () => {
    fs.appendFileSync(chunk.source_file, '\n// changed\n');
    expect((await verify()).items[0]).toMatchObject({
      outcome: 'stale',
      reason: 'content changed'
    });
  });
  it('rejects changed chunk hashes even after the file index catches up', async () => {
    indexes[0].prepare('UPDATE chunks SET hash=? WHERE id=?').run('changed', chunk.id);
    expect((await verify()).items[0]).toMatchObject({
      outcome: 'stale',
      reason: 'content changed'
    });
  });
  it('reanchors exact hashes in the same file and refreshes an unrelated file edit', async () => {
    indexes[0].prepare('DELETE FROM relationships WHERE source_chunk_id=?').run(chunk.id);
    indexes[0].prepare('UPDATE chunks SET id=? WHERE id=?').run('moved-chunk', chunk.id);
    fs.appendFileSync(chunk.source_file, '\n// unrelated trailing text\n');
    indexes[0]
      .prepare('UPDATE files SET hash=? WHERE path=?')
      .run(hashContent(fs.readFileSync(chunk.source_file, 'utf8')), chunk.source_file);
    const report = await verify();
    expect(report.items[0]).toMatchObject({ outcome: 'evidence moved', applied: true });
    expect(JSON.parse(read().payload).evidence[0].ref).toBe(
      entityRef(fixture.sources[0].repoId, 'chunk', 'moved-chunk')
    );
    expect((await verify()).counts['still-valid']).toBe(1);
  });
  it('does not guess between ambiguous hash matches', async () => {
    const row = indexes[0].prepare('SELECT * FROM chunks WHERE id=?').get(chunk.id) as Record<
      string,
      unknown
    >;
    indexes[0].prepare('DELETE FROM relationships WHERE source_chunk_id=?').run(chunk.id);
    indexes[0].prepare('UPDATE chunks SET id=? WHERE id=?').run('candidate-one', chunk.id);
    const copy = { ...row, id: 'candidate-two' };
    indexes[0]
      .prepare(
        `INSERT INTO chunks (${Object.keys(copy).join(',')}) VALUES (${Object.keys(copy)
          .map(() => '?')
          .join(',')})`
      )
      .run(...Object.values(copy));
    expect((await verify()).items[0]).toMatchObject({
      outcome: 'stale',
      reason: 'content changed'
    });
  });
  it('reports missing views and defers indexing views without touching metadata or lease', async () => {
    const source = fixture.sources[0];
    fixture.registry.update(source.repoId, { state: 'indexing' });
    const lease = fixture.registry.lease(source.repoId);
    expect((await verify()).items[0].outcome).toBe('deferred');
    expect(read().status).toBe('verified');
    expect(fixture.registry.lease(source.repoId)).toEqual(lease);
    fixture.registry.update(source.repoId, { state: 'unavailable' });
    expect((await verify()).items[0]).toMatchObject({ outcome: 'stale', reason: 'view missing' });
  });
  it('keeps user provenance without evidence unverifiable and unchanged', async () => {
    const source = fixture.sources[0];
    const user = graph.remember(
      {
        content: 'User preference',
        scope: 'view',
        scopeId: source.repoId,
        viewIds: [source.repoId],
        provenance: 'user'
      },
      [source.repoId]
    );
    const report = await verify();
    expect(report.items.find((i) => i.id === user.id)).toMatchObject({
      outcome: 'unverifiable',
      applied: false,
      status: 'verified'
    });
  });
  it('revalidates all evidence in cross-view links selected by an affected view', async () => {
    const a = fixture.sources[0];
    const b = fixture.sources[1];
    const other = indexes[1]
      .prepare('SELECT id,source_file FROM chunks ORDER BY id LIMIT 1')
      .get() as { id: string; source_file: string };
    const link = graph.link(
      {
        source: fact.evidence[0].ref,
        target: entityRef(b.repoId, 'chunk', other.id),
        type: 'imports',
        rationale: 'Fixture connection',
        expectedGenerations: { [a.repoId]: a.generation, [b.repoId]: b.generation }
      },
      [a.repoId, b.repoId]
    );
    fs.unlinkSync(other.source_file);
    expect((await verify()).items.find((i) => i.id === link.id)).toMatchObject({
      kind: 'link',
      outcome: 'stale',
      reason: 'file deleted'
    });
    expect(store.prepare('SELECT status FROM verified_links WHERE id=?').get(link.id)).toEqual({
      status: 'stale'
    });
  });
  it('honors scope, limit and since and validates bounds', async () => {
    expect(
      (await verifyKnowledge({ scope: { ...scope(), viewIds: [fixture.sources[2].repoId] } }))
        .checked
    ).toBe(0);
    expect((await verifyKnowledge({ scope: scope(), limit: 0 })).checked).toBe(0);
    expect((await verifyKnowledge({ scope: scope(), since: Date.now() + 1000 })).checked).toBe(0);
    await expect(verifyKnowledge({ limit: -1 })).rejects.toThrow('limit');
    await expect(verifyKnowledge({ since: NaN })).rejects.toThrow('since');
  });
  it('CLI reports by default, fixes explicitly, and dry-run overrides fix', () => {
    fs.unlinkSync(chunk.source_file);
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            'dist/bin/contextos.js',
            'verify',
            '--scope',
            fixture.sources[0].repoId,
            '--json',
            ...args
          ],
          { env: { ...process.env, HOME: fixture.home }, encoding: 'utf8' }
        )
      );
    expect(cli().dryRun).toBe(true);
    expect(read().status).toBe('verified');
    expect(cli('--fix', '--dry-run').dryRun).toBe(true);
    expect(read().status).toBe('verified');
    expect(cli('--fix').dryRun).toBe(false);
    expect(read().status).toBe('stale');
  });
  it('reanchors link endpoints and identity so subsequent agent writes retain the ID', async () => {
    const source = fixture.sources[0];
    const other = indexes[0]
      .prepare('SELECT id FROM chunks WHERE id<>? ORDER BY id LIMIT 1')
      .get(chunk.id) as { id: string };
    const target = entityRef(source.repoId, 'chunk', other.id);
    const link = graph.link(
      {
        source: fact.evidence[0].ref,
        target,
        type: 'imports',
        rationale: 'Fixture connection',
        expectedGenerations: { [source.repoId]: source.generation }
      },
      [source.repoId]
    );
    indexes[0].prepare('DELETE FROM relationships WHERE source_chunk_id=?').run(chunk.id);
    indexes[0].prepare('UPDATE chunks SET id=? WHERE id=?').run('moved-link-source', chunk.id);
    await verify();
    const again = graph.link(
      {
        source: entityRef(source.repoId, 'chunk', 'moved-link-source'),
        target,
        type: 'imports',
        rationale: 'Fixture connection',
        expectedGenerations: { [source.repoId]: source.generation }
      },
      [source.repoId]
    );
    expect(again.id).toBe(link.id);
    expect(store.prepare('SELECT COUNT(*) AS n FROM verified_links').get()).toEqual({ n: 1 });
  });
  it('reports legacy facts as unverifiable and includes their status in the summary', async () => {
    indexes[0]
      .prepare(
        "INSERT INTO knowledge_facts(id,fact,category,created_at,updated_at,last_accessed,status) VALUES ('legacy','No code evidence','general',1,1,1,'proposed')"
      )
      .run();
    expect((await verify()).items.find((i) => i.id === 'legacy')).toMatchObject({
      kind: 'legacy-fact',
      outcome: 'unverifiable',
      applied: false,
      status: 'proposed'
    });
    expect(getStalenessSummary(scope())).toMatchObject({
      total: 2,
      byStatus: { proposed: 1, verified: 1, stale: 0 }
    });
  });
  it('defers when shared write freshness validation rejects checkout metadata', async () => {
    indexes[0]
      .prepare("INSERT OR REPLACE INTO repository_metadata VALUES ('needs_reindex','1')")
      .run();
    expect((await verify()).items[0].outcome).toBe('deferred');
    expect(read()).toMatchObject({ status: 'verified', verified_at: null });
  });
  it('keeps old references when a replacement link identity already exists', async () => {
    const source = fixture.sources[0];
    const other = indexes[0]
      .prepare('SELECT id FROM chunks WHERE id<>? ORDER BY id LIMIT 1')
      .get(chunk.id) as { id: string };
    const input = {
      source: fact.evidence[0].ref,
      target: entityRef(source.repoId, 'chunk', other.id),
      type: 'imports' as const,
      rationale: 'Fixture connection',
      expectedGenerations: { [source.repoId]: source.generation }
    };
    const old = graph.link(input, [source.repoId]);
    indexes[0].prepare('DELETE FROM relationships WHERE source_chunk_id=?').run(chunk.id);
    indexes[0].prepare('UPDATE chunks SET id=? WHERE id=?').run('new-source', chunk.id);
    graph.link({ ...input, source: entityRef(source.repoId, 'chunk', 'new-source') }, [
      source.repoId
    ]);
    expect((await verify()).items.find((i) => i.id === old.id)).toMatchObject({
      outcome: 'deferred',
      applied: false
    });
    expect(store.prepare('SELECT COUNT(*) AS n FROM verified_links').get()).toEqual({ n: 2 });
  });
  it('runs real scheduled sweeps in a daemon worker without indexing lease changes', async () => {
    const previous = process.env.CONTEXTOS_VERIFY_INTERVAL_MS;
    process.env.CONTEXTOS_VERIFY_INTERVAL_MS = '50';
    const lease = fixture.registry.lease(fixture.sources[0].repoId);
    const { startVerificationScheduler } = await import(
      new URL('../../dist/src/core/verify/scheduler.js', import.meta.url).href
    );
    const scheduler = startVerificationScheduler(fixture.registry.home);
    try {
      await vi.waitFor(() => expect(read().verified_at).toEqual(expect.any(Number)), {
        timeout: 15_000,
        interval: 25
      });
      expect(fixture.registry.lease(fixture.sources[0].repoId)).toEqual(lease);
    } finally {
      await scheduler.stop();
      if (previous === undefined) delete process.env.CONTEXTOS_VERIFY_INTERVAL_MS;
      else process.env.CONTEXTOS_VERIFY_INTERVAL_MS = previous;
    }
  });
});
