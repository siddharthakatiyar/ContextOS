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
it('exposes on-demand import and contract inspection without discovering or saving links', async () => {
  const backend = registry.resolve('backend');
  const frontend = registry.resolve('frontend');
  fs.writeFileSync(
    path.join(backend.rootPath, 'package.json'),
    JSON.stringify({ name: '@fixture/backend', exports: './payment.ts' })
  );
  fs.writeFileSync(
    path.join(frontend.rootPath, 'package.json'),
    JSON.stringify({ dependencies: { '@fixture/backend': 'file:../backend' } })
  );
  fs.appendFileSync(
    path.join(frontend.rootPath, 'payment.ts'),
    '\nimport { processPaymentStatus } from "@fixture/backend";\nexport function submitCheckout() { return processPaymentStatus("pending"); }\n'
  );
  fs.writeFileSync(
    path.join(backend.rootPath, 'api.yaml'),
    'openapi: 3.1.0\npaths:\n  /checkout:\n    post:\n      operationId: createCheckout\n      responses:\n        "200":\n          description: OK\n'
  );
  await runtime.get(backend).index(true);
  await runtime.get(frontend).index(true);
  const sourceChunk = new ChunksRepo(runtime.get(frontend).db.getInstance()).findBySymbolName(
    'submitCheckout'
  )[0];
  const source = entityRef(frontend.repoId, 'chunk', sourceChunk.id);
  const resolved = await client.callTool({
    name: 'ctx_resolve_import',
    arguments: {
      group: 'default',
      source,
      specifier: '@fixture/backend',
      symbol: 'processPaymentStatus'
    }
  });
  expect(resolved.isError).not.toBe(true);
  expect(resolved.structuredContent).toMatchObject({
    resolved: true,
    saved: false,
    targetProject: 'backend'
  });
  const denied = await client.callTool({
    name: 'ctx_resolve_import',
    arguments: { project: 'frontend', source, specifier: '@fixture/backend' }
  });
  expect(denied.isError).toBe(true);
  const row = runtime
    .get(backend)
    .db.getInstance()
    .prepare('SELECT id FROM chunks WHERE source_file=? LIMIT 1')
    .get(path.join(backend.rootPath, 'api.yaml')) as { id: string };
  const contract = await client.callTool({
    name: 'ctx_contract',
    arguments: {
      project: 'backend',
      ref: entityRef(backend.repoId, 'chunk', row.id),
      operation: 'POST /checkout'
    }
  });
  expect(contract.isError).not.toBe(true);
  expect(contract.structuredContent).toMatchObject({
    format: 'openapi',
    saved: false,
    operations: [{ id: 'createCheckout' }]
  });
  const links = await client.callTool({ name: 'ctx_links', arguments: { group: 'default' } });
  expect(links.structuredContent).toMatchObject({ links: [] });
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
  const traced = await client.callTool({
    name: 'ctx_trace',
    arguments: {
      group: 'default',
      start: source.chunks[0].ref,
      target: target.chunks[0].ref
    }
  });
  expect(traced.isError).not.toBe(true);
  expect(traced.structuredContent).toMatchObject({
    found: true,
    coverage: 'recorded_verified_links_only'
  });
  const denied = await client.callTool({
    name: 'ctx_trace',
    arguments: {
      project: 'backend',
      start: source.chunks[0].ref,
      target: target.chunks[0].ref
    }
  });
  expect(denied.isError).toBe(true);
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

it('bounds complete retrieval payloads, includes fact text and project attribution, and paginates unique links', async () => {
  await client.callTool({
    name: 'ctx_remember',
    arguments: { content: 'Payment marker durable fact', provenance: 'user' }
  });
  const result = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'Payment marker durable fact', tier: 'full', max_tokens: 1500 }
  });
  const { responseTokens } = await import('../../src/mcp/response-budget.js');
  expect(result.isError).not.toBe(true);
  expect(
    responseTokens(result as import('@modelcontextprotocol/sdk/types.js').CallToolResult)
  ).toBeLessThanOrEqual(1500);
  expect((result.structuredContent as { tokens: number })?.tokens).toBe(
    responseTokens(result as import('@modelcontextprotocol/sdk/types.js').CallToolResult)
  );
  const full = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'Payment marker durable fact', tier: 'full', max_tokens: 8000 }
  });
  expect((full.structuredContent as { chunks: unknown[] })?.chunks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        sourceFile: 'memory.fact',
        text: expect.stringContaining('Payment marker durable fact'),
        projectName: 'backend'
      })
    ])
  );
  // Populate the group: empty pages cannot catch evidence/scope payload regressions.
  const backend = registry.resolve('backend');
  const frontend = registry.resolve('frontend');
  fs.writeFileSync(
    path.join(backend.rootPath, 'many.ts'),
    Array.from({ length: 26 }, (_, i) => `export function item${i}() { return ${i}; }`).join('\n')
  );
  await runtime.get(backend).index(true);
  const chunks = new ChunksRepo(runtime.get(backend).db.getInstance());
  const targetChunk = new ChunksRepo(runtime.get(frontend).db.getInstance()).findBySymbolName(
    'displayPaymentStatus'
  )[0];
  const target = entityRef(frontend.repoId, 'chunk', targetChunk.id);
  const refs: string[] = [];
  for (let i = 0; i < 26; i++) {
    const source = entityRef(backend.repoId, 'chunk', chunks.findBySymbolName(`item${i}`)[0].id);
    refs.push(source);
    const saved = await client.callTool({
      name: 'ctx_link',
      arguments: {
        group: 'default',
        source,
        target,
        relationship: 'calls_api',
        rationale:
          i === 0 ? 'Verified fixture relationship. '.repeat(30) : 'Verified fixture relationship.',
        expected_generations: {
          [backend.repoId]: registry.resolve('backend').generation,
          [frontend.repoId]: registry.resolve('frontend').generation
        }
      }
    });
    expect(saved.isError).not.toBe(true);
  }
  const page = await client.callTool({ name: 'ctx_links', arguments: { group: 'default' } });
  expect(page.structuredContent).toMatchObject({
    total: 26,
    offset: 0,
    limit: 20,
    next_offset: 20
  });
  expect(page.structuredContent).not.toHaveProperty('scope');
  const data = page.structuredContent as {
    links: { id: string; rationale: string; evidence: { count: number; refs: string[] } }[];
  };
  expect(data.links).toHaveLength(20);
  expect(page.content).toEqual([]);
  expect(
    responseTokens(page as import('@modelcontextprotocol/sdk/types.js').CallToolResult)
  ).toBeLessThan(6000);
  const longPage = await client.callTool({
    name: 'ctx_links',
    arguments: { group: 'default', refs: [refs[0]] }
  });
  const truncatedLink = (longPage.structuredContent as typeof data).links[0];
  expect(truncatedLink).toMatchObject({
    relationship: 'calls_api',
    truncated: true,
    source: {
      project: 'backend',
      file: 'many.ts',
      ref: expect.stringMatching(/^contextos:/),
      lines: [expect.any(Number), expect.any(Number)]
    },
    target: { project: 'frontend', file: 'payment.ts' },
    evidence: { count: 2 }
  });
  expect(truncatedLink.rationale).toHaveLength(240);
  expect(data.links[0].evidence.refs).toHaveLength(2);
  const second = await client.callTool({
    name: 'ctx_links',
    arguments: { group: 'default', offset: 20 }
  });
  expect(second.structuredContent).toMatchObject({ next_offset: null });
  const remaining = (second.structuredContent as typeof data).links;
  expect(remaining).toHaveLength(6);
  expect(new Set([...data.links, ...remaining].map((link) => link.id)).size).toBe(26);
  const detailed = await client.callTool({
    name: 'ctx_links',
    arguments: { group: 'default', verbose: true, refs: [refs[0]] }
  });
  expect(detailed.structuredContent).toHaveProperty('scope');
  expect(
    (
      detailed.structuredContent as { links: { evidence: unknown[]; rationale: string }[] }
    ).links.find((link) => link.rationale.length > 240)
  ).toMatchObject({
    rationale: 'Verified fixture relationship. '.repeat(30).trim(),
    evidence: [
      expect.objectContaining({ fileHash: expect.any(String), generation: expect.any(Number) }),
      expect.any(Object)
    ]
  });
  const trace = await client.callTool({
    name: 'ctx_trace',
    arguments: { group: 'default', start: target }
  });
  expect(
    responseTokens(trace as import('@modelcontextprotocol/sdk/types.js').CallToolResult)
  ).toBeLessThan(18000);
  expect(trace.structuredContent).toMatchObject({
    nodes: expect.arrayContaining([expect.objectContaining({ ref: target })])
  });
  expect(trace.content).toEqual([]);
  expect((trace.structuredContent as { nodes: unknown[] }).nodes).toHaveLength(27);
  expect((trace.structuredContent as { paths: unknown[] }).paths.length).toBeLessThanOrEqual(20);
  expect(JSON.stringify(trace.structuredContent)).not.toContain('fileHash');
  const detailedTrace = await client.callTool({
    name: 'ctx_trace',
    arguments: { group: 'default', start: refs[0], verbose: true }
  });
  expect(JSON.stringify(detailedTrace.structuredContent)).toContain('fileHash');
  const scope = await client.callTool({ name: 'ctx_scope', arguments: {} });
  expect(scope.structuredContent).toMatchObject({ counts: { projects: 2, views: 2 } });
  expect(scope.structuredContent).not.toHaveProperty('catalog');
  const verbose = await client.callTool({ name: 'ctx_scope', arguments: { verbose: true } });
  expect(verbose.structuredContent).toHaveProperty('catalog');
});

it('returns source line ranges, matched windows and command results alongside provenance', async () => {
  const root = registry.resolve('backend').rootPath;
  fs.writeFileSync(path.join(root, 'lines.txt'), 'first\nneedle here\nthird\nfourth\n');
  const read = await client.callTool({
    name: 'ctx_read_file',
    arguments: { filePath: 'lines.txt', start_line: 2, end_line: 3 }
  });
  expect(read.structuredContent).toMatchObject({
    text: 'needle here\nthird',
    startLine: 2,
    endLine: 3
  });
  expect(JSON.stringify(read.content)).toContain('needle here');
  const expand = await client.callTool({
    name: 'ctx_expand',
    arguments: { paths: ['lines.txt'], terms: ['needle'], linesBefore: 0, linesAfter: 0 }
  });
  expect(JSON.stringify(expand.structuredContent)).toContain('needle here');
  expect(JSON.stringify(expand.content)).toContain('needle here');
  const executed = await client.callTool({
    name: 'ctx_execute',
    arguments: { command: 'cat lines.txt' }
  });
  expect(executed.structuredContent).toMatchObject({
    stdout: 'first\nneedle here\nthird\nfourth\n',
    stderr: '',
    exitCode: 0
  });
  const failed = await client.callTool({
    name: 'ctx_execute',
    arguments: { command: 'cat missing.txt' }
  });
  expect(failed.isError).toBe(true);
  expect(failed.structuredContent).toMatchObject({
    stdout: '',
    exitCode: 1,
    stderr: expect.stringContaining('missing.txt')
  });
  const denied = await client.callTool({
    name: 'ctx_read_file',
    arguments: { filePath: '../secret' }
  });
  expect(denied.isError).toBe(true);
  expect(JSON.stringify(denied.content)).toContain('Access denied');
});

it('accepts selected repo-relative inspection paths and rejects ambiguous paths across views', async () => {
  const source = registry.resolve('backend');
  fs.writeFileSync(path.join(source.rootPath, 'helper.ts'), 'export const helper = 1;\n');
  fs.appendFileSync(
    path.join(source.rootPath, 'payment.ts'),
    '\nimport { helper } from "./helper";\n'
  );
  fs.writeFileSync(
    path.join(source.rootPath, 'api.yaml'),
    'openapi: 3.1.0\npaths:\n  /hello:\n    get:\n      operationId: hello\n      responses: {}\n'
  );
  await runtime.get(source).index(true);
  const resolved = await client.callTool({
    name: 'ctx_resolve_import',
    arguments: { project: 'backend', source: 'payment.ts', specifier: './helper' }
  });
  expect(resolved.isError).not.toBe(true);
  expect(resolved.structuredContent).toMatchObject({ resolved: true });
  const contract = await client.callTool({
    name: 'ctx_contract',
    arguments: { project: 'backend', ref: 'api.yaml' }
  });
  expect(contract.isError).not.toBe(true);
  expect(contract.structuredContent).toMatchObject({ operations: [{ id: 'hello' }] });
  const ambiguous = await client.callTool({
    name: 'ctx_resolve_import',
    arguments: { group: 'default', source: 'payment.ts', specifier: './helper' }
  });
  expect(ambiguous.isError).toBe(true);
  expect(JSON.stringify(ambiguous.content)).toContain('Ambiguous path');
});

it('returns removable session note IDs and accepts aggregated session event refs', async () => {
  const save = async (content: string) => {
    const result = await client.callTool({
      name: 'ctx_remember',
      arguments: { type: 'session_note', content }
    });
    expect(result.isError).not.toBe(true);
    return result.structuredContent as { id: string; ref: string };
  };
  const a = await save('SessionMarkerAlpha');
  const b = await save('SessionMarkerBeta');
  expect(a.id).toBeTruthy();
  expect(a.id).not.toBe(b.id);
  const removed = await client.callTool({ name: 'ctx_forget', arguments: { id: a.id } });
  expect(removed.structuredContent).toMatchObject({ removed: true });
  const missing = await client.callTool({ name: 'ctx_forget', arguments: { id: a.ref } });
  expect(missing.structuredContent).toMatchObject({
    removed: false,
    reason: expect.stringContaining('No matching')
  });
  const sessionId = b.id.split(':')[2];
  const aggregate = b.ref.replace(/session:note:.+$/, `session:events:${sessionId}`);
  const forgotten = await client.callTool({ name: 'ctx_forget', arguments: { id: aggregate } });
  expect(forgotten.structuredContent).toMatchObject({ removed: true });
  const c = await save('SessionMarkerGamma');
  const unqualified = await client.callTool({
    name: 'ctx_forget',
    arguments: { id: `memory:session:events:${c.id.split(':')[2]}` }
  });
  expect(unqualified.structuredContent).toMatchObject({ removed: true });
  const result = await client.callTool({
    name: 'get_context',
    arguments: { prompt: 'SessionMarkerAlpha SessionMarkerBeta SessionMarkerGamma', tier: 'full' }
  });
  expect(JSON.stringify(result)).not.toContain('SessionMarkerAlpha');
  expect(JSON.stringify(result)).not.toContain('SessionMarkerBeta');
  expect(JSON.stringify(result)).not.toContain('SessionMarkerGamma');
});

it('removes obsolete links with compact endpoint metadata without pruning away the requested removal', async () => {
  const backend = registry.resolve('backend'),
    frontend = registry.resolve('frontend');
  const ref = (source: typeof backend, symbol: string) =>
    entityRef(
      source.repoId,
      'chunk',
      new ChunksRepo(runtime.get(source).db.getInstance()).findBySymbolName(symbol)[0].id
    );
  const linked = await client.callTool({
    name: 'ctx_link',
    arguments: {
      group: 'default',
      source: ref(backend, 'processPaymentStatus'),
      target: ref(frontend, 'displayPaymentStatus'),
      relationship: 'implements_contract',
      rationale: 'Fixture payment state transition and display contract.',
      expected_generations: {
        [backend.repoId]: backend.generation,
        [frontend.repoId]: frontend.generation
      }
    }
  });
  const id = (linked.structuredContent as { link: { id: string } }).link.id;
  fs.appendFileSync(path.join(backend.rootPath, 'payment.ts'), '\n// obsolete evidence\n');
  const removed = await client.callTool({
    name: 'ctx_unlink',
    arguments: { group: 'default', id }
  });
  expect(removed.structuredContent).toMatchObject({
    ok: true,
    removed: true,
    id,
    type: 'implements_contract',
    endpoints: [{ name: 'backend' }, { name: 'frontend' }],
    warnings: []
  });
  expect(removed.structuredContent).not.toHaveProperty('scope');
});
