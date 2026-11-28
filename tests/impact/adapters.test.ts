import fs from 'node:fs';
import Database from 'better-sqlite3';
import { parseRef } from '../../src/core/workspace/identity.js';
import type { Evidence } from '../../src/core/knowledge/graph-store.js';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { workspaceImpact } from '../../src/core/impact/adapter.js';
import { agentInstructionsBlock } from '../../src/cli/utils/agent-instructions.js';

let f: Awaited<ReturnType<typeof createFixtureGroup>>;
let graph: GraphStore;
let server: McpServer;
let client: Client;
let target: string, caller: string, infra: string;
type Output = Awaited<ReturnType<typeof workspaceImpact>>;
const patch =
  '--- a/src/client.ts\n+++ b/src/client.ts\n@@ -2 +2 @@\n-export async function createOrder(baseUrl: string, order: Order): Promise<Order> {\n+export async function createOrder(baseUrl: string, order: Order): Promise<Order> { // changed\n';
const resolve = (id: string) => {
  const source = f.registry.resolve(id);
  return { source, db: f.runtime.get(source).db.getInstance() };
};
function ref(index: number, file: string) {
  const source = f.sources[index];
  const row = resolve(source.repoId)
    .db.prepare(
      "SELECT id FROM chunks WHERE source_file=? ORDER BY (symbol_kind='function') DESC,start_line,id LIMIT 1"
    )
    .get(path.join(source.rootPath, file)) as { id: string };
  return entityRef(source.repoId, 'chunk', row.id);
}
function saved(
  source: string,
  target: string,
  status: 'verified' | 'proposed' | 'stale' = 'verified'
) {
  return graph.link(
    {
      source,
      target,
      type: 'reads_resource',
      rationale: 'Fixture deployment consumes the service',
      status,
      expectedGenerations: Object.fromEntries(f.sources.map((s) => [s.repoId, s.generation]))
    },
    f.sources.map((s) => s.repoId)
  );
}
async function call(args: Record<string, unknown> = {}) {
  return client.callTool({
    name: 'ctx_impact',
    arguments: { group: 'foundation-130', files: [{ path: 'src/client.ts' }], ...args }
  });
}
beforeAll(async () => {
  f = await createFixtureGroup();
  graph = new GraphStore({ home: f.registry.home, resolve });
  target = ref(0, 'src/client.ts');
  caller = ref(1, 'src/worker.ts');
  infra = ref(0, 'docker-compose.yml');
  const base = saved(caller, target);
  // Seed the importer read interface directly: D1 infra file hashes include a parser
  // fingerprint, while the existing GraphStore writer compares a raw disk hash.
  const snapshotEvidence = (reference: string): Evidence => {
    const parsed = parseRef(reference)!;
    const { source, db } = resolve(parsed.repoId);
    const chunk = db
      .prepare('SELECT source_file,hash FROM chunks WHERE id=?')
      .get(parsed.localId) as { source_file: string; hash: string };
    const file = db.prepare('SELECT hash FROM files WHERE path=?').get(chunk.source_file) as {
      hash: string;
    };
    return {
      ref: reference,
      viewId: source.repoId,
      projectId: source.projectId,
      file: chunk.source_file,
      fileHash: file.hash,
      chunkHash: chunk.hash,
      generation: source.generation
    };
  };
  const infraEvidence = snapshotEvidence(infra);
  const store = new Database(path.join(f.registry.home, 'graph.db'));
  try {
    store.prepare('INSERT INTO verified_links (id,identity,payload) VALUES (?,?,?)').run(
      'infra-link',
      'infra-link',
      JSON.stringify({
        ...base,
        id: 'infra-link',
        source: infra,
        evidence: [infraEvidence, snapshotEvidence(target)]
      })
    );
    store.prepare('INSERT INTO verified_facts (id,identity,payload) VALUES (?,?,?)').run(
      'infra-fact',
      'infra-fact',
      JSON.stringify({
        id: 'infra-fact',
        content: 'Compose orders deploys service-a',
        category: 'infra',
        scope: 'view',
        scopeId: f.sources[0].repoId,
        viewIds: [f.sources[0].repoId],
        provenance: 'code',
        evidence: [infraEvidence]
      })
    );
  } finally {
    store.close();
  }
  server = new McpServer({ name: 'impact-test', version: 'test' });
  client = new Client({ name: 'test', version: 'test' });
  registerWorkspaceTools(server, f.runtime, {
    cwd: f.sources[0].rootPath,
    activeRepoId: f.sources[0].repoId
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
}, 30000);
afterAll(async () => {
  await client?.close();
  await server?.close();
  graph?.close();
  await f?.cleanup();
});

it('registers selectors and a concise preventive instruction without changing the header', async () => {
  const tool = (await client.listTools()).tools.find((t) => t.name === 'ctx_impact')!;
  expect(tool.description).toContain('before changing exported symbols');
  expect(tool.inputSchema.properties).toHaveProperty('include_stale');
  expect(agentInstructionsBlock()).toContain('managed instructions v1.2.5');
  expect(agentInstructionsBlock()).toContain('call ctx_impact');
});
it('returns compact transport results with coverage, caveat, deployment facts and links', async () => {
  const result = await call();
  expect(result.isError).not.toBe(true);
  const output = result.structuredContent as unknown as Output;
  expect(result.content).toEqual([]);
  expect(output.summary).toContain('does not establish no impact');
  expect(output.coverage.complete).toBe(false);
  expect(output.impacted).toContainEqual(expect.objectContaining({ ref: caller }));
  expect(output.impacted.every((i) => i.evidence === undefined)).toBe(true);
  expect(output.deployment.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ match: 'evidence-owner', category: 'infra' }),
      expect.objectContaining({ match: 'saved-link' })
    ])
  );
  expect(JSON.stringify(output).length).toBeLessThan(12000);
  const verbose = (await call({ verbose: true })).structuredContent as unknown as Output;
  expect(verbose.impacted.every((i) => (i.evidence?.length ?? 0) > 0)).toBe(true);
});
it('paginates deterministically, preserves coverage and reports invalid/conflicting inputs', async () => {
  const first = (await call({ limit: 1 })).structuredContent as unknown as Output;
  const second = (await call({ limit: 1, offset: 1 })).structuredContent as unknown as Output;
  expect(first.pagination.hasMore).toBe(true);
  expect(first.impacted[0].ref).not.toBe(second.impacted[0].ref);
  expect(first.coverage).toEqual(second.coverage);
  expect((await call({ diff: patch })).isError).toBe(true);
  expect((await call({ files: [{ path: '../escape' }] })).isError).toBe(true);
  expect(
    (await call({ files: [{ path: 'src/client.ts', range: { start: 9, end: 1 } }] })).isError
  ).toBe(true);
  expect((await call({ view: 'missing-view' })).isError).toBe(true);
});
it('keeps proposed and stale opt-ins independent and labels deployment status', async () => {
  const proposed = saved(ref(2, 'src/index.ts'), target, 'proposed');
  expect(JSON.stringify((await call()).structuredContent)).not.toContain(proposed.source);
  expect(JSON.stringify((await call({ include_stale: true })).structuredContent)).not.toContain(
    proposed.source
  );
  expect(JSON.stringify((await call({ include_proposed: true })).structuredContent)).toContain(
    proposed.source
  );
  saved(proposed.source, target, 'stale');
  expect(JSON.stringify((await call({ include_proposed: true })).structuredContent)).not.toContain(
    proposed.source
  );
  const stale = (await call({ include_stale: true })).structuredContent as unknown as Output;
  expect(stale.impacted).toContainEqual(
    expect.objectContaining({ ref: proposed.source, status: 'stale' })
  );
  graph.unlink(
    proposed.id,
    f.sources.map((s) => s.repoId)
  );
});
it('degrades to empty deployment coverage in an unrelated repository and rejects bad pagination', async () => {
  const scope = f.registry.select({ project: [f.sources[2].repoId] }, f.sources[2].rootPath);
  const result = await workspaceImpact(f.runtime, scope, { files: [{ path: 'src/index.ts' }] });
  expect(result.deployment.items).toEqual([]);
  expect(result.deployment.coverage.note).toContain('unknown');
  await expect(workspaceImpact(f.runtime, scope, { limit: 0 })).rejects.toThrow('pagination');
});
it('executes the built CLI for working-tree, revision, file and stdin diffs', async () => {
  const bin = fileURLToPath(new URL('../../dist/bin/contextos.js', import.meta.url));
  const source = f.sources[0],
    file = path.join(source.rootPath, 'src/client.ts');
  const original = fs.readFileSync(file, 'utf8');
  const run = (args: string[], input?: string) => {
    const child = spawnSync(process.execPath, [bin, 'impact', ...args, '--json'], {
      cwd: source.rootPath,
      env: process.env,
      input,
      encoding: 'utf8',
      timeout: 30000
    });
    expect(child.status, child.stderr).toBe(0);
    return JSON.parse(child.stdout);
  };
  try {
    fs.writeFileSync(file, original + '\n// working-tree change\n');
    expect(run([]).changes[0].file).toBe('src/client.ts');
    const diffFile = path.join(f.root, 'change.diff');
    fs.writeFileSync(diffFile, patch);
    expect(run(['--diff-file', diffFile, '--group', 'foundation-130']).impacted).toContainEqual(
      expect.objectContaining({ ref: caller })
    );
    expect(run(['--diff-file', '-'], patch).changes[0].file).toBe('src/client.ts');
    expect(run(['--base', 'HEAD', '--head', 'HEAD']).changes).toEqual([]);
    execFileSync('git', ['diff', '--no-ext-diff', 'HEAD'], { cwd: source.rootPath });
    const bad = spawnSync(process.execPath, [bin, 'impact', '--depth', '0', '--json'], {
      cwd: source.rootPath,
      env: process.env,
      encoding: 'utf8'
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('Impact limit');
  } finally {
    fs.writeFileSync(file, original);
  }
}, 60000);

it('filters deployment lifecycle, expiry, scope and invalid snapshot evidence', async () => {
  const store = new Database(path.join(f.registry.home, 'graph.db'));
  const original = store
    .prepare('SELECT payload FROM verified_facts WHERE id=?')
    .get('infra-fact') as { payload: string };
  const output = async (args: Record<string, unknown> = {}) =>
    (await call(args)).structuredContent as unknown as Output;
  const hasFact = (result: Output) =>
    result.deployment.items.some((item) => item.id === 'infra-fact');
  try {
    store.prepare("UPDATE verified_facts SET status='proposed' WHERE id=?").run('infra-fact');
    expect(hasFact(await output())).toBe(false);
    expect(hasFact(await output({ include_stale: true }))).toBe(false);
    expect(hasFact(await output({ include_proposed: true }))).toBe(true);
    store.prepare("UPDATE verified_facts SET status='stale' WHERE id=?").run('infra-fact');
    expect(hasFact(await output({ include_proposed: true }))).toBe(false);
    expect(hasFact(await output({ include_stale: true }))).toBe(true);
    store
      .prepare("UPDATE verified_facts SET status='verified',expires_at=1 WHERE id=?")
      .run('infra-fact');
    expect(hasFact(await output({ include_stale: true, include_proposed: true }))).toBe(false);
    const payload = JSON.parse(original.payload);
    store
      .prepare('UPDATE verified_facts SET expires_at=NULL,payload=? WHERE id=?')
      .run(JSON.stringify({ ...payload, viewIds: ['foreign'] }), 'infra-fact');
    expect(hasFact(await output())).toBe(false);
    payload.evidence[0].chunkHash = 'invalid';
    store
      .prepare('UPDATE verified_facts SET payload=? WHERE id=?')
      .run(JSON.stringify(payload), 'infra-fact');
    expect(hasFact(await output({ include_stale: true }))).toBe(false);
  } finally {
    store
      .prepare("UPDATE verified_facts SET status='verified',expires_at=NULL,payload=? WHERE id=?")
      .run(original.payload, 'infra-fact');
    store.close();
  }
});

it('uses boundary-aware repository mentions without guessing deployment dependencies', async () => {
  const a = f.sources[0];
  const access = [a.repoId];
  const good = graph.remember(
    {
      content: 'Kubernetes workload deploys service-a in staging',
      category: 'service',
      scope: 'view',
      scopeId: a.repoId,
      viewIds: access,
      provenance: 'user'
    },
    access
  );
  const other = graph.remember(
    {
      content: 'Kubernetes workload deploys service-ab in staging',
      category: 'infra',
      scope: 'view',
      scopeId: a.repoId,
      viewIds: access,
      provenance: 'user'
    },
    access
  );
  try {
    const output = (await call()).structuredContent as unknown as Output;
    expect(output.deployment.items).toContainEqual(
      expect.objectContaining({ id: good.id, match: 'repository-mention' })
    );
    expect(output.deployment.items.some((item) => item.id === other.id)).toBe(false);
    expect(output.deployment.coverage.note).toContain('does not prove');
  } finally {
    graph.forget(good.id, access);
    graph.forget(other.id, access);
  }
});
