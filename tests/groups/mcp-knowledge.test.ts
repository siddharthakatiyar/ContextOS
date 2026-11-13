import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { DB } from '../../src/core/storage/database.js';
import { FilesRepo } from '../../src/core/storage/files-repo.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime } from '../../src/core/workspace/runtime.js';
import { registerWorkspaceTools } from '../../src/mcp/workspace-tools.js';

let temp: string;
let registry: WorkspaceRegistry;
let runtime: WorkspaceRuntime;
let server: McpServer;
let client: Client;
beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-agent-'));
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(temp, 'home'));
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  registry = new WorkspaceRegistry();
  runtime = new WorkspaceRuntime(registry);
  for (const name of ['backend', 'frontend']) {
    const root = path.join(temp, name);
    fs.cpSync(path.resolve('tests/fixtures/workspace', name), root, { recursive: true });
    await runtime.get(registry.register(root)).index();
  }
  server = new McpServer({ name: 'agent-test', version: '1' });
  registerWorkspaceTools(server, runtime, {
    cwd: path.join(temp, 'backend'),
    workspace: 'default'
  });
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  await runtime?.close();
  registry?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});
it('uses selected view token settings while preserving explicit request limits', async () => {
  const owner = runtime.get(registry.resolve('backend'));
  owner.config.maxTokenBudget = 100;
  owner.config.maxExactTokenBudget = 600;
  owner.config.framingReserve = 9;
  const ordinary = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'Where are payment states handled?', tier: 'full', explain: true }
  });
  expect(ordinary.isError).not.toBe(true);
  const normalData = ordinary.structuredContent as {
    tokens: number;
    compilation: { configuredMaxTokens: number; framingReserve: number };
  };
  expect(normalData.compilation).toMatchObject({ configuredMaxTokens: 100, framingReserve: 9 });
  const exact = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'processPaymentStatus', tier: 'full', explain: true }
  });
  expect(exact.isError).not.toBe(true);
  expect(
    (exact.structuredContent as { compilation: { effectiveMaxTokens: number } }).compilation
      .effectiveMaxTokens
  ).toBe(600);
  const explicit = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'processPaymentStatus', tier: 'full', max_tokens: 80, explain: true }
  });
  expect(explicit.isError).not.toBe(true);
  expect((explicit.structuredContent as { tokens: number }).tokens).toBeLessThanOrEqual(80);
});
it('lets an agent inspect qualified evidence, save a connection, retrieve it and remove stale cached knowledge', async () => {
  const backend = await client.callTool({
    name: 'ctx_symbol',
    arguments: { symbolName: 'processPaymentStatus', project: 'backend' }
  });
  const frontend = await client.callTool({
    name: 'ctx_symbol',
    arguments: { symbolName: 'displayPaymentStatus', project: 'frontend' }
  });
  const source = backend.structuredContent as {
    source: {
      repoId: string;
      projectId: string;
      worktreeId: string;
      branch: string | null;
      generation: number;
    };
    chunks: { ref: string }[];
  };
  const target = frontend.structuredContent as typeof source;
  expect(source.source.projectId).toBeTruthy();
  expect(source.source.worktreeId).toBeTruthy();
  expect(source.source).toHaveProperty('branch');
  expect(source.chunks[0].ref).toContain(`contextos:${source.source.repoId}:chunk:`);
  const linked = await client.callTool({
    name: 'ctx_link',
    arguments: {
      group: 'default',
      source: source.chunks[0].ref,
      target: target.chunks[0].ref,
      relationship: 'implements_contract',
      rationale: 'Fixture establishes the shared payment status transition/display contract.',
      expected_generations: {
        [source.source.repoId]: source.source.generation,
        [target.source.repoId]: target.source.generation
      }
    }
  });
  expect(linked.isError).not.toBe(true);
  const args = {
    prompt: 'processPaymentStatus displayPaymentStatus',
    group: 'default',
    tier: 'full',
    max_tokens: 4000
  };
  const first = await client.callTool({ name: 'get_context', arguments: args });
  expect((first.structuredContent as { knowledgeLinks: unknown[] }).knowledgeLinks).toHaveLength(1);
  const excluded = await client.callTool({ name: 'ctx_links', arguments: { project: 'backend' } });
  expect(JSON.stringify(excluded.content)).not.toContain('Fixture establishes');
  fs.appendFileSync(
    path.join(temp, 'frontend/payment.ts'),
    '\n// changed evidence before reindex\n'
  );
  const afterEdit = await client.callTool({ name: 'get_context', arguments: args });
  expect(
    (afterEdit.structuredContent as { knowledgeLinks: unknown[] }).knowledgeLinks ?? []
  ).toHaveLength(0);
  const links = await client.callTool({ name: 'ctx_links', arguments: { group: 'default' } });
  expect(JSON.stringify(links.content)).not.toContain('Fixture establishes');
});

it('rejects evidence from a checkout changed before registry refresh and preserves project decisions across branches', async () => {
  const root = path.join(temp, 'git-project');
  fs.cpSync(path.resolve('tests/fixtures/workspace/backend'), root, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8'
    });
  git('init', '-b', 'main');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-m',
    'Fixture'
  );
  await runtime.get(registry.register(root)).index();
  const source = registry.resolve(root);
  const db = runtime.get(source).db.getInstance();
  const chunk = new ChunksRepo(db).findBySymbolName('processPaymentStatus')[0];
  const ref = entityRef(source.repoId, 'chunk', chunk.id);
  const staleGraph = new GraphStore({ home: registry.home, resolve: () => ({ source, db }) });
  const secondServer = new McpServer({ name: 'branch-knowledge', version: '1' });
  const secondClient = new Client({ name: 'test', version: '1' });
  registerWorkspaceTools(secondServer, runtime, { cwd: root, workspace: 'default' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await secondServer.connect(a);
    await secondClient.connect(b);
    const decision = await secondClient.callTool({
      name: 'ctx_remember',
      arguments: {
        scope: 'project',
        provenance: 'user',
        content: 'Payment project uses asynchronous events by user decision'
      }
    });
    expect(decision.isError).not.toBe(true);
    const saved = await secondClient.callTool({
      name: 'ctx_remember',
      arguments: {
        content: 'Payment branch processes payment succeeded events',
        evidence: [ref],
        expected_generations: { [source.repoId]: source.generation }
      }
    });
    expect(saved.isError).not.toBe(true);
    git('switch', '-c', 'feature/same-content');
    expect(() => staleGraph.captureEvidence(ref, source.generation)).toThrow('checkout changed');
    registry.reconcile();
    const feature = registry.resolve(root);
    expect(feature.repoId).not.toBe(source.repoId);
    await runtime.get(feature).index();
    const result = await secondClient.callTool({
      name: 'get_context',
      arguments: {
        prompt: 'Payment project asynchronous events by user decision',
        tier: 'full',
        max_tokens: 4000
      }
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      'Payment project uses asynchronous events by user decision'
    );
    expect(JSON.stringify(result.content)).not.toContain(
      'Payment branch processes payment succeeded events'
    );
    const factId = JSON.parse((decision as { content: { text: string }[] }).content[0].text).fact
      .id;
    const forgotten = await secondClient.callTool({
      name: 'ctx_forget',
      arguments: { id: factId }
    });
    expect(forgotten.isError).not.toBe(true);
    expect(JSON.stringify(forgotten.content)).toContain('true');
    const cacheArgs = { prompt: 'processPaymentStatus', tier: 'full' };
    const warm = await secondClient.callTool({ name: 'get_context', arguments: cacheArgs });
    expect(warm.isError).not.toBe(true);
    const lock = path.join(feature.gitDir!, 'index.lock');
    fs.writeFileSync(lock, 'checkout in progress');
    try {
      const blocked = await secondClient.callTool({ name: 'get_context', arguments: cacheArgs });
      expect(blocked.isError).toBe(true);
      expect(JSON.stringify(blocked.content)).not.toContain('export function processPaymentStatus');
      const symbol = await secondClient.callTool({
        name: 'ctx_symbol',
        arguments: { symbolName: 'processPaymentStatus' }
      });
      expect(symbol.isError).toBe(true);
    } finally {
      fs.unlinkSync(lock);
    }
  } finally {
    await secondClient.close();
    await secondServer.close();
    staleGraph.close();
  }
});

it('returns partial evidence when a selected source becomes unavailable during session retrieval', async () => {
  const { SessionManager } = await import('../../src/core/session/index.js');
  const backend = registry.resolve('backend');
  vi.spyOn(SessionManager.prototype, 'getSessionContext').mockImplementationOnce(async () => {
    registry.update(backend.repoId, {
      state: 'failed',
      lastError: 'Simulated checkout failure after core retrieval'
    });
    return [];
  });
  const result = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'payment status', group: 'default', tier: 'full', max_tokens: 4000 }
  });
  expect(result.isError).not.toBe(true);
  const detail = result.structuredContent as {
    partial: boolean;
    chunks: { viewId: string }[];
    unavailableSources: { repoId: string }[];
  };
  expect(detail.partial).toBe(true);
  expect(detail.unavailableSources.map((source) => source.repoId)).toContain(backend.repoId);
  expect(detail.chunks.length).toBeGreaterThan(0);
  expect(detail.chunks.every((chunk) => chunk.viewId !== backend.repoId)).toBe(true);
  expect(JSON.stringify(result.content)).not.toContain('export function processPaymentStatus');
});

it('exposes only the current tool names by default', async () => {
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining(['ctx_symbol', 'ctx_topics', 'ctx_remember', 'ctx_link'])
  );
  for (const name of [
    'get_symbol',
    'get_neighbors',
    'ctx_list_topics',
    'ctx_read_topic',
    'save_context',
    'rate_chunk',
    'learn_fact',
    'forget_fact'
  ])
    expect(names).not.toContain(name);
});

it('adds scoped legacy aliases only when configured and preserves verified knowledge rules', async () => {
  await client.close();
  await server.close();
  await runtime.close();
  fs.writeFileSync(
    path.join(registry.home, 'config.json'),
    JSON.stringify({ legacyTools: true, embeddingsEnabled: false })
  );
  runtime = new WorkspaceRuntime(registry);
  server = new McpServer({ name: 'legacy-test', version: '1' });
  registerWorkspaceTools(server, runtime, {
    cwd: path.join(temp, 'backend'),
    workspace: 'default'
  });
  client = new Client({ name: 'test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  expect(names).toEqual(
    expect.arrayContaining([
      'ctx_symbol',
      'ctx_remember',
      'get_symbol',
      'get_neighbors',
      'ctx_list_topics',
      'ctx_read_topic',
      'save_context',
      'rate_chunk',
      'learn_fact',
      'forget_fact'
    ])
  );
  const symbol = await client.callTool({
    name: 'get_symbol',
    arguments: { symbolName: 'displayPaymentStatus', project: 'frontend' }
  });
  expect(symbol.isError).not.toBe(true);
  expect(JSON.stringify(symbol.content)).toContain('export function displayPaymentStatus');
  expect(JSON.stringify(symbol.content)).not.toContain('export function processPaymentStatus');
  const details = symbol.structuredContent as {
    source: { repoId: string; projectId: string; generation: number };
    chunks: { ref: string }[];
  };
  expect(details.source.projectId).toBe(registry.resolve('frontend').projectId);
  const frontend = registry.resolve('frontend');
  const backend = registry.resolve('backend');
  const frontChunks = new ChunksRepo(runtime.get(frontend).db.getInstance());
  const chunk = frontChunks.findBySymbolName('displayPaymentStatus')[0];
  const topic = await client.callTool({
    name: 'ctx_read_topic',
    arguments: { title: chunk.sectionTitle, project: 'frontend' }
  });
  expect(topic.isError).not.toBe(true);
  expect(JSON.stringify(topic.content)).toContain('displayPaymentStatus');
  expect((topic.structuredContent as { source: { projectId: string } }).source.projectId).toBe(
    frontend.projectId
  );
  const neighbors = await client.callTool({
    name: 'get_neighbors',
    arguments: { entity: 'displayPaymentStatus', project: 'frontend' }
  });
  expect((neighbors.structuredContent as { source: { projectId: string } }).source.projectId).toBe(
    frontend.projectId
  );
  const rejected = await client.callTool({
    name: 'learn_fact',
    arguments: { fact: 'Payment status is certain without evidence' }
  });
  expect(rejected.isError).toBe(true);
  expect(JSON.stringify(rejected.content)).toContain('require source evidence');
  const saved = await client.callTool({
    name: 'learn_fact',
    arguments: {
      fact: 'Payment status is displayed in this implementation',
      project: 'frontend',
      evidence: [details.chunks[0].ref],
      expected_generations: { [frontend.repoId]: frontend.generation }
    }
  });
  expect(saved.isError).not.toBe(true);
  const fact = JSON.parse((saved as { content: { text: string }[] }).content[0].text).fact;
  const forgotten = await client.callTool({
    name: 'forget_fact',
    arguments: { id: fact.id, project: 'frontend' }
  });
  expect(forgotten.isError).not.toBe(true);
  expect(JSON.stringify(forgotten.content)).toContain('true');
  const wrongView = await client.callTool({
    name: 'rate_chunk',
    arguments: { chunk_id: details.chunks[0].ref, project: 'backend', adjustment: 1 }
  });
  expect(wrongView.isError).toBe(true);
  const feedback = await client.callTool({
    name: 'rate_chunk',
    arguments: { chunk_id: details.chunks[0].ref, adjustment: 1 }
  });
  expect(feedback.isError).not.toBe(true);
  const count = (source: typeof frontend) =>
    runtime
      .get(source)
      .db.getInstance()
      .prepare('SELECT count(*) AS n FROM feedback_signals')
      .get() as { n: number };
  expect(count(frontend).n).toBe(1);
  expect(count(backend).n).toBe(0);
  const globalRef = entityRef('global', 'chunk', 'global-test-chunk');
  const absent = await client.callTool({
    name: 'rate_chunk',
    arguments: { chunk_id: globalRef, adjustment: 1 }
  });
  expect(absent.isError).toBe(true);
  const globalDb = new DB(path.join(registry.home, 'index.db'));
  try {
    const originalFile = new FilesRepo(runtime.get(frontend).db.getInstance()).getByPath(
      chunk.sourceFile
    )!;
    new FilesRepo(globalDb.getInstance()).upsert({ ...originalFile, layer: 'global' });
    const globalChunks = new ChunksRepo(globalDb.getInstance());
    globalChunks.upsert({ ...chunk, id: 'global-test-chunk', layer: 'global' });
    globalChunks.upsert({ ...chunk, id: 'nonglobal-test-chunk', layer: 'repo' });
    const globalFeedback = await client.callTool({
      name: 'rate_chunk',
      arguments: { chunk_id: globalRef, adjustment: 1 }
    });
    expect(globalFeedback.isError).not.toBe(true);
    expect((globalFeedback.structuredContent as { chunk: string }).chunk).toBe(globalRef);
    const mismatch = await client.callTool({
      name: 'rate_chunk',
      arguments: { chunk_id: globalRef, project: 'frontend', adjustment: 1 }
    });
    expect(mismatch.isError).toBe(true);
    const nonglobal = await client.callTool({
      name: 'rate_chunk',
      arguments: { chunk_id: entityRef('global', 'chunk', 'nonglobal-test-chunk'), adjustment: 1 }
    });
    expect(nonglobal.isError).toBe(true);
    const missing = await client.callTool({
      name: 'rate_chunk',
      arguments: { chunk_id: entityRef('global', 'chunk', 'missing'), adjustment: 1 }
    });
    expect(missing.isError).toBe(true);
    expect(
      (
        globalDb.getInstance().prepare('SELECT count(*) AS n FROM feedback_signals').get() as {
          n: number;
        }
      ).n
    ).toBe(1);
    expect(count(frontend).n).toBe(1);
  } finally {
    globalDb.close();
  }

  const note = await client.callTool({
    name: 'save_context',
    arguments: { note: 'LegacyConnectionSessionMarker' }
  });
  expect(note.isError).not.toBe(true);
  const otherServer = new McpServer({ name: 'legacy-other', version: '1' });
  registerWorkspaceTools(otherServer, runtime, {
    cwd: path.join(temp, 'backend'),
    workspace: 'default'
  });
  const otherClient = new Client({ name: 'test', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  try {
    await otherServer.connect(c);
    await otherClient.connect(d);
    const isolated = await otherClient.callTool({
      name: 'get_context',
      arguments: { prompt: 'LegacyConnectionSessionMarker', tier: 'full' }
    });
    expect(JSON.stringify(isolated.content)).not.toContain('LegacyConnectionSessionMarker');
  } finally {
    await otherClient.close();
    await otherServer.close();
  }
});
