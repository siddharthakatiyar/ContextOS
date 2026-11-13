import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { RepositoryRuntime, WorkspaceRuntime } from '../../src/core/workspace/runtime.js';
import {
  WorkspaceDaemon,
  workspaceStateDirectory,
  workspaceSocketPath
} from '../../src/core/workspace/daemon.js';
import { createUpgradeLock } from '../../src/core/updater/upgrade-lock.js';
import { getPackageVersion } from '../../src/utils/version.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { entityRef } from '../../src/core/workspace/identity.js';

let temp: string;
let registry: WorkspaceRegistry;
let runtime: RepositoryRuntime | undefined;
let root: string;
const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });

beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-runtime-')));
  const home = path.join(temp, 'home');
  fs.mkdirSync(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  root = path.join(temp, 'project');
  fs.mkdirSync(root);
  git('init');
  git('config', 'user.email', 'runtime@example.invalid');
  git('config', 'user.name', 'Runtime Test');
  fs.writeFileSync(path.join(root, 'payment.ts'), 'export const payment = 1;\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  registry = new WorkspaceRegistry();
});

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
  registry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('global runtime', () => {
  it('uses one state directory for all groups', () => {
    expect(workspaceStateDirectory('one')).toBe(workspaceStateDirectory('two'));
    expect(workspaceStateDirectory('one')).toBe(path.join(os.homedir(), '.contextos', 'runtime'));
  });

  it('allows only one shared daemon and leaves its socket intact when a second start fails', async () => {
    const first = new WorkspaceDaemon('default');
    const second = new WorkspaceDaemon('default');
    try {
      await first.start();
      await expect(second.start()).rejects.toThrow(/already running/i);
      await second.stop();
      if (process.platform !== 'win32') expect(fs.existsSync(workspaceSocketPath())).toBe(true);
    } finally {
      await first.stop();
      await second.stop();
    }
  });

  it('shuts down its shared service when no clients remain', async () => {
    vi.stubEnv('CONTEXTOS_DAEMON_IDLE_MS', '30');
    const daemon = new WorkspaceDaemon('default');
    try {
      await daemon.start();
      if (process.platform !== 'win32') {
        await vi.waitFor(() => expect(fs.existsSync(workspaceSocketPath())).toBe(false));
      }
    } finally {
      await daemon.stop();
    }
  });

  it('authenticates upgrade control and drains the shared service', async () => {
    const daemon = new WorkspaceDaemon('default');
    const lock = createUpgradeLock();
    try {
      await daemon.start();
      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = net.createConnection(workspaceSocketPath());
        let buffer = '';
        socket.once('connect', () =>
          socket.write(
            JSON.stringify({
              action: 'prepare-upgrade',
              token: lock.token,
              expectedVersion: getPackageVersion()
            }) + '\n'
          )
        );
        socket.on('data', (chunk) => {
          buffer += chunk.toString();
          if (buffer.includes('\n')) resolve(JSON.parse(buffer));
        });
        socket.once('error', reject);
      });
      expect(response).toMatchObject({ ok: true, version: getPackageVersion() });
      await daemon.stop();
      if (process.platform !== 'win32') expect(fs.existsSync(workspaceSocketPath())).toBe(false);
    } finally {
      await daemon.stop();
      lock.release();
    }
  });

  it('rejects indexing against a checkout after its branch changes', async () => {
    const source = registry.register(root);
    runtime = new RepositoryRuntime(source, registry);
    git('checkout', '-b', 'feature');
    fs.writeFileSync(path.join(root, 'payment.ts'), 'export const payment = 2;\n');
    await expect(runtime.request({ action: 'file', file: 'payment.ts' })).rejects.toThrow(
      /checkout changed/i
    );
    expect(runtime.db.getInstance().prepare('SELECT COUNT(*) AS count FROM chunks').get()).toEqual({
      count: 0
    });
    expect(fs.existsSync(path.join(root, '.contextos', 'index-owner.json'))).toBe(false);
  });

  it('rejects a cached read when a checkout changes after retrieval begins', async () => {
    const source = registry.register(root);
    runtime = new RepositoryRuntime(source, registry);
    await runtime.prepareRead();
    git('checkout', '-b', 'feature');
    expect(() => runtime!.assertReadable()).toThrow(/checkout changed/i);
  });

  it('rejects a stale cached view and a different group even when membership overlaps', async () => {
    const source = registry.register(root);
    registry.ensureWorkspace('other');
    registry.register(root, { workspace: 'other' });
    const workspace = new WorkspaceRuntime(registry, 'default');
    try {
      workspace.get(source);
      expect(() =>
        workspace.get({ ...source, checkoutGeneration: source.checkoutGeneration + 1 })
      ).toThrow(/checkout changed/i);
      expect(() => workspace.select({ group: 'other' }, root)).toThrow(
        /outside this server scope/i
      );
    } finally {
      await workspace.close();
    }
  });

  it('writes indexing state beside the global view database', async () => {
    const source = registry.register(root);
    runtime = new RepositoryRuntime(source, registry);
    await runtime.index();
    expect(fs.existsSync(path.join(path.dirname(source.dbPath), 'status.json'))).toBe(true);
    expect(fs.existsSync(path.join(root, '.contextos'))).toBe(false);
    expect(runtime.status().state).toBe('ready');
  });

  it.each(['visible', '.hidden'])(
    'asks an existing owner to watch later changes beneath a %s ancestor',
    async (ancestor) => {
      const moved = path.join(temp, ancestor, 'project');
      fs.mkdirSync(path.dirname(moved));
      fs.renameSync(root, moved);
      root = moved;
      const source = registry.register(root);
      runtime = new RepositoryRuntime(source, registry);
      await runtime.index();
      const requester = new RepositoryRuntime(source, registry);
      try {
        await requester.watch();
        await new Promise((resolve) => setTimeout(resolve, 300));
        fs.writeFileSync(path.join(root, 'payment.ts'), 'export const delegatedPayment = 2;\n');
        await vi.waitFor(() => {
          expect(
            runtime!.db
              .getInstance()
              .prepare('SELECT COUNT(*) AS n FROM chunks WHERE symbol_name=?')
              .get('delegatedPayment')
          ).toEqual({ n: 1 });
        });
      } finally {
        await requester.close();
      }
    }
  );

  it('does not index while Git holds the worktree index lock', async () => {
    const source = registry.register(root);
    runtime = new RepositoryRuntime(source, registry);
    fs.writeFileSync(path.join(root, '.git', 'index.lock'), '');
    try {
      await expect(runtime.request({ action: 'file', file: 'payment.ts' })).rejects.toThrow(
        /index update is in progress/i
      );
      expect(
        runtime.db.getInstance().prepare('SELECT COUNT(*) AS count FROM chunks').get()
      ).toEqual({ count: 0 });
    } finally {
      fs.unlinkSync(path.join(root, '.git', 'index.lock'));
    }
  });

  it('drains a removed worktree and deletes its stored view and graph links', async () => {
    const linked = path.join(temp, 'linked');
    git('worktree', 'add', '-b', 'feature', linked);
    registry.register(root);
    const source = registry.list('default', true).find((view) => view.rootPath === linked)!;
    const workspace = new WorkspaceRuntime(registry, 'default');
    const graphPath = path.join(os.homedir(), '.contextos', 'graph.db');
    const graph = new Database(graphPath);
    graph.exec(`CREATE TABLE verified_links (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE graph_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT INTO graph_metadata VALUES ('revision', 0);`);
    graph
      .prepare('INSERT INTO verified_links VALUES (?,?,?)')
      .run('link', 'link', JSON.stringify({ evidence: [{ viewId: source.repoId }] }));
    graph.close();
    try {
      await workspace.refreshWatchers();
      expect(fs.existsSync(source.dbPath)).toBe(true);
      git('worktree', 'remove', linked);
      await workspace.refreshWatchers();
      expect(fs.existsSync(path.dirname(source.dbPath))).toBe(false);
      const reopened = new Database(graphPath, { readonly: true });
      try {
        expect(reopened.prepare('SELECT COUNT(*) AS n FROM verified_links').get()).toEqual({
          n: 0
        });
      } finally {
        reopened.close();
      }
    } finally {
      await workspace.close();
    }
  });

  it('refreshes only the selected worktree and follows a branch switch', async () => {
    const linked = path.join(temp, 'linked');
    git('worktree', 'add', '-b', 'other', linked);
    const original = registry.register(root);
    const other = registry.list('default', true).find((view) => view.rootPath === linked)!;
    const workspace = new WorkspaceRuntime(registry);
    try {
      await workspace.refreshSelected({}, root);
      expect(registry.resolve(original.repoId).state).toBe('ready');
      expect(registry.resolve(other.repoId).state).toBe('registered');
      git('checkout', '-b', 'feature');
      fs.writeFileSync(path.join(root, 'payment.ts'), 'export const payment = 2;\n');
      await workspace.refreshSelected({}, root);
      const selected = registry.active(root)!;
      expect(selected.repoId).not.toBe(original.repoId);
      expect(selected.state).toBe('ready');
      expect(registry.resolve(other.repoId).state).toBe('registered');
    } finally {
      await workspace.close();
    }
  });

  it('eagerly removes only graph links invalidated by a watched file update', async () => {
    const stableFile = path.join(root, 'stable.ts');
    const changingFile = path.join(root, 'payment.ts');
    fs.writeFileSync(stableFile, 'export const stable = 1;\n');
    const source = registry.register(root);
    runtime = new RepositoryRuntime(source, registry);
    await runtime.watch();
    const db = runtime.db.getInstance();
    const chunkRef = (file: string) => {
      const chunk = db.prepare('SELECT id FROM chunks WHERE source_file=? LIMIT 1').get(file) as {
        id: string;
      };
      return entityRef(source.repoId, 'chunk', chunk.id);
    };
    const graph = new GraphStore({
      home: registry.home,
      resolve: (id) => ({ source: registry.resolve(id), db })
    });
    const generation = registry.resolve(source.repoId).generation;
    const expectedGenerations = { [source.repoId]: generation };
    const changed = graph.link(
      {
        source: chunkRef(changingFile),
        target: chunkRef(stableFile),
        type: 'imports',
        rationale: 'The files are connected.',
        expectedGenerations
      },
      [source.repoId]
    );
    const retained = graph.link(
      {
        source: chunkRef(stableFile),
        target: chunkRef(stableFile),
        type: 'reads_resource',
        rationale: 'The file is unchanged.',
        expectedGenerations
      },
      [source.repoId]
    );
    graph.close();
    // Wait for chokidar's initial traversal to finish before mutating the file.
    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(changingFile, 'export const payment = 3;\n');
    const readLinkIds = () => {
      const graphDb = new Database(path.join(registry.home, 'graph.db'), { readonly: true });
      try {
        return (graphDb.prepare('SELECT id FROM verified_links').all() as { id: string }[]).map(
          (row) => row.id
        );
      } finally {
        graphDb.close();
      }
    };
    await vi.waitFor(() => expect(readLinkIds()).not.toContain(changed.id), { timeout: 5000 });
    expect(readLinkIds()).toContain(retained.id);
  });

  it('prunes invalid evidence after a full scan while preserving unchanged links', async () => {
    const stableFile = path.join(root, 'stable.ts');
    const changingFile = path.join(root, 'payment.ts');
    fs.writeFileSync(stableFile, 'export const stable = 1;\n');
    const source = registry.register(root);
    runtime = new RepositoryRuntime(source, registry);
    await runtime.index();
    const db = runtime.db.getInstance();
    const chunkRef = (file: string) => {
      const chunk = db.prepare('SELECT id FROM chunks WHERE source_file=? LIMIT 1').get(file) as {
        id: string;
      };
      return entityRef(source.repoId, 'chunk', chunk.id);
    };
    const graph = new GraphStore({
      home: registry.home,
      resolve: (id) => ({ source: registry.resolve(id), db })
    });
    const expectedGenerations = { [source.repoId]: registry.resolve(source.repoId).generation };
    const changed = graph.link(
      {
        source: chunkRef(changingFile),
        target: chunkRef(stableFile),
        type: 'imports',
        rationale: 'Connected.',
        expectedGenerations
      },
      [source.repoId]
    );
    const retained = graph.link(
      {
        source: chunkRef(stableFile),
        target: chunkRef(stableFile),
        type: 'reads_resource',
        rationale: 'Stable.',
        expectedGenerations
      },
      [source.repoId]
    );
    graph.close();
    fs.writeFileSync(changingFile, 'export const payment = 4;\n');
    await runtime.request({ action: 'index', force: true });
    const graphDb = new Database(path.join(registry.home, 'graph.db'), { readonly: true });
    try {
      const ids = (graphDb.prepare('SELECT id FROM verified_links').all() as { id: string }[]).map(
        (row) => row.id
      );
      expect(ids).not.toContain(changed.id);
      expect(ids).toContain(retained.id);
    } finally {
      graphDb.close();
    }
  });
});
