import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime } from '../../src/core/workspace/runtime.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { KnowledgeInspector } from '../../src/core/knowledge/inspector.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import { learnRetrievedImports } from '../../src/core/knowledge/import-learning.js';
import { qualifyChunk, retrieveWorkspace } from '../../src/core/workspace/retrieval.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';

let temp: string;
let registry: WorkspaceRegistry;
let runtime: WorkspaceRuntime;
let graph: GraphStore;
let inspector: KnowledgeInspector;
const roots: Record<string, string> = {};
const refs: Record<string, string> = {};
const write = (name: string, file: string, content: string) => {
  const target = path.join(roots[name], file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
};
async function index(name: string) {
  const source = registry.resolve(name);
  await runtime.get(source).index(true);
}
function ref(name: string, file: string) {
  const source = registry.resolve(name);
  const row = runtime
    .get(source)
    .db.getInstance()
    .prepare('SELECT id FROM chunks WHERE source_file=? ORDER BY id LIMIT 1')
    .get(path.join(roots[name], file)) as { id: string };
  return entityRef(source.repoId, 'chunk', row.id);
}
beforeEach(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-inspection-')));
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(temp, 'home'));
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  registry = new WorkspaceRegistry();
  runtime = new WorkspaceRuntime(registry);
  for (const name of ['frontend', 'shared', 'worker', 'common', 'contracts']) {
    roots[name] = path.join(temp, name);
    fs.mkdirSync(roots[name]);
    registry.register(roots[name]);
  }
  write(
    'frontend',
    'package.json',
    JSON.stringify({ name: 'frontend', dependencies: { '@fixture/shared': 'file:../shared' } })
  );
  write(
    'shared',
    'package.json',
    JSON.stringify({
      name: '@fixture/shared',
      exports: { '.': './index.ts', './types': { types: './types.ts', default: './index.ts' } }
    })
  );
  write(
    'shared',
    'index.ts',
    'export function processPayment() { return "paid"; }\nconst internal = 1;'
  );
  write('shared', 'types.ts', 'export type PaymentStatus = "paid" | "pending";');
  write(
    'frontend',
    'checkout.ts',
    'import { processPayment } from "@fixture/shared";\nimport type { PaymentStatus } from "@fixture/shared/types";\nexport function checkout() { return processPayment(); }'
  );
  write(
    'worker',
    'go.mod',
    'module fixture/worker\n\ngo 1.22\nreplace (\n  fixture/common => ../common\n)\n'
  );
  write('common', 'go.mod', 'module fixture/common\n\ngo 1.22\n');
  write(
    'common',
    'redis/client.go',
    'package redis\nfunc CheckRateLimit() string { return "allowed" }\n'
  );
  write(
    'worker',
    'main.go',
    'package worker\nimport (\n "fmt"\n "fixture/common/redis"\n)\nfunc ProcessPayment() { fmt.Println(redis.CheckRateLimit()) }\n'
  );
  write(
    'contracts',
    'api.yaml',
    'openapi: 3.1.0\npaths:\n  /checkout:\n    post:\n      operationId: createCheckout\n      responses:\n        "200":\n          description: OK\ncomponents:\n  schemas:\n    PaymentStatus:\n      type: string\n'
  );
  write(
    'contracts',
    'checkout.proto',
    'syntax = "proto3";\npackage payments;\nservice Checkout { rpc Create (Request) returns (Response); }\n'
  );
  for (const name of Object.keys(roots)) await index(name);
  const resolve = (id: string) => {
    const source = registry.resolve(id);
    return { source, db: runtime.get(source).db.getInstance() };
  };
  graph = new GraphStore({ home: registry.home, resolve });
  inspector = new KnowledgeInspector(graph, registry.listAll(), resolve);
  refs.frontend = ref('frontend', 'checkout.ts');
  refs.worker = ref('worker', 'main.go');
});
afterEach(async () => {
  graph?.close();
  await runtime?.close();
  registry?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});
describe('on-demand exact connection inspection', () => {
  it('resolves explicit local Node packages and direct exports with manifest evidence, without saving', async () => {
    const before = graph.revision();
    const result = await inspector.resolveImport({
      source: refs.frontend,
      specifier: '@fixture/shared',
      symbol: 'processPayment'
    });
    expect(result).toMatchObject({
      resolved: true,
      targetProject: 'shared',
      relativePath: 'index.ts',
      moduleImportVerified: true,
      symbolUsageVerified: false,
      saved: false
    });
    expect(result.evidence).toHaveLength(4);
    expect(graph.revision()).toBe(before);
    expect(graph.listLinks()).toEqual([]);
  });
  it('honors exact export subpaths and type conditions', async () => {
    const result = await inspector.resolveImport({
      source: refs.frontend,
      specifier: '@fixture/shared/types',
      symbol: 'PaymentStatus',
      mode: 'types'
    });
    expect(result.relativePath).toBe('types.ts');
    await expect(
      inspector.resolveImport({
        source: refs.frontend,
        specifier: '@fixture/shared/types',
        symbol: 'PaymentStatus',
        mode: 'import'
      })
    ).rejects.toThrow('direct declaration');
  });
  it('honors conditional export key order rather than prioritizing import over an earlier default', async () => {
    write(
      'shared',
      'package.json',
      JSON.stringify({
        name: '@fixture/shared',
        exports: { '.': { default: './types.ts', import: './index.ts' } }
      })
    );
    await index('shared');
    expect(
      await inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
    ).toMatchObject({ relativePath: 'types.ts' });
  });
  it('rejects made-up imports, private exports and symbol-only secondary parser targets', async () => {
    for (const specifier of ['@fixture/missing', 'processPayment'])
      await expect(inspector.resolveImport({ source: refs.frontend, specifier })).rejects.toThrow(
        'exact import specifier'
      );
    await expect(
      inspector.resolveImport({
        source: refs.frontend,
        specifier: '@fixture/shared',
        symbol: 'internal'
      })
    ).rejects.toThrow('direct declaration');
  });
  it.each(['1.0.0', 'workspace:*'])(
    'does not equate a %s dependency with an arbitrary registered clone',
    async (version) => {
      write(
        'frontend',
        'package.json',
        JSON.stringify({ name: 'frontend', dependencies: { '@fixture/shared': version } })
      );
      await index('frontend');
      await expect(
        inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
      ).rejects.toThrow('not guessed');
    }
  );
  it('rejects stale manifest evidence and an escaping package export', async () => {
    write('frontend', 'package.json', '{}');
    await expect(
      inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
    ).rejects.toThrow('changed since indexing');
    write(
      'frontend',
      'package.json',
      JSON.stringify({ dependencies: { '@fixture/shared': 'file:../shared' } })
    );
    await index('frontend');
    write(
      'shared',
      'package.json',
      JSON.stringify({ name: '@fixture/shared', exports: '../frontend/checkout.ts' })
    );
    await index('shared');
    await expect(
      inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
    ).rejects.toThrow('exact entry');
  });
  it.each(['./missing.js', './missing'])(
    'does not manufacture a file for the explicit export %s',
    async (entry) => {
      write('shared', 'package.json', JSON.stringify({ name: '@fixture/shared', exports: entry }));
      write('shared', 'missing.js.ts', 'export const misleading = 1;');
      write('shared', 'missing.ts', 'export const anotherMatch = 1;');
      await index('shared');
      await expect(
        inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
      ).rejects.toThrow('declared module file is missing');
      expect(graph.listLinks()).toEqual([]);
    }
  );
  it.each([
    { import: null, default: './index.ts' },
    { node: './index.ts', import: './types.ts' }
  ])('does not bypass blocked or environment-dependent exports: %j', async (conditions) => {
    write(
      'shared',
      'package.json',
      JSON.stringify({ name: '@fixture/shared', exports: { '.': conditions } })
    );
    await index('shared');
    await expect(
      inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
    ).rejects.toThrow();
    expect(graph.listLinks()).toEqual([]);
  });
  it('resolves an exact relative cross-project import and refuses ambiguous extension mapping', async () => {
    write(
      'frontend',
      'relative.ts',
      'import { processPayment } from "../shared/index";\nexport const checkoutStatus = processPayment();'
    );
    await index('frontend');
    const source = ref('frontend', 'relative.ts');
    expect(
      await inspector.resolveImport({
        source,
        specifier: '../shared/index',
        symbol: 'processPayment'
      })
    ).toMatchObject({ targetProject: 'shared' });
    write('shared', 'index.js', 'export const unrelated = 1;');
    await expect(inspector.resolveImport({ source, specifier: '../shared/index' })).rejects.toThrow(
      'uniquely'
    );
  });
  it('resolves Go block imports and local replacements to an exported definition', async () => {
    expect(
      await inspector.resolveImport({
        source: refs.worker,
        specifier: 'fixture/common/redis',
        symbol: 'CheckRateLimit'
      })
    ).toMatchObject({ targetProject: 'common', relativePath: 'redis/client.go', saved: false });
    await expect(
      inspector.resolveImport({
        source: refs.worker,
        specifier: 'fixture/common/redis',
        symbol: 'private'
      })
    ).rejects.toThrow('exported Go symbol');
  });
  it('does not discard the version condition on a Go replacement', async () => {
    write(
      'worker',
      'go.mod',
      'module fixture/worker\nrequire fixture/common v1.3.0\nreplace fixture/common v1.2.0 => ../common\n'
    );
    await index('worker');
    await expect(
      inspector.resolveImport({
        source: refs.worker,
        specifier: 'fixture/common/redis',
        symbol: 'CheckRateLimit'
      })
    ).rejects.toThrow('Version-specific');
    expect(graph.listLinks()).toEqual([]);
  });
  it('inspects indexed HTTP and gRPC operations and preserves external references', () => {
    const openapi = inspector.contract(ref('contracts', 'api.yaml'), {
      operation: 'POST /checkout',
      includeSchemas: true
    });
    expect(openapi).toMatchObject({
      format: 'openapi',
      saved: false,
      operations: [{ id: 'createCheckout', method: 'POST', path: '/checkout' }],
      schemas: { PaymentStatus: { type: 'string' } }
    });
    expect(
      inspector.contract(ref('contracts', 'checkout.proto'), {
        operation: '/payments.Checkout/Create'
      })
    ).toMatchObject({
      format: 'protobuf',
      operations: [{ request: 'Request', response: 'Response' }]
    });
    expect(() =>
      inspector.contract(ref('contracts', 'api.yaml'), { operation: 'missing' })
    ).toThrow('missing');
    expect(graph.listLinks()).toEqual([]);
  });
  it('never resolves an excluded target view', async () => {
    const resolve = (id: string) => {
      const source = registry.resolve(id);
      return { source, db: runtime.get(source).db.getInstance() };
    };
    const isolated = new KnowledgeInspector(graph, [registry.resolve('frontend')], resolve);
    await expect(
      isolated.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
    ).rejects.toThrow('outside');
    expect(() => isolated.contract(ref('contracts', 'api.yaml'))).toThrow('outside');
  });
  it('refreshes cached import syntax when a source file is edited and reindexed', async () => {
    await inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' });
    write(
      'frontend',
      'checkout.ts',
      'import { processPayment } from "@fixture/other";\nexport const checkout = processPayment();'
    );
    await index('frontend');
    await expect(
      inspector.resolveImport({ source: refs.frontend, specifier: '@fixture/shared' })
    ).rejects.toThrow('exact import specifier');
  });
});

describe('deterministic learning during combined retrieval', () => {
  it('refreshes a ready index whose format fingerprint predates contract indexing', async () => {
    write(
      'contracts',
      'invoice.proto',
      'syntax = "proto3";\npackage billing;\nservice Invoice { rpc GetInvoice (Request) returns (Response); }'
    );
    const source = registry.resolve('contracts');
    registry.update(source.repoId, { configFingerprint: 'legacy-index-format', indexerVersion: 1 });
    const scope = registry.select({}, roots.contracts);
    const result = await retrieveWorkspace(runtime, scope, 'GetInvoice', { layers: ['repo'] });
    expect(result.chunks.some((chunk) => chunk.sourceFile.endsWith('invoice.proto'))).toBe(true);
    expect(registry.resolve('contracts').configFingerprint).not.toBe('legacy-index-format');
  });
  function learn() {
    const source = registry.resolve('frontend');
    const db = runtime.get(source).db.getInstance();
    const repo = new ChunksRepo(db);
    const rows = repo.getByIds(repo.getIdsBySource(path.join(roots.frontend, 'checkout.ts')));
    return learnRetrievedImports(
      graph,
      registry.listAll(),
      (id) => {
        const view = registry.resolve(id);
        return { source: view, db: runtime.get(view).db.getInstance() };
      },
      rows.map((row) => qualifyChunk({ ...row, score: 1 }, source))
    );
  }
  it('saves exact file dependencies with complete evidence, type conditions and deterministic provenance', async () => {
    const result = await learn();
    expect(result.learnedLinks).toHaveLength(2);
    expect(result.linkSuggestions).toEqual([]);
    for (const link of result.learnedLinks) {
      expect(link).toMatchObject({
        type: 'imports',
        provenance: { kind: 'deterministic', resolver: 'literal-local-import-v1' }
      });
      expect(link.evidence).toHaveLength(4);
      expect(link.rationale).toContain('not symbol consumption');
    }
    expect(
      result.learnedLinks.some((link) =>
        link.evidence.some((item) => item.file.endsWith('types.ts'))
      )
    ).toBe(true);
    const revision = graph.revision();
    expect((await learn()).learnedLinks).toEqual([]);
    expect(graph.revision()).toBe(revision);
  });
  it('keeps ambiguous mapping suggestions transient and never equates similar exports', async () => {
    write(
      'frontend',
      'package.json',
      JSON.stringify({ dependencies: { '@fixture/shared': 'workspace:*' } })
    );
    await index('frontend');
    const before = graph.revision();
    const result = await learn();
    expect(result.learnedLinks).toEqual([]);
    expect(result.linkSuggestions).toHaveLength(2);
    expect(result.linkSuggestions[0]).toMatchObject({
      verification: 'needs_agent_verification',
      inspect: { tool: 'ctx_resolve_import' }
    });
    expect(result.linkSuggestions[0]).not.toHaveProperty('target');
    expect(graph.revision()).toBe(before);
    expect(graph.listLinks()).toEqual([]);
  });
  it('leaves an existing agent rationale intact and invalidates changed evidence', async () => {
    const [old] = (await learn()).learnedLinks;
    graph.link(
      {
        source: old.source,
        target: old.target,
        type: old.type,
        rationale: 'Agent inspected this file dependency.',
        evidenceRefs: old.evidence.map((item) => item.ref),
        expectedGenerations: Object.fromEntries(
          old.evidence.map((item) => [item.viewId, item.generation])
        )
      },
      registry.listAll().map((view) => view.repoId)
    );
    const revision = graph.revision();
    await learn();
    expect(graph.revision()).toBe(revision);
    expect(graph.listLinks().find((link) => link.id === old.id)).toMatchObject({
      rationale: 'Agent inspected this file dependency.',
      provenance: { kind: 'agent' }
    });
    write('frontend', 'package.json', '{}');
    expect(graph.listLinks()).toEqual([]);
    expect((await learn()).learnedLinks).toEqual([]);
  });
  it('surfaces learned links and expands exact targets in workspace retrieval while preserving local-only reads', async () => {
    const local = registry.select({}, roots.frontend);
    expect(
      (await retrieveWorkspace(runtime, local, 'checkout', { layers: ['repo'] })).learnedLinks
    ).toEqual([]);
    expect(graph.listLinks()).toEqual([]);
    const scope = registry.select({ allRepos: true }, roots.frontend);
    const result = await retrieveWorkspace(runtime, scope, 'checkout processPayment', {
      layers: ['repo']
    });
    expect(result.learnedLinks?.length).toBeGreaterThan(0);
    expect(result.knowledgeLinks?.some((link) => link.provenance?.kind === 'deterministic')).toBe(
      true
    );
    expect(result.chunks.some((chunk) => chunk.repoName === 'shared')).toBe(true);
  });
  it('resolves ownership for a registered project nested under the importing project', async () => {
    const nested = path.join(roots.frontend, 'nested-shared');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, 'index.ts'), 'export const paymentStatus = "paid";');
    const target = registry.register(nested);
    await runtime.get(target).index(true);
    write(
      'frontend',
      'checkout.ts',
      'import { paymentStatus } from "./nested-shared/index.ts";\nexport const checkout = paymentStatus;'
    );
    await index('frontend');
    const result = await learn();
    expect(result.learnedLinks).toHaveLength(1);
    expect(result.learnedLinks[0].target).toContain(`contextos:${target.repoId}:chunk:`);
  });
});
