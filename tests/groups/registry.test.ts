import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { DB } from '../../src/core/storage/database.js';
import { bindRepository } from '../../src/core/workspace/identity.js';

let temp: string;
let registry: WorkspaceRegistry;
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
function repository(name = 'backend'): string {
  const root = path.join(temp, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.com');
  git(root, 'config', 'user.name', 'Fixture');
  fs.writeFileSync(path.join(root, 'payment.ts'), 'export const paymentStatus = "pending";\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');
  return root;
}
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-groups-'));
  registry = new WorkspaceRegistry(path.join(temp, 'state'));
});
afterEach(() => {
  registry.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('global project/worktree registry', () => {
  it('registers the same and different projects concurrently across processes', async () => {
    const roots = [repository('concurrent-a'), repository('concurrent-b')];
    const module = pathToFileURL(path.resolve('src/core/workspace/registry.ts')).href;
    const state = path.join(temp, 'state');
    const script = `import { WorkspaceRegistry } from ${JSON.stringify(module)};
      const registry = new WorkspaceRegistry(process.argv[1]);
      try { console.log(JSON.stringify(registry.register(process.argv[2]))); }
      finally { registry.close(); }`;
    const child = (root: string) =>
      new Promise<{ projectId: string; repoId: string; dbPath: string }>((resolve, reject) => {
        const processChild = spawn(
          process.execPath,
          ['--import', 'tsx', '--input-type=module', '-e', script, state, root],
          {
            cwd: process.cwd(),
            env: { ...process.env, HOME: temp, CONTEXTOS_EMBEDDINGS: '0' }
          }
        );
        let stdout = '',
          stderr = '';
        processChild.stdout.on('data', (data: Buffer) => {
          stdout += data;
        });
        processChild.stderr.on('data', (data: Buffer) => {
          stderr += data;
        });
        processChild.on('error', reject);
        processChild.on('close', (code) => {
          if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`));
          try {
            resolve(JSON.parse(stdout.trim().split('\n').at(-1)!));
          } catch (error) {
            reject(error);
          }
        });
      });
    const [a1, a2, b1, b2] = await Promise.all([
      child(roots[0]),
      child(roots[0]),
      child(roots[1]),
      child(roots[1])
    ]);
    expect(a1.repoId).toBe(a2.repoId);
    expect(b1.repoId).toBe(b2.repoId);
    expect(a1.projectId).not.toBe(b1.projectId);
    expect(registry.projects()).toHaveLength(2);
    for (const view of [a1, b1]) {
      expect(fs.existsSync(view.dbPath)).toBe(true);
      expect(registry.lease(view.repoId)).toBeUndefined();
      expect(registry.resolve(view.repoId).state).toBe('registered');
    }
  }, 30_000);

  it('discovers linked worktrees, namespaces branches and defaults each group to one project view', () => {
    const root = repository();
    const feature = path.join(temp, 'backend-feature');
    git(root, 'worktree', 'add', '-b', 'feature/refunds', feature);
    registry.ensureGroup('payments');
    const source = registry.register(root, { group: 'payments' });
    expect(registry.projects()).toHaveLength(1);
    expect(registry.worktrees()).toHaveLength(2);
    expect(registry.list('payments')).toHaveLength(1);
    expect(registry.list('payments', true)).toHaveLength(2);
    expect(
      registry
        .listAll()
        .every((v) =>
          v.dbPath.startsWith(path.join(temp, 'state', 'projects', source.projectId, 'views'))
        )
    ).toBe(true);
    expect(fs.existsSync(path.join(root, '.contextos'))).toBe(false);
    expect(fs.existsSync(path.join(feature, '.contextos'))).toBe(false);
    expect(registry.select({ group: 'payments' }, feature).sources[0].branch).toBe(
      'feature/refunds'
    );
    expect(registry.select({ group: 'payments', allWorktrees: true }, root).sources).toHaveLength(
      2
    );
    expect(
      registry.select({ project: ['backend'], branch: 'feature/refunds' }, root).sources[0].rootPath
    ).toBe(feature);
    expect(registry.select({ worktree: feature }, temp).sources[0].projectId).toBe(
      source.projectId
    );
    expect(() => registry.select({ group: 'payments', branch: 'missing' }, root)).toThrow(
      'No live indexed checkout'
    );
  });
  it('reuses branch view identities on switching back and advances checkout generations', () => {
    const root = repository();
    const main = registry.register(root);
    git(root, 'checkout', '-b', 'feature');
    const feature = registry.select({}, root).sources[0];
    expect(feature.repoId).not.toBe(main.repoId);
    expect(feature.worktreeId).toBe(main.worktreeId);
    expect(feature.checkoutGeneration).toBeGreaterThan(main.checkoutGeneration);
    expect(registry.views()).toHaveLength(2);
    expect(registry.listAll()).toHaveLength(1);
    git(root, 'checkout', 'main');
    const again = registry.select({}, root).sources[0];
    expect(again.repoId).toBe(main.repoId);
    expect(again.checkoutGeneration).toBeGreaterThan(feature.checkoutGeneration);
    expect(registry.select({}, root, undefined, feature.repoId).sources[0].repoId).toBe(
      main.repoId
    );
    const before = registry.revision();
    registry.reconcile();
    expect(registry.revision()).toBe(before);
  });
  it('canonicalizes aliases and treats independent clones as distinct projects', () => {
    const root = repository();
    const initial = registry.register(root);
    const alias = path.join(temp, 'alias');
    fs.symlinkSync(root, alias, 'dir');
    expect(registry.register(alias).repoId).toBe(initial.repoId);
    const clone = path.join(temp, 'clone');
    git(temp, 'clone', root, clone);
    const other = registry.register(clone);
    expect(other.projectId).not.toBe(initial.projectId);
    registry.ensureGroup('other');
    registry.register(root, { group: 'other' });
    registry.remove('backend');
    expect(registry.list('other')[0].repoId).toBe(initial.repoId);
    expect(fs.existsSync(initial.dbPath)).toBe(true);
  });
  it('purges confirmed removed worktrees and deleted inactive branches, retaining temporarily missing roots', () => {
    const root = repository();
    const feature = path.join(temp, 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', feature);
    registry.register(root);
    const target = registry.active(feature)!;
    git(root, 'worktree', 'remove', feature);
    const dry = registry.cleanup({ dryRun: true });
    expect(dry.some((a) => a.viewIds.includes(target.repoId))).toBe(true);
    expect(fs.existsSync(target.dbPath)).toBe(true);
    registry.cleanup();
    expect(registry.views().some((v) => v.repoId === target.repoId)).toBe(false);
    expect(fs.existsSync(target.dbPath)).toBe(false);
    const main = registry.active(root)!;
    git(root, 'checkout', '-b', 'obsolete');
    const old = registry.select({}, root).sources[0];
    git(root, 'checkout', 'main');
    registry.reconcile();
    git(root, 'branch', '-D', 'obsolete');
    expect(registry.cleanup().some((a) => a.viewIds.includes(old.repoId))).toBe(true);
    fs.renameSync(root, root + '-offline');
    expect(registry.cleanup()).toHaveLength(0);
    expect(registry.resolve(main.repoId).state).toBe('unavailable');
    expect(fs.existsSync(main.dbPath)).toBe(true);
  });
  it('isolates detached checkouts and removes all project data only on explicit purge', () => {
    const root = repository();
    git(root, 'checkout', '--detach');
    const detached = registry.register(root);
    expect(detached.branch).toBeNull();
    expect(detached.head).toMatch(/^[0-9a-f]{40}$/);
    const action = registry.purgeProject('backend');
    expect(action.viewIds).toContain(detached.repoId);
    expect(registry.projects()).toHaveLength(0);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(detached.dbPath)).toBe(false);
  });
  it('snapshots legacy local data into global storage, preserving original and identity', () => {
    const root = repository();
    const local = path.join(root, '.contextos', 'index.db');
    const db = new DB(local);
    bindRepository(db.getInstance(), 'legacy-id', root);
    db.getInstance()
      .prepare(
        "INSERT INTO knowledge_facts (id,fact,created_at,updated_at,last_accessed) VALUES ('memory','remember payment',1,1,1)"
      )
      .run();
    db.close();
    const source = registry.register(root);
    expect(source.repoId).toBe('legacy-id');
    expect(source.dbPath).not.toBe(local);
    const migrated = new Database(source.dbPath);
    try {
      expect(migrated.prepare('SELECT fact FROM knowledge_facts').get()).toEqual({
        fact: 'remember payment'
      });
    } finally {
      migrated.close();
    }
    expect(fs.existsSync(local)).toBe(true);
  });
});

describe('registry upgrade and cleanup safety', () => {
  it('migrates the previous registry schema, preserving memberships and view IDs across restart', () => {
    const root = repository();
    const home = path.join(temp, 'old-state');
    fs.mkdirSync(home);
    const localPath = path.join(root, '.contextos', 'index.db');
    const local = new DB(localPath);
    bindRepository(local.getInstance(), 'old-view', root);
    local.close();
    const old = new Database(path.join(home, 'registry.db'));
    old.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT UNIQUE,created_at INTEGER);
      CREATE TABLE repositories(id TEXT PRIMARY KEY,name TEXT UNIQUE,root_path TEXT UNIQUE,db_path TEXT UNIQUE,state TEXT,generation INTEGER,last_success INTEGER,last_error TEXT,config_fingerprint TEXT,indexer_version INTEGER,progress TEXT,created_at INTEGER);
      CREATE TABLE memberships(workspace_id TEXT,repo_id TEXT,PRIMARY KEY(workspace_id,repo_id));
      INSERT INTO workspaces VALUES ('payments-group','payments',1);`);
    old
      .prepare('INSERT INTO repositories VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(
        'old-view',
        'backend',
        root,
        localPath,
        'ready',
        3,
        2,
        null,
        'old-fingerprint',
        1,
        null,
        1
      );
    old.prepare('INSERT INTO memberships VALUES (?,?)').run('payments-group', 'old-view');
    old.close();
    const migrated = new WorkspaceRegistry(home);
    const source = migrated.resolve('old-view');
    expect(source.generation).toBe(3);
    expect(migrated.list('payments')[0].repoId).toBe('old-view');
    expect(source.dbPath).toContain(path.join(home, 'projects'));
    expect(fs.existsSync(path.join(home, 'registry.pre-groups.db'))).toBe(true);
    migrated.close();
    const reopened = new WorkspaceRegistry(home);
    try {
      expect(reopened.list('payments')[0].repoId).toBe('old-view');
    } finally {
      reopened.close();
    }
  });
  it('refuses migration and purge while a live owner holds data', () => {
    const root = repository();
    const legacy = path.join(root, '.contextos');
    fs.mkdirSync(legacy);
    const local = new DB(path.join(legacy, 'index.db'));
    local.close();
    fs.writeFileSync(path.join(legacy, 'daemon.pid'), String(process.pid));
    expect(() => registry.register(root)).toThrow('Stop the existing');
    fs.unlinkSync(path.join(legacy, 'daemon.pid'));
    const source = registry.register(root);
    registry.takeLease(source.repoId, {
      pid: process.pid,
      token: 'token',
      endpoint: 'unused',
      protocol: 1
    });
    expect(() => registry.purgeProject(source.projectId)).toThrow('in use');
    expect(fs.existsSync(source.dbPath)).toBe(true);
    registry.releaseLease(source.repoId, 'token');
    expect(() => registry.purgeProject(source.projectId)).not.toThrow();
  });
  it('purges graph knowledge referring to deleted views and advances graph revision', () => {
    const source = registry.register(repository());
    const graph = new Database(path.join(temp, 'state', 'graph.db'));
    graph.exec(
      "CREATE TABLE verified_links(id TEXT PRIMARY KEY,identity TEXT,payload TEXT); CREATE TABLE verified_facts(id TEXT PRIMARY KEY,identity TEXT,payload TEXT); CREATE TABLE graph_metadata(key TEXT PRIMARY KEY,value INTEGER);INSERT INTO graph_metadata VALUES ('revision',0);"
    );
    graph
      .prepare('INSERT INTO verified_links VALUES (?,?,?)')
      .run('link', 'link', JSON.stringify({ evidence: [{ viewId: source.viewId }] }));
    graph
      .prepare('INSERT INTO verified_facts VALUES (?,?,?)')
      .run('fact', 'fact', JSON.stringify({ viewIds: [source.viewId], evidence: [] }));
    registry.purgeProject(source.projectId);
    expect(graph.prepare('SELECT * FROM verified_links').all()).toHaveLength(0);
    expect(graph.prepare('SELECT * FROM verified_facts').all()).toHaveLength(0);
    expect(graph.prepare('SELECT value FROM graph_metadata').get()).toEqual({ value: 1 });
    graph.close();
  });
});

describe('legacy unavailable memberships', () => {
  it('imports one missing path into multiple groups without discarding registrations', () => {
    const home = path.join(temp, 'legacy-home');
    fs.mkdirSync(home);
    const missing = path.join(temp, 'offline');
    fs.writeFileSync(
      path.join(home, 'workspaces.json'),
      JSON.stringify({ payments: { repos: [missing] }, platform: { repos: [missing] } })
    );
    const imported = new WorkspaceRegistry(home);
    try {
      expect(imported.list('payments')).toHaveLength(1);
      expect(imported.list('platform')).toHaveLength(1);
      expect(imported.list('payments')[0].repoId).toBe(imported.list('platform')[0].repoId);
      expect(imported.list('payments')[0].state).toBe('unavailable');
      expect(imported.projects()).toHaveLength(1);
      expect(imported.cleanup()).toHaveLength(0);
      expect(fs.existsSync(path.join(home, 'workspaces.json.backup'))).toBe(true);
    } finally {
      imported.close();
    }
  });
  it('advances generations and metadata on a same-branch commit', () => {
    const root = repository();
    const before = registry.register(root);
    fs.appendFileSync(path.join(root, 'payment.ts'), 'export const paid = true;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'change');
    const after = registry.select({}, root).sources[0];
    expect(after.viewId).toBe(before.viewId);
    expect(after.checkoutGeneration).toBeGreaterThan(before.checkoutGeneration);
    expect(after.head).not.toBe(before.head);
    const db = new Database(after.dbPath);
    try {
      expect(db.prepare("SELECT value FROM repository_metadata WHERE key='head'").get()).toEqual({
        value: after.head
      });
    } finally {
      db.close();
    }
  });
});

describe('restartable cleanup', () => {
  it('finishes a journaled project purge after interruption without resurrecting data', () => {
    const root = repository();
    const feature = path.join(temp, 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', feature);
    const source = registry.register(root);
    registry.ensureGroup('payments');
    registry.register(root, { group: 'payments' });
    const all = registry.views(source.projectId);
    const home = registry.home;
    const remove = fs.rmSync;
    const failure = vi.spyOn(fs, 'rmSync').mockImplementation((target, options) => {
      if (String(target) === path.dirname(source.dbPath))
        throw new Error('simulated filesystem interruption');
      return remove(target, options);
    });
    try {
      expect(() => registry.purgeProject(source.projectId)).toThrow(
        'simulated filesystem interruption'
      );
    } finally {
      failure.mockRestore();
    }
    const raw = new Database(path.join(home, 'registry.db'));
    try {
      expect(raw.prepare('SELECT COUNT(*) AS count FROM pending_deletions').get()).toEqual({
        count: 1
      });
      expect(raw.prepare('SELECT DISTINCT state,active FROM repositories').all()).toEqual([
        { state: 'deleting', active: 0 }
      ]);
      expect(raw.prepare('SELECT COUNT(*) AS count FROM memberships').get()).toEqual({ count: 2 });
    } finally {
      raw.close();
    }
    expect(() =>
      registry.takeLease(source.repoId, {
        pid: process.pid,
        token: 'new',
        endpoint: 'unused',
        protocol: 1
      })
    ).toThrow('cleaned up');
    registry.close();
    registry = new WorkspaceRegistry(home);
    expect(registry.projects()).toHaveLength(0);
    expect(registry.listAll()).toHaveLength(0);
    for (const view of all) expect(fs.existsSync(view.dbPath)).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
    expect(fs.existsSync(feature)).toBe(true);
    const checked = new Database(path.join(home, 'registry.db'));
    try {
      expect(checked.prepare('SELECT * FROM pending_deletions').all()).toHaveLength(0);
    } finally {
      checked.close();
    }
    expect(() =>
      registry.takeLease(source.repoId, {
        pid: process.pid,
        token: 'stale',
        endpoint: 'unused',
        protocol: 1
      })
    ).toThrow('deleted');
  });
  it('preflights every view lease before staging project deletion or changing membership', () => {
    const root = repository();
    const feature = path.join(temp, 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', feature);
    const source = registry.register(root);
    const featureView = registry.active(feature)!;
    registry.takeLease(featureView.repoId, {
      pid: process.pid,
      token: 'busy',
      endpoint: 'unused',
      protocol: 1
    });
    expect(() => registry.purgeProject(source.projectId)).toThrow('in use');
    expect(registry.list()).toHaveLength(1);
    expect(registry.listAll()).toHaveLength(2);
    expect(
      registry.views().every((view) => view.state !== 'deleting' && fs.existsSync(view.dbPath))
    ).toBe(true);
    registry.releaseLease(featureView.repoId, 'busy');
  });
  it('refuses symlinked and foreign storage paths before touching any project data', () => {
    const source = registry.register(repository());
    const directory = path.dirname(source.dbPath);
    const backup = directory + '-backup';
    const external = path.join(temp, 'external');
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, 'precious'), 'keep');
    fs.renameSync(directory, backup);
    fs.symlinkSync(external, directory, 'dir');
    expect(() => registry.purgeProject(source.projectId)).toThrow('symlink');
    expect(fs.readFileSync(path.join(external, 'precious'), 'utf8')).toBe('keep');
    expect(registry.resolve(source.repoId).active).toBe(true);
    fs.unlinkSync(directory);
    fs.renameSync(backup, directory);
    const raw = new Database(path.join(registry.home, 'registry.db'));
    raw
      .prepare('UPDATE repositories SET db_path=? WHERE id=?')
      .run(path.join(external, 'index.db'), source.repoId);
    raw.close();
    expect(() => registry.purgeProject(source.projectId)).toThrow('outside owned');
    expect(fs.readFileSync(path.join(external, 'precious'), 'utf8')).toBe('keep');
  });
  it('preserves stable worktree and view IDs when Git moves a linked checkout', () => {
    const root = repository();
    const initial = path.join(temp, 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', initial);
    registry.register(root);
    const before = registry.active(initial)!;
    const moved = path.join(temp, 'moved-feature');
    git(root, 'worktree', 'move', initial, moved);
    registry.reconcile();
    const after = registry.active(moved)!;
    expect(after.worktreeId).toBe(before.worktreeId);
    expect(after.viewId).toBe(before.viewId);
    expect(after.rootPath).toBe(moved);
    expect(after.checkoutGeneration).toBeGreaterThan(before.checkoutGeneration);
    expect(registry.cleanup({ dryRun: true })).toHaveLength(0);
    expect(registry.worktrees()).toHaveLength(2);
  });
});
