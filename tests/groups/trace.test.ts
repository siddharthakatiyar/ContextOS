import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime } from '../../src/core/workspace/runtime.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { GraphStore, type LinkType } from '../../src/core/knowledge/graph-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';

let temp: string;
let registry: WorkspaceRegistry;
let runtime: WorkspaceRuntime;
let graph: GraphStore;
const refs: Record<string, string> = {};
const names = ['frontend', 'backend', 'payments', 'worker', 'unrelated'];
function connect(source: string, target: string, type: LinkType) {
  return graph.link(
    {
      source: refs[source],
      target: refs[target],
      type,
      rationale: 'Fixture explicitly establishes this connection.',
      expectedGenerations: Object.fromEntries(
        registry.listAll().map((view) => [view.repoId, view.generation])
      )
    },
    registry.listAll().map((view) => view.repoId)
  );
}
const scope = () => registry.listAll().map((view) => view.repoId);
beforeEach(async () => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-trace-')));
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(temp, 'home'));
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  registry = new WorkspaceRegistry();
  runtime = new WorkspaceRuntime(registry);
  for (const name of names) {
    const root = path.join(temp, name);
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, 'checkout.ts'),
      `export function ${name}Checkout() { return 'checkout.created'; }\n`
    );
    const source = registry.register(root);
    const owner = runtime.get(source);
    await owner.index();
    const chunk = new ChunksRepo(owner.db.getInstance()).findBySymbolName(`${name}Checkout`)[0];
    refs[name] = entityRef(source.repoId, 'chunk', chunk.id);
  }
  graph = new GraphStore({
    home: registry.home,
    resolve: (id) => {
      const source = registry.resolve(id);
      return { source, db: runtime.get(source).db.getInstance() };
    }
  });
  connect('frontend', 'backend', 'calls_api');
  connect('backend', 'payments', 'publishes_event');
  connect('worker', 'payments', 'consumes_event');
});
afterEach(async () => {
  graph?.close();
  await runtime?.close();
  registry?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('verified cross-project tracing', () => {
  it('returns an ordered four-project path with direction, evidence and citations for every hop', () => {
    const trace = graph.trace({ start: refs.frontend, target: refs.worker }, scope());
    expect(trace.found).toBe(true);
    expect(trace.partial).toBe(false);
    expect(trace.paths[0].refs).toEqual(
      ['frontend', 'backend', 'payments', 'worker'].map((name) => refs[name])
    );
    expect(trace.paths[0].steps.map((step) => step.traversal)).toEqual([
      'forward',
      'forward',
      'reverse'
    ]);
    expect(
      trace.paths[0].steps.map((step) => trace.links.find((link) => link.id === step.linkId)!.type)
    ).toEqual(['calls_api', 'publishes_event', 'consumes_event']);
    expect(trace.nodes.map((node) => node.project).sort()).toEqual([
      'backend',
      'frontend',
      'payments',
      'worker'
    ]);
    for (const node of trace.nodes) {
      expect(node.relativePath).toBe('checkout.ts');
      expect(node.startLine).toBe(1);
      expect(node.evidence.fileHash).toBeTruthy();
      expect(node.evidence.ref).toBe(node.ref);
    }
    expect(trace.links.every((link) => link.evidence.length >= 2)).toBe(true);
  });
  it('honors stored edge direction and relationship filters', () => {
    const outgoing = graph.trace(
      { start: refs.frontend, target: refs.worker, direction: 'outgoing' },
      scope()
    );
    expect(outgoing.found).toBe(false);
    expect(outgoing.nodes.some((node) => node.ref === refs.worker)).toBe(false);
    expect(
      graph.trace({ start: refs.backend, target: refs.frontend, direction: 'incoming' }, scope())
        .found
    ).toBe(true);
    const filtered = graph.trace({ start: refs.frontend, relationships: ['calls_api'] }, scope());
    expect(filtered.links.map((link) => link.type)).toEqual(['calls_api']);
    expect(filtered.nodes).toHaveLength(2);
  });
  it('reports an unconnected target without inventing a path', () => {
    const trace = graph.trace({ start: refs.frontend, target: refs.unrelated }, scope());
    expect(trace.found).toBe(false);
    expect(trace.partial).toBe(false);
    expect(trace.paths).toEqual([]);
    expect(trace.coverage).toBe('recorded_verified_links_only');
  });
  it('never reads or discloses excluded projects', () => {
    const selected = registry
      .listAll()
      .filter((view) => view.name !== 'worker')
      .map((view) => view.repoId);
    const trace = graph.trace({ start: refs.frontend }, selected);
    expect(JSON.stringify(trace)).not.toContain(refs.worker);
    expect(trace.nodes).toHaveLength(3);
    expect(() => graph.trace({ start: refs.frontend, target: refs.worker }, selected)).toThrow(
      'outside'
    );
  });
  it.each([
    [{ maxDepth: 1 }, 'depth_limit'],
    [{ maxNodes: 1 }, 'node_limit'],
    [{ maxEdges: 1 }, 'edge_limit']
  ] as const)(
    'reports traversal limits instead of claiming complete coverage: %j',
    (limits, reason) => {
      const trace = graph.trace({ start: refs.frontend, target: refs.worker, ...limits }, scope());
      expect(trace.found).toBe(false);
      expect(trace.partial).toBe(true);
      expect(trace.truncated).toBe(true);
      expect(trace.stops.some((stop) => stop.reason === reason)).toBe(true);
    }
  );
  it('terminates cycles and returns bounded deterministic witness paths', () => {
    connect('worker', 'frontend', 'calls_api');
    const options = { start: refs.frontend, maxPaths: 1 };
    const first = graph.trace(options, scope());
    expect(first.nodes).toHaveLength(4);
    expect(first.paths).toHaveLength(1);
    expect(first.stops.some((stop) => stop.reason === 'path_limit')).toBe(true);
    expect(graph.trace(options, scope())).toEqual(first);
  });
  it('marks changed evidence as a gap and removes the obsolete connection', () => {
    fs.appendFileSync(path.join(temp, 'backend', 'checkout.ts'), '\n// changed\n');
    const trace = graph.trace({ start: refs.frontend, target: refs.worker }, scope());
    expect(trace.found).toBe(false);
    expect(trace.links).toEqual([]);
    expect(trace.stops).toContainEqual({ ref: refs.frontend, reason: 'stale_evidence' });
    expect(trace.partial).toBe(true);
  });
  it('reports temporarily unavailable evidence without deleting established links', () => {
    const worker = registry.resolve('worker');
    registry.update(worker.repoId, { state: 'unavailable' });
    const revision = graph.revision();
    const trace = graph.trace({ start: refs.frontend }, scope());
    expect(trace.stops.some((stop) => stop.reason === 'unavailable_evidence')).toBe(true);
    expect(trace.partial).toBe(true);
    expect(graph.revision()).toBe(revision);
    registry.update(worker.repoId, { state: 'ready' });
    expect(graph.trace({ start: refs.frontend, target: refs.worker }, scope()).found).toBe(true);
  });
  it('rejects bare references, stale starting evidence and invalid traversal bounds', () => {
    expect(() => graph.trace({ start: 'checkout' }, scope())).toThrow('qualified');
    expect(() => graph.trace({ start: refs.frontend, maxNodes: 0 }, scope())).toThrow('limits');
    fs.appendFileSync(path.join(temp, 'frontend', 'checkout.ts'), '\n// changed\n');
    expect(() => graph.trace({ start: refs.frontend }, scope())).toThrow('changed since indexing');
  });
});
