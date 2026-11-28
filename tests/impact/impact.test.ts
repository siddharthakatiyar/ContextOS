import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { GraphStore, type VerifiedLink } from '../../src/core/knowledge/graph-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';
import {
  analyzeImpact,
  diffContracts,
  parseUnifiedDiff,
  readImpactLinks,
  type ImpactScope
} from '../../src/core/impact/index.js';

let fixture: Awaited<ReturnType<typeof createFixtureGroup>>;
let scope: ImpactScope;
let graph: GraphStore;
function ref(view: number, file: string, symbol?: string): string {
  const { source, db } = scope.views[view];
  const rows = db
    .prepare('SELECT id,symbol_name FROM chunks WHERE source_file=? ORDER BY start_line,id')
    .all(path.join(source.rootPath, file)) as { id: string; symbol_name: string | null }[];
  const row = symbol
    ? rows.find((row) => row.symbol_name === symbol)
    : (rows.find((row) => !row.symbol_name) ?? rows[0]);
  if (!row) throw new Error(`Missing fixture chunk: ${file} ${symbol}`);
  return entityRef(source.repoId, 'chunk', row.id);
}
function link(
  source: string,
  target: string,
  type: VerifiedLink['type'] = 'calls_api',
  status: VerifiedLink['status'] = 'verified'
): VerifiedLink {
  return graph.link(
    {
      source,
      target,
      type,
      status,
      rationale: 'Explicit fixture dependency',
      expectedGenerations: Object.fromEntries(
        scope.views.map(({ source }) => [source.repoId, source.generation])
      )
    },
    scope.views.map(({ source }) => source.repoId)
  );
}

beforeAll(async () => {
  fixture = await createFixtureGroup();
  const a = fixture.sources[0];
  fs.writeFileSync(
    path.join(a.rootPath, 'src/local.ts'),
    "import { createOrder as submit } from './client.js';\nexport const invoke = submit;\n"
  );
  fs.writeFileSync(
    path.join(a.rootPath, 'src/other.ts'),
    'export function unrelated() { return 1; }\n'
  );
  fs.writeFileSync(
    path.join(a.rootPath, 'src/provider.ts'),
    'export function alpha() { return 1; }\nexport function beta() { return 2; }\nexport default function fallback() { return 3; }\n'
  );
  fs.writeFileSync(
    path.join(a.rootPath, 'src/named-beta.ts'),
    "import { beta } from './provider.js';\nexport const useBeta = beta;\n"
  );
  fs.writeFileSync(
    path.join(a.rootPath, 'src/mixed-beta.ts'),
    "import { beta } from './provider.js';\nimport fallback from './provider.js';\nexport const useBoth = [beta, fallback];\n"
  );
  fs.writeFileSync(
    path.join(a.rootPath, 'orders.proto'),
    'syntax = "proto3";\nmessage Order { string id = 1; }\nservice Orders {\n  rpc Create (Order) returns (Order);\n}\n'
  );
  await fixture.runtime.get(a).index(true);
  scope = {
    views: fixture.sources.map((source) => ({
      source: fixture.registry.resolve(source.repoId),
      db: fixture.runtime.get(source).db.getInstance()
    })),
    links: []
  };
  graph = new GraphStore({
    home: fixture.registry.home,
    resolve: (id) => scope.views.find((view) => view.source.repoId === id)!
  });
}, 30000);
afterAll(async () => {
  graph?.close();
  await fixture?.cleanup();
});

describe('impact diff and contracts', () => {
  it('parses changed lines without counting context, renames, additions and deletions', () => {
    const result = parseUnifiedDiff(
      'diff --git a/old.ts b/new.ts\nsimilarity index 90%\nrename from old.ts\nrename to new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -2,3 +2,3 @@\n context\n-old\n+new\n tail\ndiff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\ndiff --git a/a.ts b/b.ts\nsimilarity index 100%\nrename from a.ts\nrename to b.ts\n'
    );
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({
      path: 'new.ts',
      oldPath: 'old.ts',
      status: 'renamed',
      ranges: [{ start: 3, end: 3 }],
      oldRanges: [{ start: 3, end: 3 }]
    });
    expect(result[1]).toMatchObject({
      path: 'gone.ts',
      status: 'deleted',
      oldRanges: [{ start: 1, end: 1 }]
    });
    expect(result[2]).toMatchObject({ path: 'b.ts', oldPath: 'a.ts', status: 'renamed' });
    expect(parseUnifiedDiff('--- /dev/null\n+++ b/a.ts\n@@ -0,0 +1 @@\n+new\n')[0].status).toBe(
      'added'
    );
  });
  it('compares operation signatures and protobuf messages while ignoring formatting', () => {
    const before =
      'syntax = "proto3"; message Order { string id = 1; } service Orders { rpc Create (Order) returns (Order); }';
    const after = 'syntax = "proto3"; message Order { int64 id = 1; } service Orders {}';
    expect(diffContracts('orders.proto', before, after)).toEqual(
      expect.arrayContaining([
        { kind: 'operation', name: 'Create /Orders/Create', change: 'removed' },
        { kind: 'message', name: 'Order', change: 'changed' }
      ])
    );
    expect(
      diffContracts(
        'api.json',
        '{"openapi":"3.0.3","paths":{"/x":{"get":{"responses":{}}}}}',
        '{"paths":{"/x":{"get":{"responses":{}}}},"openapi":"3.0.3"}'
      )
    ).toEqual([]);
  });
  it('rejects malformed and oversized inputs', async () => {
    expect(() => parseUnifiedDiff('not a diff')).toThrow();
    expect(() => parseUnifiedDiff('x'.repeat(4 * 1024 * 1024 + 1))).toThrow('4 MiB');
    await expect(
      analyzeImpact({
        files: [{ path: '../outside', viewId: scope.views[0].source.repoId }],
        scope
      })
    ).rejects.toThrow('escapes');
    await expect(analyzeImpact({ files: [], scope, depth: 0 })).rejects.toThrow('integer');
    await expect(analyzeImpact({ diff: '', scope })).rejects.toThrow('Select viewId');
  });
});

describe('indexed impact engine', () => {
  it('finds a named local importer and a cross-repository saved caller', async () => {
    const target = ref(0, 'src/client.ts', 'createOrder');
    const caller = ref(1, 'src/worker.ts', 'submitOrder');
    const saved = link(caller, target);
    const result = await analyzeImpact({
      files: [
        {
          path: 'src/client.ts',
          viewId: scope.views[0].source.repoId,
          ranges: [{ start: 2, end: 9 }]
        }
      ],
      scope: { ...scope, links: [saved] },
      verbose: true
    });
    expect(result.changes[0].changedExports).toContain('createOrder');
    expect(result.impacted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          file: 'src/local.ts',
          relation: 'imports',
          confidence: 'deterministic',
          direction: 'incoming'
        }),
        expect.objectContaining({
          ref: caller,
          confidence: 'saved-link',
          evidenceRefs: expect.arrayContaining([target, caller])
        })
      ])
    );
    expect(result.impacted.every((item) => item.evidence?.length)).toBe(true);
    expect(result.impacted.some((item) => item.file === 'src/other.ts')).toBe(false);
  });
  it('matches an OpenAPI operation removal with a recorded consumer', async () => {
    const api = ref(0, 'openapi.yaml', 'POST /orders (createOrder)');
    const caller = ref(1, 'src/worker.ts', 'submitOrder');
    const saved = link(caller, api, 'implements_contract');
    const diff =
      "diff --git a/openapi.yaml b/openapi.yaml\n--- a/openapi.yaml\n+++ b/openapi.yaml\n@@ -5,7 +5 @@\n-paths:\n-  /orders:\n-    post:\n-      operationId: createOrder\n-      responses:\n-        '201':\n-          description: Order created\n+paths: {}\n";
    const result = await analyzeImpact({
      diff,
      viewId: scope.views[0].source.repoId,
      scope: { ...scope, links: [saved] }
    });
    expect(result.changes[0].contracts).toContainEqual({
      kind: 'operation',
      name: 'POST /orders',
      change: 'removed'
    });
    expect(result.impacted).toContainEqual(
      expect.objectContaining({ ref: caller, relation: 'implements_contract' })
    );
  });
  it('warns about thin coverage, unmatched files and absent graph snapshots', async () => {
    const result = await analyzeImpact({
      files: [{ path: 'missing.ts', viewId: scope.views[2].source.repoId }],
      scope: { views: scope.views }
    });
    expect(result.coverage.unknownRepos).toContain(scope.views[2].source.repoId);
    expect(result.coverage.complete).toBe(false);
    expect(result.summary).toContain('does not establish no impact');
    expect(result.warnings.join(' ')).toContain('No indexed chunks');
    expect(result.warnings.join(' ')).toContain('cross-repository coverage is unknown');
  });
  it('protects cycles, bounds transitive expansion, caps results and stays compact', async () => {
    const a = ref(0, 'src/client.ts', 'createOrder'),
      b = ref(1, 'src/worker.ts', 'submitOrder'),
      c = ref(2, 'src/index.ts', 'ORDER_CREATED');
    const links = [link(b, a), link(c, b, 'imports'), link(a, c, 'imports')];
    const options = {
      files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
      scope: { ...scope, links }
    };
    const full = await analyzeImpact(options);
    expect(full.impacted).toContainEqual(expect.objectContaining({ ref: c, depth: 2 }));
    expect(new Set(full.impacted.map((item) => item.ref)).size).toBe(full.impacted.length);
    expect(full.impacted.every((item) => item.evidence === undefined)).toBe(true);
    const capped = await analyzeImpact({ ...options, maxResults: 1 });
    expect(capped.impacted).toHaveLength(1);
    expect(capped.truncation.resultLimit).toBe(true);
    const shallow = await analyzeImpact({ ...options, depth: 1 });
    expect(shallow.truncation.depthLimit).toBe(true);
    expect(shallow.impacted.some((item) => item.ref === c)).toBe(false);
  });
  it('excludes proposed/stale/expired records by default and flags opted-in status', async () => {
    const a = ref(0, 'src/client.ts', 'createOrder'),
      b = ref(1, 'src/worker.ts', 'submitOrder');
    const saved = link(b, a);
    const options = {
      files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
      scope: { ...scope, links: [{ ...saved, status: 'proposed' as const }] }
    };
    expect((await analyzeImpact(options)).impacted.some((item) => item.ref === b)).toBe(false);
    expect((await analyzeImpact({ ...options, includeProposed: true })).impacted).toContainEqual(
      expect.objectContaining({ ref: b, status: 'proposed' })
    );
    expect(
      (
        await analyzeImpact({
          ...options,
          scope: { ...scope, links: [{ ...saved, status: 'stale' }] }
        })
      ).impacted.some((item) => item.ref === b)
    ).toBe(false);
    expect(
      (
        await analyzeImpact({
          ...options,
          includeProposed: true,
          scope: { ...scope, links: [{ ...saved, expiresAt: 1 }] }
        })
      ).impacted.some((item) => item.ref === b)
    ).toBe(false);
  });
  it('reads graph snapshots without pruning and rejects stale indexed evidence', async () => {
    const saved = link(
      ref(1, 'src/worker.ts', 'submitOrder'),
      ref(0, 'src/client.ts', 'createOrder')
    );
    const links = readImpactLinks(
      fixture.registry.home,
      scope.views.map(({ source }) => source.repoId)
    );
    expect(links.some((item) => item.id === saved.id)).toBe(true);
    const result = await analyzeImpact({
      files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
      scope: {
        ...scope,
        links: [
          {
            ...saved,
            evidence: saved.evidence.map((evidence) => ({ ...evidence, fileHash: 'invalid' }))
          }
        ]
      }
    });
    expect(result.impacted.some((item) => item.linkId === saved.id)).toBe(false);
    expect(result.warnings.join(' ')).toContain('stale or unavailable');
  });
  it('computes git base...head diffs without shell interpolation', async () => {
    const source = scope.views[0].source;
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: source.rootPath, encoding: 'utf8' }).trim();
    const before = git(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(source.rootPath, 'new.ts'), 'export const value = 1;\n');
    git(['add', 'new.ts']);
    const tree = git(['write-tree']);
    const after = execFileSync(
      'git',
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit-tree',
        tree,
        '-p',
        before,
        '-m',
        'impact'
      ],
      { cwd: source.rootPath, encoding: 'utf8' }
    ).trim();
    const result = await analyzeImpact({ base: before, head: after, viewId: source.repoId, scope });
    expect(result.changes).toContainEqual(
      expect.objectContaining({ file: 'new.ts', status: 'added' })
    );
  });
});

it('keeps unrelated indexed operation consumers out of an operation-only change', async () => {
  const api = ref(0, 'openapi.yaml', 'POST /orders (createOrder)');
  const caller = ref(1, 'src/worker.ts', 'submitOrder');
  const saved = link(caller, api, 'calls_api');
  const diff =
    'diff --git a/openapi.yaml b/openapi.yaml\n--- a/openapi.yaml\n+++ b/openapi.yaml\n@@ -11 +11,5 @@\n           description: Order created\n+  /health:\n+    get:\n+      operationId: health\n+      responses: {}\n';
  const result = await analyzeImpact({
    diff,
    viewId: scope.views[0].source.repoId,
    scope: { ...scope, links: [saved] }
  });
  expect(result.changes[0].contracts).toEqual([
    { kind: 'operation', name: 'GET /health', change: 'added' }
  ]);
  expect(result.impacted.some((item) => item.ref === caller)).toBe(false);
});

it('maps renamed/deleted files to their old indexed symbols without reading changed targets', async () => {
  const target = ref(0, 'src/client.ts', 'createOrder');
  const caller = ref(1, 'src/worker.ts', 'submitOrder');
  const saved = link(caller, target);
  const renamed = await analyzeImpact({
    diff: 'diff --git a/src/client.ts b/src/renamed.ts\nsimilarity index 100%\nrename from src/client.ts\nrename to src/renamed.ts\n',
    viewId: scope.views[0].source.repoId,
    scope: { ...scope, links: [saved] }
  });
  expect(renamed.changes[0]).toMatchObject({
    file: 'src/renamed.ts',
    oldFile: 'src/client.ts',
    status: 'renamed'
  });
  expect(renamed.impacted.some((item) => item.ref === caller)).toBe(true);
  const deleted = await analyzeImpact({
    diff: 'diff --git a/src/client.ts b/src/client.ts\ndeleted file mode 100644\n',
    viewId: scope.views[0].source.repoId,
    scope: { ...scope, links: [saved] }
  });
  expect(deleted.changes[0].status).toBe('deleted');
  expect(deleted.impacted.some((item) => item.ref === caller)).toBe(true);
});

it('retains raw coverage counts while excluding stale records and propagates proposed path status', async () => {
  const a = ref(0, 'src/client.ts', 'createOrder'),
    b = ref(1, 'src/worker.ts', 'submitOrder'),
    c = ref(2, 'src/index.ts', 'ORDER_CREATED');
  const first = { ...link(b, a), status: 'proposed' as const };
  const second = link(c, b, 'imports');
  const options = {
    files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
    scope: { ...scope, links: [first, second] }
  };
  const result = await analyzeImpact({ ...options, includeProposed: true });
  expect(result.impacted).toContainEqual(expect.objectContaining({ ref: c, status: 'proposed' }));
  const filtered = await analyzeImpact({
    ...options,
    scope: { ...scope, links: [{ ...first, status: 'stale' }] }
  });
  expect(
    filtered.coverage.repos.find((repo) => repo.viewId === scope.views[1].source.repoId)
  ).toMatchObject({ links: 1, eligibleLinks: 0 });
});

it('parses plain multi-file diffs, octal quoted paths, and rejects incomplete hunks', () => {
  expect(
    parseUnifiedDiff(
      '--- a/first.ts\n+++ b/first.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/second.ts\n+++ b/second.ts\n@@ -1 +1 @@\n-a\n+b\n'
    )
  ).toHaveLength(2);
  expect(
    parseUnifiedDiff('--- "a/caf\\303\\251.ts"\n+++ "b/caf\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n')[0]
      .path
  ).toBe('café.ts');
  expect(
    parseUnifiedDiff(
      'diff --git a/a/one.ts b/a/two.ts\nsimilarity index 100%\nrename from a/one.ts\nrename to a/two.ts\n'
    )[0].path
  ).toBe('a/two.ts');
  expect(() => parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n-x\n+y\n')).toThrow('Incomplete');
});

it('uses file-level labels for file anchors and never follows provider-directed links forward', async () => {
  const anchor = ref(0, 'src/client.ts'),
    caller = ref(1, 'src/worker.ts', 'submitOrder');
  const saved = link(caller, anchor);
  const result = await analyzeImpact({
    files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
    scope: { ...scope, links: [saved] }
  });
  expect(result.impacted).toContainEqual(
    expect.objectContaining({ ref: caller, confidence: 'file-level' })
  );
  const reverse = await analyzeImpact({
    files: [{ path: 'src/worker.ts', viewId: scope.views[1].source.repoId }],
    scope: { ...scope, links: [saved] }
  });
  expect(reverse.impacted.some((item) => item.ref === anchor)).toBe(false);
});

it('analyzes deleted on-disk targets using indexed evidence without pruning saved links', async () => {
  const target = ref(0, 'src/client.ts', 'createOrder'),
    caller = ref(1, 'src/worker.ts', 'submitOrder');
  const saved = link(caller, target);
  const file = path.join(scope.views[0].source.rootPath, 'src/client.ts');
  const content = fs.readFileSync(file, 'utf8');
  const viewIds = scope.views.map(({ source }) => source.repoId);
  const before = readImpactLinks(fixture.registry.home, viewIds);
  try {
    fs.unlinkSync(file);
    const links = readImpactLinks(fixture.registry.home, viewIds);
    const result = await analyzeImpact({
      files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
      scope: { ...scope, links }
    });
    expect(result.impacted.some((item) => item.linkId === saved.id)).toBe(true);
    expect(readImpactLinks(fixture.registry.home, viewIds)).toEqual(before);
  } finally {
    fs.writeFileSync(file, content);
  }
});

it('rejects mismatched view databases and out-of-scope input views', async () => {
  const view = scope.views[0];
  await expect(
    analyzeImpact({
      files: [],
      scope: { views: [{ ...view, source: { ...view.source, viewId: 'wrong' } }] }
    })
  ).rejects.toThrow('identity changed');
  await expect(
    analyzeImpact({ files: [{ path: 'src/client.ts', viewId: 'outside' }], scope })
  ).rejects.toThrow('in-scope');
  await expect(
    analyzeImpact({ base: '--output=outside', head: 'HEAD', viewId: view.source.repoId, scope })
  ).rejects.toThrow('Invalid Git');
  await expect(analyzeImpact({ files: [], maxResults: 501, scope })).rejects.toThrow('integer');
});

it('detects qualified nested protobuf messages and handles literal braces in strings', () => {
  const before =
    'syntax = "proto3"; package p; message Parent { message Child { string id = 1 [default = "}"]; } }';
  const after =
    'syntax = "proto3"; package p; message Parent { message Child { bytes id = 1 [default = "}"]; } }';
  expect(diffContracts('api.proto', before, after)).toEqual(
    expect.arrayContaining([
      { kind: 'message', name: 'p.Parent', change: 'changed' },
      { kind: 'message', name: 'p.Parent.Child', change: 'changed' }
    ])
  );
  expect(diffContracts('api.proto', before, before.replace('string id', 'string   id'))).toEqual(
    []
  );
});

it('marks transitive same-file adjacency as file-level evidence', async () => {
  const provider = ref(0, 'src/client.ts', 'createOrder');
  const direct = ref(1, 'src/worker.ts', 'submitOrder');
  const sibling = ref(1, 'src/worker.ts', 'consumeOrders');
  const downstream = ref(2, 'src/index.ts', 'ORDER_CREATED');
  const links = [link(direct, provider), link(downstream, sibling, 'imports')];
  const result = await analyzeImpact({
    files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
    scope: { ...scope, links }
  });
  expect(result.impacted).toContainEqual(
    expect.objectContaining({ ref: downstream, depth: 2, confidence: 'file-level' })
  );
});

it('narrows named imports without dropping mixed default-import dependencies', async () => {
  const result = await analyzeImpact({
    files: [
      {
        path: 'src/provider.ts',
        ranges: [{ start: 1, end: 1 }],
        viewId: scope.views[0].source.repoId
      }
    ],
    scope
  });
  expect(result.changes[0].changedExports).toEqual(['alpha']);
  expect(result.impacted.some((item) => item.file === 'src/named-beta.ts')).toBe(false);
  expect(result.impacted).toContainEqual(
    expect.objectContaining({
      file: 'src/mixed-beta.ts',
      confidence: 'file-level'
    })
  );
});

it('reconstructs contract insertions after the zero-count old-line anchor', async () => {
  const diff =
    '--- a/openapi.yaml\n+++ b/openapi.yaml\n@@ -11,0 +12,4 @@\n+  /health:\n+    get:\n+      operationId: health\n+      responses: {}\n';
  const result = await analyzeImpact({ diff, viewId: scope.views[0].source.repoId, scope });
  expect(result.changes[0].contracts).toEqual([
    { kind: 'operation', name: 'GET /health', change: 'added' }
  ]);
  // Exercise reconstruction from a post-change checkout as well as from HEAD.
  const file = path.join(scope.views[0].source.rootPath, 'openapi.yaml');
  const before = fs.readFileSync(file, 'utf8');
  const after = before + '  /health:\n    get:\n      operationId: health\n      responses: {}\n';
  const { applyHunks } = await import('../../src/core/impact/diff.js');
  expect(applyHunks(before, parseUnifiedDiff(diff)[0].hunks!)).toBe(after);
  const deletion =
    '--- a/openapi.yaml\n+++ b/openapi.yaml\n@@ -12,4 +11,0 @@\n-  /health:\n-    get:\n-      operationId: health\n-      responses: {}\n';
  expect(applyHunks(after, parseUnifiedDiff(deletion)[0].hunks!)).toBe(before);
});

it('does not report result truncation when only unused trace witness paths are capped', async () => {
  const target = ref(0, 'src/client.ts', 'createOrder');
  const rows = scope.views[0].db
    .prepare('SELECT id FROM chunks WHERE source_file != ?')
    .all(path.join(scope.views[0].source.rootPath, 'src/client.ts')) as { id: string }[];
  expect(rows.length).toBeGreaterThan(20);
  const links = rows.map((row) =>
    link(entityRef(scope.views[0].source.repoId, 'chunk', row.id), target)
  );
  const result = await analyzeImpact({
    files: [{ path: 'src/client.ts', viewId: scope.views[0].source.repoId }],
    scope: { ...scope, links },
    depth: 1
  });
  expect(result.impacted).toEqual(
    expect.arrayContaining(links.map((saved) => expect.objectContaining({ ref: saved.source })))
  );
  expect(result.truncation.resultLimit).toBe(false);
});

it('propagates protobuf message changes to RPC consumers outside the edited lines', async () => {
  const operation = ref(0, 'orders.proto', '/Orders/Create');
  const caller = ref(1, 'src/worker.ts', 'submitOrder');
  const saved = link(caller, operation, 'calls_api');
  const result = await analyzeImpact({
    diff: '--- a/orders.proto\n+++ b/orders.proto\n@@ -2 +2 @@\n-message Order { string id = 1; }\n+message Order { bytes id = 1; }\n',
    viewId: scope.views[0].source.repoId,
    scope: { ...scope, links: [saved] }
  });
  expect(result.changes[0].contracts).toEqual([
    { kind: 'message', name: 'Order', change: 'changed' }
  ]);
  expect(result.impacted).toContainEqual(
    expect.objectContaining({ ref: caller, relation: 'calls_api' })
  );
});
