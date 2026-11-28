import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { DB } from '../../src/core/storage/database.js';
import { SCHEMA_SQL } from '../../src/core/storage/schema.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceDaemon } from '../../src/core/workspace/daemon.js';
import { verifyBackup } from '../../src/core/backup/index.js';

let fixture: Awaited<ReturnType<typeof createFixtureGroup>>;
beforeEach(async () => {
  fixture = await createFixtureGroup();
});
afterEach(async () => {
  await fixture.cleanup();
  vi.restoreAllMocks();
});
function snapshots(file: string) {
  const dir = path.join(path.dirname(file), 'pre-migration-backups');
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => n.startsWith(path.basename(file) + '-'))
        .map((n) => path.join(dir, n))
    : [];
}
// Restore the physical SQLite snapshot to a separate path and query it without upgrading it.
function restored(file: string, sql: string) {
  const target = path.join(fixture.root, 'restored.db');
  fs.copyFileSync(file, target);
  const db = new Database(target);
  try {
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    return db.prepare(sql).all();
  } finally {
    db.close();
    fs.rmSync(target);
  }
}
function oldIndex(file: string, version = true) {
  const db = new Database(file);
  db.exec(SCHEMA_SQL);
  db.exec(
    "ALTER TABLE knowledge_facts ADD COLUMN repo_id TEXT; INSERT INTO knowledge_facts(id,fact,category,created_at,updated_at,last_accessed) VALUES ('old','Surviving memory','general',1,2,3)"
  );
  if (version) db.exec('INSERT INTO schema_version VALUES (7)');
  else db.exec('DROP TABLE schema_version');
  db.close();
}
it.each([true, false])('snapshots a v7/legacy index before upgrading (versioned=%s)', (version) => {
  const file = path.join(fixture.root, 'index.db');
  oldIndex(file, version);
  const db = new DB(file);
  expect(db.getInstance().prepare('SELECT version FROM schema_version').get()).toEqual({
    version: 8
  });
  db.close();
  const [backup] = snapshots(file);
  expect(backup).toBeTruthy();
  expect(restored(backup, 'SELECT fact FROM knowledge_facts')).toEqual([
    { fact: 'Surviving memory' }
  ]);
  const again = new DB(file);
  again.close();
  expect(snapshots(file)).toEqual([backup]);
});
it('snapshots an unversioned graph before adding knowledge columns', () => {
  const home = path.join(fixture.root, 'old-graph');
  fs.mkdirSync(home);
  const file = path.join(home, 'graph.db');
  const old = new Database(file);
  old.exec(
    "CREATE TABLE verified_links(id TEXT PRIMARY KEY, identity TEXT UNIQUE, payload TEXT); CREATE TABLE verified_facts(id TEXT PRIMARY KEY, identity TEXT UNIQUE, payload TEXT); CREATE TABLE graph_metadata(key TEXT PRIMARY KEY,value INTEGER); INSERT INTO graph_metadata VALUES ('revision',9); INSERT INTO verified_facts VALUES ('old','old','{}')"
  );
  old.close();
  const open = () =>
    new GraphStore({
      home,
      resolve: () => {
        throw new Error('unused');
      }
    });
  const graph = open();
  expect(graph.revision()).toBe(9);
  graph.close();
  const [backup] = snapshots(file);
  expect(restored(backup, 'SELECT id,payload FROM verified_facts')).toEqual([
    { id: 'old', payload: '{}' }
  ]);
  expect(
    restored(backup, 'PRAGMA table_info(verified_facts)').map((r) => (r as { name: string }).name)
  ).not.toContain('status');
  open().close();
  expect(snapshots(file)).toEqual([backup]);
});
function legacyRegistry(home: string, resumed: boolean) {
  fs.mkdirSync(home, { recursive: true });
  const db = new Database(path.join(home, 'registry.db'));
  const source = fixture.sources.find((s) => s.name === 'service-a')!;
  const index = new Database(source.dbPath);
  index.exec(
    "INSERT INTO knowledge_facts(id,fact,category,created_at,updated_at,last_accessed) VALUES ('upgrade-memory','LiveUpgradeMemorySurvives','general',1,2,3)"
  );
  index.close();
  db.exec(`CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT UNIQUE,created_at INTEGER);
    CREATE TABLE repositories(id TEXT PRIMARY KEY,name TEXT UNIQUE,root_path TEXT UNIQUE,db_path TEXT UNIQUE,state TEXT,generation INTEGER,last_success INTEGER,last_error TEXT,config_fingerprint TEXT,indexer_version INTEGER,progress TEXT,created_at INTEGER);
    CREATE TABLE memberships(workspace_id TEXT,repo_id TEXT,PRIMARY KEY(workspace_id,repo_id));
    INSERT INTO workspaces VALUES ('old-group','old-group',1);`);
  db.prepare('INSERT INTO repositories VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
    'old-view',
    'service-a',
    source.rootPath,
    source.dbPath,
    'ready',
    3,
    2,
    null,
    'old',
    1,
    null,
    1
  );
  db.exec("INSERT INTO memberships VALUES ('old-group','old-view')");
  if (resumed)
    db.exec(
      'ALTER TABLE repositories RENAME TO legacy_repositories; ALTER TABLE memberships RENAME TO legacy_memberships'
    );
  db.close();
}
it.each([false, true])(
  'preserves legacy registry membership/view identity through live CLI upgrade (resumed=%s)',
  (resumed) => {
    const home = path.join(fixture.root, 'upgrade-home', '.contextos');
    legacyRegistry(home, resumed);
    // New CLI opens an actual old registry, as in the release package harness.
    const output = execFileSync(
      process.execPath,
      ['--import', 'tsx', 'bin/contextos.ts', 'group', 'show', 'old-group', '--json'],
      {
        env: { ...process.env, HOME: path.dirname(home) },
        encoding: 'utf8'
      }
    );
    expect(JSON.parse(output).views[0].repoId).toBe('old-view');
    expect(snapshots(path.join(home, 'registry.db'))).toHaveLength(1);
    const registry = new WorkspaceRegistry(home);
    const source = registry.list('old-group')[0];
    expect(source.repoId).toBe('old-view');
    const index = new DB(source.dbPath);
    expect(
      index
        .getInstance()
        .prepare("SELECT fact FROM knowledge_facts WHERE id='upgrade-memory'")
        .get()
    ).toEqual({ fact: 'LiveUpgradeMemorySurvives' });
    index.close();
    registry.close();
    const file = path.join(home, 'registry.db');
    const [backup] = snapshots(file);
    expect(snapshots(file)).toHaveLength(1);
    expect(
      restored(backup, `SELECT name FROM ${resumed ? 'legacy_repositories' : 'repositories'}`)
    ).toEqual([{ name: 'service-a' }]);
    const again = new WorkspaceRegistry(home);
    again.close();
    expect(snapshots(file)).toEqual([backup]);
  },
  30000
);
it('skips fresh and already-current databases', () => {
  const home = path.join(fixture.root, 'fresh');
  const registry = new WorkspaceRegistry(home);
  registry.close();
  const graph = new GraphStore({
    home,
    resolve: () => {
      throw new Error('unused');
    }
  });
  graph.close();
  const file = path.join(home, 'index.db');
  new DB(file).close();
  new DB(file).close();
  new WorkspaceRegistry(home).close();
  new GraphStore({
    home,
    resolve: () => {
      throw new Error('unused');
    }
  }).close();
  expect(fs.existsSync(path.join(home, 'pre-migration-backups'))).toBe(false);
});
it('warns and continues a real index migration when the backup destination fails', () => {
  const file = path.join(fixture.root, 'index.db');
  oldIndex(file);
  fs.writeFileSync(path.join(fixture.root, 'pre-migration-backups'), 'blocked');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const db = new DB(file);
  expect(db.getInstance().prepare('SELECT version FROM schema_version').get()).toEqual({
    version: 8
  });
  db.close();
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('Pre-migration backup failed'));
});
it('runs contextos backup online with an actual running workspace daemon', async () => {
  const daemon = new WorkspaceDaemon('foundation-130');
  await daemon.start();
  try {
    const pidFile = path.join(fixture.registry.home, 'runtime', 'daemon.pid');
    const pid = fs.readFileSync(pidFile, 'utf8');
    expect(Number(pid)).toBe(process.pid);
    const result = JSON.parse(
      execFileSync(process.execPath, ['--import', 'tsx', 'bin/contextos.ts', 'backup', '--json'], {
        env: { ...process.env, HOME: fixture.home },
        encoding: 'utf8'
      })
    );
    expect(verifyBackup(result.directory).ok).toBe(true);
    expect(
      result.manifest.databases.filter((d: { kind: string }) => d.kind === 'indexes')
    ).toHaveLength(3);
    expect(fs.readFileSync(pidFile, 'utf8')).toBe(pid);
    expect(fixture.registry.lease('workspace:shared')?.pid).toBe(process.pid);
    const entry = result.manifest.databases.find((d: { kind: string }) => d.kind === 'indexes');
    expect(
      restored(path.join(result.directory, entry.file), 'SELECT path FROM files').length
    ).toBeGreaterThan(0);
  } finally {
    await daemon.stop();
  }
}, 30000);
