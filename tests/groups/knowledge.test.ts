import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DB } from '../../src/core/storage/database.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { FilesRepo } from '../../src/core/storage/files-repo.js';
import { GraphStore, type GraphSource } from '../../src/core/knowledge/graph-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { hashContent } from '../../src/utils/hash.js';
import type { RepositorySource } from '../../src/core/workspace/registry.js';

let temp: string;
let graph: GraphStore;
let sources: Map<string, GraphSource>;
const dbs: DB[] = [];
const a = entityRef('a', 'chunk', 'same-id');
const b = entityRef('b', 'chunk', 'same-id');
function addSource(id: string) {
  const root = path.join(temp, id);
  fs.mkdirSync(root);
  const file = path.join(root, 'payment.ts');
  const content = `export const paymentStatus = '${id}';`;
  fs.writeFileSync(file, content);
  const db = new DB(path.join(temp, id + '.db'));
  dbs.push(db);
  new FilesRepo(db.getInstance()).upsert({
    path: file,
    hash: hashContent(content),
    layer: 'repo',
    workspaceName: null,
    lastIndexed: Date.now(),
    importance: 1,
    chunkCount: 1
  });
  new ChunksRepo(db.getInstance()).upsert({
    id: 'same-id',
    sourceFile: file,
    layer: 'repo',
    workspaceName: null,
    sectionTitle: 'paymentStatus',
    sectionDepth: 0,
    content,
    summary: null,
    keywords: 'payment status',
    hash: hashContent(content),
    importance: 1,
    tokenCount: 10,
    createdAt: Date.now(),
    updatedAt: Date.now()
  });
  const source = {
    repoId: id,
    name: id,
    rootPath: root,
    dbPath: path.join(temp, id + '.db'),
    state: 'ready',
    generation: 1,
    lastSuccess: Date.now(),
    lastError: null,
    configFingerprint: null
  } as RepositorySource;
  sources.set(id, { source, db: db.getInstance() });
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-knowledge-'));
  sources = new Map();
  addSource('a');
  addSource('b');
  graph = new GraphStore({
    home: temp,
    resolve: (id) => {
      const value = sources.get(id);
      if (!value) throw new Error('Unknown view');
      return value;
    }
  });
});
afterEach(() => {
  graph.close();
  for (const db of dbs.splice(0)) db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
const link = () =>
  graph.link(
    {
      source: a,
      target: b,
      type: 'calls_api',
      rationale: 'Inspected API service configuration and both operation implementations.',
      expectedGenerations: { a: 1, b: 1 }
    },
    ['a', 'b']
  );
describe('verified agent knowledge', () => {
  it('upserts verified relationships, preserves namespace and persists across reopen', () => {
    const first = link();
    expect(link().id).toBe(first.id);
    expect(graph.listLinks({ viewIds: ['a', 'b'] })).toHaveLength(1);
    expect(graph.expand([a], ['a', 'b']).refs).toEqual([b]);
    expect(graph.expand([a], ['a']).refs).toEqual([]);
    expect(() => graph.unlink(first.id, ['a'])).toThrow('outside');
    graph.close();
    graph = new GraphStore({ home: temp, resolve: (id) => sources.get(id)! });
    expect(graph.listLinks()[0].id).toBe(first.id);
  });
  it('rejects stale generations and unindexed edits without persisting candidates', () => {
    expect(() =>
      graph.link(
        {
          source: a,
          target: b,
          type: 'calls_api',
          rationale: 'verified',
          expectedGenerations: { a: 0, b: 1 }
        },
        ['a', 'b']
      )
    ).toThrow('generation');
    fs.appendFileSync(path.join(temp, 'a/payment.ts'), '\n// changed');
    expect(link).toThrow('changed since indexing');
    expect(graph.listLinks()).toEqual([]);
    expect(() =>
      graph.link(
        {
          source: 'same-id',
          target: b,
          type: 'calls_api',
          rationale: 'verified',
          expectedGenerations: { a: 1, b: 1 }
        },
        ['a', 'b']
      )
    ).toThrow('qualified');
  });
  it('removes unsupported links and facts on evidence changes, retaining unrelated generations', () => {
    link();
    graph.remember(
      {
        content: 'Payment uses this API',
        scope: 'view',
        scopeId: 'a',
        viewIds: ['a'],
        provenance: 'code',
        evidenceRefs: [a],
        expectedGenerations: { a: 1 }
      },
      ['a']
    );
    sources.get('a')!.source.generation++;
    expect(graph.listLinks()).toHaveLength(1);
    fs.writeFileSync(path.join(temp, 'a/payment.ts'), 'export const replacement = true;');
    expect(graph.pruneInvalid()).toBe(2);
    expect(graph.searchFacts('Payment API', { viewIds: ['a'] })).toEqual([]);
  });
  it('requires source evidence for code facts and isolates durable user facts by view', () => {
    expect(() =>
      graph.remember(
        {
          content: 'Payment rule',
          scope: 'view',
          scopeId: 'a',
          viewIds: ['a'],
          provenance: 'code'
        },
        ['a']
      )
    ).toThrow('require source evidence');
    const input = {
      content: 'User prefers payment events',
      scope: 'view' as const,
      scopeId: 'a',
      viewIds: ['a'],
      provenance: 'user' as const
    };
    const fact = graph.remember(input, ['a']);
    expect(graph.remember(input, ['a']).id).toBe(fact.id);
    expect(graph.searchFacts('payment', { viewIds: ['a'] })).toHaveLength(1);
    expect(graph.searchFacts('payment', { viewIds: ['b'] })).toHaveLength(0);
    expect(() => graph.forget(fact.id, ['b'])).toThrow('outside');
    expect(graph.invalidateView('a')).toBe(1);
  });
  it('cleans both endpoint edges when a view or supporting file is deleted', () => {
    link();
    expect(graph.invalidateFile('b', path.join(temp, 'b/payment.ts'))).toBe(1);
    link();
    sources.delete('b');
    expect(graph.listLinks()).toEqual([]);
  });
  it('never resolves excluded views or deletes unavailable/inactive view records', () => {
    link();
    const before = graph.revision();
    const resolver = sources.get('b')!;
    sources.delete('b');
    expect(graph.listLinks({ viewIds: ['a'] })).toEqual([]);
    expect(graph.pruneInvalid({ viewIds: ['a'] })).toBe(0);
    expect(graph.revision()).toBe(before);
    expect(graph.listLinks({ viewIds: ['a', 'b'] })).toEqual([]);
    expect(graph.revision()).toBe(before);
    sources.set('b', resolver);
    resolver.source.active = false;
    expect(graph.listLinks({ viewIds: ['a', 'b'] })).toEqual([]);
    expect(graph.revision()).toBe(before);
    resolver.source.active = true;
    expect(graph.listLinks({ viewIds: ['a', 'b'] })).toHaveLength(1);
  });
  it('rejects evidence symlinks escaping the registered root', () => {
    fs.unlinkSync(path.join(temp, 'a/payment.ts'));
    fs.symlinkSync(path.join(temp, 'b/payment.ts'), path.join(temp, 'a/payment.ts'));
    expect(link).toThrow('escapes');
    expect(graph.listLinks()).toEqual([]);
  });
});

describe('agent knowledge MCP contract', () => {
  it('exposes discovery, saves verified knowledge and rejects ungrounded facts', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { registerWorkspaceKnowledgeTools } = await import('../../src/mcp/tools/knowledge.js');
    const server = new McpServer({ name: 'knowledge-test', version: '1' });
    const client = new Client({ name: 'test', version: '1' });
    registerWorkspaceKnowledgeTools(server, {
      select: (selectors) => {
        const ids = selectors?.repo ?? ['a', 'b'];
        return {
          repoIds: ids,
          activeRepoId: 'a',
          sources: ids.map((id) => sources.get(id)!.source)
        };
      },
      graph: () => new GraphStore({ home: temp, resolve: (id) => sources.get(id)! }),
      clearCache: () => {},
      saveSession: () => {},
      catalog: () => ({ projects: ['a', 'b'] })
    });
    const [aTransport, bTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(aTransport);
      await client.connect(bTransport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(
        expect.arrayContaining([
          'ctx_scope',
          'ctx_link',
          'ctx_links',
          'ctx_unlink',
          'ctx_remember',
          'ctx_forget'
        ])
      );
      const scope = await client.callTool({ name: 'ctx_scope', arguments: {} });
      expect(JSON.stringify(scope.content)).toContain('generation');
      expect(JSON.stringify(scope.content)).toContain('catalog');
      const ungrounded = await client.callTool({
        name: 'ctx_remember',
        arguments: { content: 'Payment status is shared', type: 'cross_session_fact' }
      });
      expect(ungrounded.isError).toBe(true);
      const saved = await client.callTool({
        name: 'ctx_link',
        arguments: {
          source: a,
          target: b,
          relationship: 'calls_api',
          rationale: 'Verified the service routing and both endpoints',
          expected_generations: { a: 1, b: 1 }
        }
      });
      expect(saved.isError).not.toBe(true);
      expect(graph.listLinks()).toHaveLength(1);
      const restricted = await client.callTool({ name: 'ctx_links', arguments: { repo: 'a' } });
      expect(JSON.stringify(restricted.content)).not.toContain('Verified the service routing');
      const remembered = await client.callTool({
        name: 'ctx_remember',
        arguments: {
          content: 'Payment status is declared here',
          evidence: [a],
          expected_generations: { a: 1 }
        }
      });
      expect(remembered.isError).not.toBe(true);
      expect(graph.searchFacts('Payment status', { viewIds: ['a'] })).toHaveLength(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

it('requires a completed current index before accepting evidence writes', () => {
  for (const state of ['registered', 'registering', 'indexing', 'failed']) {
    sources.get('a')!.source.state = state;
    expect(() => graph.captureEvidence(a, 1)).toThrow('not ready');
  }
  sources.get('a')!.source.state = 'ready';
  sources
    .get('a')!
    .db.prepare("INSERT INTO repository_metadata VALUES ('needs_reindex','1')")
    .run();
  expect(() => graph.captureEvidence(a, 1)).toThrow('requires reindexing');
  sources.get('a')!.db.prepare("DELETE FROM repository_metadata WHERE key='needs_reindex'").run();
  expect(graph.captureEvidence(a, 1).ref).toBe(a);
});

it('keeps broader user decisions across view changes and authorizes removal by stable scope', () => {
  sources.get('a')!.source.projectId = 'project-a';
  sources.get('b')!.source.projectId = 'project-a';
  const projectFact = graph.remember(
    {
      content: 'Use payment events for integrations',
      scope: 'project',
      scopeId: 'project-a',
      viewIds: ['a'],
      provenance: 'user'
    },
    ['a']
  );
  const groupFact = graph.remember(
    {
      content: 'Payment group owns checkout',
      scope: 'group',
      scopeId: 'payments',
      viewIds: ['a'],
      provenance: 'user'
    },
    ['a'],
    { groupId: 'payments' }
  );
  const codeFact = graph.remember(
    {
      content: 'Payment constant is declared here',
      scope: 'view',
      scopeId: 'a',
      viewIds: ['a'],
      provenance: 'code',
      evidenceRefs: [a],
      expectedGenerations: { a: 1 }
    },
    ['a']
  );
  const viewUser = graph.remember(
    {
      content: 'Payment experimental preference',
      scope: 'view',
      scopeId: 'a',
      viewIds: ['a'],
      provenance: 'user'
    },
    ['a']
  );
  const facts = graph.searchFacts('Payment', {
    viewIds: ['b'],
    projectIds: ['project-a'],
    groupId: 'payments'
  });
  expect(facts.map((fact) => fact.id)).toEqual(
    expect.arrayContaining([projectFact.id, groupFact.id])
  );
  expect(facts.map((fact) => fact.id)).not.toContain(codeFact.id);
  expect(facts.map((fact) => fact.id)).not.toContain(viewUser.id);
  expect(() =>
    graph.remember(
      {
        content: 'bad group injection',
        scope: 'group',
        scopeId: 'outside',
        viewIds: ['b'],
        provenance: 'user'
      },
      ['b'],
      { groupId: 'payments' }
    )
  ).toThrow('outside');
  expect(() => graph.forget(groupFact.id, ['b'], { groupId: 'outside' })).toThrow('outside');
  expect(graph.forget(projectFact.id, ['b'], { projectIds: ['project-a'] })).toBe(true);
  expect(graph.invalidateView('a')).toBe(2);
  expect(
    graph.searchFacts('Payment', { viewIds: ['b'], groupId: 'payments' }).map((fact) => fact.id)
  ).toEqual([groupFact.id]);
  expect(graph.invalidateGroup('payments')).toBe(1);
});

it('prunes evidence affected by one view without resolving unrelated endpoints', () => {
  link();
  let otherResolved = false;
  graph.close();
  graph = new GraphStore({
    home: temp,
    resolve: (viewId) => {
      if (viewId === 'b') {
        otherResolved = true;
        throw new Error('not accessible in this indexing process');
      }
      return sources.get(viewId)!;
    }
  });
  fs.appendFileSync(path.join(temp, 'a/payment.ts'), '\n// changed');
  expect(graph.pruneInvalid({ affectedViewIds: ['a'] })).toBe(1);
  expect(otherResolved).toBe(false);
});
