import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime, RepositoryRuntime } from '../../src/core/workspace/runtime.js';
import { retrieveWorkspace } from '../../src/core/workspace/retrieval.js';
import { entityRef, parseRef } from '../../src/core/workspace/identity.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { compile } from '../../src/core/compiler/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';

let temp: string;
let registry: WorkspaceRegistry;
let runtime: WorkspaceRuntime;
const names = ['backend', 'frontend', 'shared-types', 'infrastructure'];
const prompt = 'Where is payment status defined, processed, and displayed?';
const clients: Client[] = [];
const servers: McpServer[] = [];
beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'cws-'));
  const home = path.join(temp, 'home');
  fs.mkdirSync(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  registry = new WorkspaceRegistry();
  runtime = new WorkspaceRuntime(registry, 'default');
  for (const name of names) {
    const root = path.join(temp, name);
    fs.cpSync(path.resolve('tests/fixtures/workspace', name), root, { recursive: true });
    const source = registry.register(root);
    await runtime.get(source).index();
  }
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  await runtime.close();
  registry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});
async function connect(active = 'backend') {
  const server = new McpServer({ name: 'workspace-test', version: '1.1.1' });
  servers.push(server);
  registerWorkspaceTools(server, runtime, {
    cwd: temp,
    activeRepoId: registry.resolve(active).repoId
  });
  const client = new Client({ name: 'test', version: '1' });
  clients.push(client);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  return client;
}

describe('workspace registration and identity', () => {
  it('persists IDs, canonical aliases and multiple memberships without duplicate indexes', () => {
    const original = registry.resolve('backend');
    const alias = path.join(temp, 'alias');
    fs.symlinkSync(original.rootPath, alias, 'dir');
    expect(registry.register(alias).repoId).toBe(original.repoId);
    registry.ensureWorkspace('payments');
    registry.register(alias, { workspace: 'payments' });
    registry.remove('backend');
    expect(registry.list()).toHaveLength(3);
    expect(registry.list('payments')[0].repoId).toBe(original.repoId);
    expect(registry.register(original.rootPath).repoId).toBe(original.repoId);
    const reopened = new WorkspaceRegistry();
    try {
      expect(reopened.resolve('backend').repoId).toBe(original.repoId);
    } finally {
      reopened.close();
    }
  });
  it('allocates a separate identity when an indexed checkout is copied', async () => {
    const original = registry.resolve('backend');
    const copy = path.join(temp, 'copy');
    fs.cpSync(original.rootPath, copy, { recursive: true });
    const copied = registry.register(copy, { name: 'backend-copy' });
    expect(copied.repoId).not.toBe(original.repoId);
    const copyDb = new RepositoryRuntime(copied, registry);
    try {
      expect(
        (
          copyDb.db.getInstance().prepare('SELECT DISTINCT repo_id FROM chunks').all() as {
            repo_id: string;
          }[]
        ).every((r) => r.repo_id === copied.repoId)
      ).toBe(true);
    } finally {
      await copyDb.close();
    }
  });
  it('requires unique names and rejects invalid selectors', () => {
    const other = path.join(temp, 'other', 'backend');
    fs.mkdirSync(other, { recursive: true });
    expect(() => registry.register(other)).toThrow('--name');
    expect(() => registry.select({ repo: ['backend'], allRepos: true }, temp)).toThrow(
      'cannot be combined'
    );
    expect(() => registry.select({}, temp)).toThrow('No active');
    expect(() => registry.select({ repo: ['missing'] }, temp)).toThrow('Unknown repository');
    registry.ensureWorkspace('empty');
    expect(() => registry.select({ workspace: 'empty' }, temp)).toThrow('no repositories');
    expect(() => registry.select({ workspace: 'empty', repo: ['backend'] }, temp)).toThrow(
      'outside'
    );
  });
  it('imports legacy workspace memberships and preserves unavailable paths and backup', () => {
    const file = path.join(os.homedir(), '.contextos', 'workspaces.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        legacy: { repos: [registry.resolve('backend').rootPath, path.join(temp, 'missing')] }
      })
    );
    const imported = new WorkspaceRegistry();
    try {
      expect(imported.list('legacy')).toHaveLength(2);
      expect(imported.list('legacy').find((source) => source.name === 'missing')?.state).toBe(
        'unavailable'
      );
      expect(fs.readFileSync(file + '.backup', 'utf8')).toBe(fs.readFileSync(file, 'utf8'));
    } finally {
      imported.close();
    }
  });
  it('closes database handles over repeated independent runtime lifecycles', async () => {
    await runtime.close();
    if (!fs.existsSync('/proc/self/fd')) return;
    const count = () => fs.readdirSync('/proc/self/fd').length;
    const before = count();
    for (let i = 0; i < 20; i++) {
      const transient = new WorkspaceRuntime(registry);
      await retrieveWorkspace(
        transient,
        registry.select({ repo: ['backend'] }, temp),
        'processPaymentStatus'
      );
      await transient.close();
    }
    expect(count()).toBeLessThanOrEqual(before + 2);
  });
  it('stores ownership without changing local IDs and qualifies references losslessly', () => {
    const source = registry.resolve('backend');
    const db = runtime.get(source).db.getInstance();
    for (const table of ['files', 'chunks', 'relationships']) {
      expect(
        (
          db
            .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE repo_id IS NULL OR repo_id!=?`)
            .get(source.repoId) as { n: number }
        ).n
      ).toBe(0);
    }
    expect(parseRef(entityRef(source.repoId, 'chunk', 'same:id/with spaces'))).toEqual({
      repoId: source.repoId,
      kind: 'chunk',
      localId: 'same:id/with spaces'
    });
  });
});
describe('federated retrieval', () => {
  it('retrieves and compiles all three payment roles with repository citations', async () => {
    const result = await retrieveWorkspace(
      runtime,
      registry.select({ allRepos: true }, temp),
      prompt,
      { explain: true }
    );
    const repos = new Set(result.chunks.slice(0, 10).map((c) => c.repoName));
    for (const name of names.slice(0, 3)) expect(repos.has(name)).toBe(true);
    expect(new Set(result.chunks.map((c) => c.id)).size).toBe(result.chunks.length);
    const compiled = compile(result, { maxTokens: 4000, explain: true });
    for (const name of names.slice(0, 3)) expect(compiled.output).toContain(name + '/payment.ts');
    const xml = compile(result, { maxTokens: 4000, outputFormat: 'xml' });
    for (const name of names.slice(0, 3)) expect(xml.output).toContain(name + '/payment.ts');
    expect(result.explanation?.chunks[result.chunks[0].id].repository).toBeDefined();
  });
  it('filters every retrieval path to selected repositories', async () => {
    const scope = registry.select({ repo: ['frontend'] }, temp);
    const result = await retrieveWorkspace(runtime, scope, prompt);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(result.chunks.every((c) => c.repoName === 'frontend')).toBe(true);
    const filtered = await retrieveWorkspace(runtime, scope, prompt, { layers: ['global'] });
    expect(filtered.chunks).toEqual([]);
  });
  it('preserves identical content and local IDs from separate databases', async () => {
    for (const name of ['backend', 'frontend']) {
      const source = registry.resolve(name);
      const chunks = new ChunksRepo(runtime.get(source).db.getInstance());
      const original = chunks.findByFileStem('payment', 1)[0];
      chunks.upsert({
        ...original,
        id: 'identical-local-id',
        content: 'export function paymentStatusMarker() { return "payment status marker"; }',
        hash: 'identical-hash',
        symbolName: 'paymentStatusMarker'
      });
    }
    const result = await retrieveWorkspace(
      runtime,
      registry.select({ repo: ['backend', 'frontend'] }, temp),
      'paymentStatusMarker'
    );
    const hits = result.chunks.filter((c) => c.localId === 'identical-local-id');
    expect(hits).toHaveLength(2);
    expect(hits[0].id).not.toBe(hits[1].id);
    expect(compile(result, { maxTokens: 4000 }).output).toContain('frontend/payment.ts');
  });
  it('does not chain graph edges through matching names in another repository', async () => {
    const backend = runtime.get(registry.resolve('backend')).db.getInstance();
    const frontend = runtime.get(registry.resolve('frontend')).db.getInstance();
    const insert = (db: typeof backend, source: string, target: string) => {
      const chunk = (db.prepare('SELECT id FROM chunks LIMIT 1').get() as { id: string }).id;
      db.prepare(
        "INSERT INTO relationships (source,target,relationship_type,weight,source_chunk_id,layer,created_at) VALUES (?,?,'calls',1,?,'repo',1)"
      ).run(source, target, chunk);
    };
    insert(backend, 'BackendAnchor', 'SharedBridge');
    insert(frontend, 'SharedBridge', 'ForeignOnlyTarget');
    const result = await retrieveWorkspace(
      runtime,
      registry.select({ repo: ['backend', 'frontend'] }, temp),
      'BackendAnchor'
    );
    expect(result.expandedEntities.some((entity) => entity.entity === 'SharedBridge')).toBe(true);
    expect(result.expandedEntities.some((entity) => entity.entity === 'ForeignOnlyTarget')).toBe(
      false
    );
  });
  it('returns marked partial results and fails when all sources are unavailable', async () => {
    const source = registry.resolve('frontend');
    const cold = new WorkspaceRuntime(registry);
    fs.renameSync(source.rootPath, source.rootPath + '-offline');
    try {
      const result = await retrieveWorkspace(
        cold,
        registry.select({ allRepos: true }, temp),
        prompt
      );
      expect(result.partial).toBe(true);
      expect(result.unavailableSources?.[0].name).toBe('frontend');
      await expect(
        retrieveWorkspace(cold, registry.select({ repo: ['frontend'] }, temp), prompt)
      ).rejects.toThrow('All selected');
    } finally {
      await cold.close();
      fs.renameSync(source.rootPath + '-offline', source.rootPath);
    }
  });
});
describe('independent updates and ownership', () => {
  it('indexes different repositories concurrently and removes only local stale files', async () => {
    const before = new Map(
      names.map((name) => [
        name,
        runtime
          .get(registry.resolve(name))
          .db.getInstance()
          .prepare('SELECT id,hash FROM chunks ORDER BY id')
          .all()
      ])
    );
    const backend = registry.resolve('backend');
    const frontend = registry.resolve('frontend');
    fs.appendFileSync(
      path.join(backend.rootPath, 'payment.ts'),
      '\nexport function paymentAudit() { return "audited"; }'
    );
    fs.unlinkSync(path.join(frontend.rootPath, 'payment.ts'));
    await Promise.all([runtime.get(backend).index(true), runtime.get(frontend).index(true)]);
    expect(
      new ChunksRepo(runtime.get(backend).db.getInstance()).findBySymbolName('paymentAudit')
    ).toHaveLength(1);
    expect(runtime.get(frontend).status().chunks).toBe(0);
    for (const name of ['shared-types', 'infrastructure'])
      expect(
        runtime
          .get(registry.resolve(name))
          .db.getInstance()
          .prepare('SELECT id,hash FROM chunks ORDER BY id')
          .all()
      ).toEqual(before.get(name));
  });
  it('routes indexing to the existing owner and preserves its lease', async () => {
    const source = registry.resolve('backend');
    const owner = runtime.get(source);
    await owner.request({ action: 'index' });
    const other = new RepositoryRuntime(source, registry);
    try {
      fs.appendFileSync(
        path.join(source.rootPath, 'payment.ts'),
        '\nexport const ownerRoutedPayment = 1;'
      );
      await other.request({ action: 'file', file: 'payment.ts' });
      expect(
        new ChunksRepo(owner.db.getInstance()).findBySymbolName('ownerRoutedPayment').length
      ).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
    expect(fs.existsSync(path.join(path.dirname(source.dbPath), 'index-owner.json'))).toBe(true);
  });
  it('replays watcher edits and closes watcher resources', async () => {
    const source = registry.resolve('backend');
    await runtime.get(source).watch();
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.appendFileSync(
      path.join(source.rootPath, 'payment.ts'),
      '\nexport function watchedPaymentStatus() { return "watched"; }'
    );
    await vi.waitFor(
      () =>
        expect(
          new ChunksRepo(runtime.get(source).db.getInstance()).findBySymbolName(
            'watchedPaymentStatus'
          )
        ).toHaveLength(1),
      { timeout: 5000 }
    );
  });
});
describe('MCP scope and connection state', () => {
  it('defaults to active repository and supports workspace scope with follow-up file access', async () => {
    const client = await connect();
    const local = await client.callTool({
      name: 'get_context',
      arguments: { prompt, tier: 'full' }
    });
    expect((local.structuredContent as { scope: { repoIds: string[] } }).scope.repoIds).toEqual([
      registry.resolve('backend').repoId
    ]);
    const all = await client.callTool({
      name: 'get_context',
      arguments: { prompt, all_repos: true, tier: 'full', max_tokens: 4000 }
    });
    expect((all.structuredContent as { scope: { repoIds: string[] } }).scope.repoIds).toHaveLength(
      4
    );
    const read = await client.callTool({
      name: 'ctx_read_file',
      arguments: { filePath: 'payment.ts', repo: 'frontend' }
    });
    expect(JSON.stringify(read.content)).toContain('displayPaymentStatus');
    const denied = await client.callTool({
      name: 'ctx_read_file',
      arguments: { filePath: path.join(temp, 'home', 'secret') }
    });
    expect(denied.isError).toBe(true);
    const noScopeLeak = await client.callTool({
      name: 'get_context',
      arguments: { prompt: 'processPaymentStatus', tier: 'full' }
    });
    expect(
      (noScopeLeak.structuredContent as { scope: { repoIds: string[] } }).scope.repoIds
    ).toEqual([registry.resolve('backend').repoId]);
  });
  it('reports invalid expand paths as errors and does not expose outside files', async () => {
    const client = await connect();
    const secret = path.join(temp, 'secret.txt');
    fs.writeFileSync(secret, 'OutsideSecretMarker');
    fs.symlinkSync(secret, path.join(registry.resolve('backend').rootPath, 'outside-link'));
    for (const file of ['../secret.txt', 'outside-link']) {
      const result = await client.callTool({
        name: 'ctx_expand',
        arguments: { paths: [file], terms: ['OutsideSecretMarker'] }
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).not.toContain('OutsideSecretMarker');
    }
  });
  it('isolates sessions and memories between clients and repositories', async () => {
    const first = await connect('backend');
    const second = await connect('frontend');
    await first.callTool({
      name: 'ctx_remember',
      arguments: { type: 'session_note', content: 'UniquePaymentSessionMarker' }
    });
    const savedFact = await first.callTool({
      name: 'ctx_remember',
      arguments: {
        type: 'cross_session_fact',
        content: 'BackendPaymentFactMarker',
        provenance: 'user'
      }
    });
    expect(savedFact.isError).not.toBe(true);
    const other = await second.callTool({
      name: 'get_context',
      arguments: { prompt: 'UniquePaymentSessionMarker BackendPaymentFactMarker', tier: 'full' }
    });
    expect(JSON.stringify(other.content)).not.toContain('BackendPaymentFactMarker');
    expect(JSON.stringify(other.content)).not.toContain('UniquePaymentSessionMarker');
    const sameRepoClient = await connect('backend');
    const sessionResult = await sameRepoClient.callTool({
      name: 'get_context',
      arguments: { prompt: 'UniquePaymentSessionMarker', tier: 'full' }
    });
    expect(JSON.stringify(sessionResult.content)).not.toContain('UniquePaymentSessionMarker');
  });
  it('refreshes workspace membership without a server restart', async () => {
    const client = await connect();
    registry.remove('frontend');
    const result = await client.callTool({
      name: 'get_context',
      arguments: { prompt, all_repos: true, tier: 'full' }
    });
    expect(
      (result.structuredContent as { scope: { repoIds: string[] } }).scope.repoIds
    ).not.toContain(registry.resolve('frontend').repoId);
    const rejected = await client.callTool({
      name: 'ctx_read_file',
      arguments: { filePath: 'payment.ts', repo: 'frontend' }
    });
    expect(rejected.isError).toBe(true);
  });
});
