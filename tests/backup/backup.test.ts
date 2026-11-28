import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import {
  backupManifestSchema,
  createBackup,
  discoverBackupSources,
  listBackups,
  pruneBackups,
  restoreBackup,
  verifyBackup
} from '../../src/core/backup/index.js';
import { backupBeforeMigration } from '../../src/core/backup/pre-migration.js';

let fixture: Awaited<ReturnType<typeof createFixtureGroup>>;
let home: string;
beforeEach(async () => {
  fixture = await createFixtureGroup();
  home = path.join(fixture.home, '.contextos');
  const graph = new Database(path.join(home, 'graph.db'));
  graph.exec(
    "CREATE TABLE graph_metadata(key TEXT PRIMARY KEY, value INTEGER); INSERT INTO graph_metadata VALUES ('schema_version',1); CREATE TABLE saved(value TEXT); INSERT INTO saved VALUES ('original');"
  );
  graph.close();
});
afterEach(async () => {
  await fixture.cleanup();
  vi.restoreAllMocks();
});
async function closeStores() {
  await fixture.runtime.close();
  fixture.registry.close();
  vi.spyOn(fixture.registry, 'close').mockImplementation(() => {});
}
function value(file: string): string {
  const db = new Database(file, { readonly: true });
  try {
    return (db.prepare('SELECT value FROM saved').get() as { value: string }).value;
  } finally {
    db.close();
  }
}

describe('online backup', () => {
  it('records validated manifests, schemas, all view paths and private files', async () => {
    const result = await createBackup({ home });
    expect(backupManifestSchema.parse(result.manifest)).toEqual(result.manifest);
    expect(result.manifest.contextosVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(result.manifest.databases).toHaveLength(5);
    expect(
      result.manifest.databases
        .filter((d) => d.kind === 'indexes')
        .map((d) => d.sourcePath)
        .sort()
    ).toEqual(fixture.sources.map((s) => s.dbPath).sort());
    expect(result.manifest.databases.find((d) => d.kind === 'knowledge')?.schemaVersion).toBe(1);
    expect(
      result.manifest.databases
        .filter((d) => d.kind === 'indexes')
        .every((d) => d.schemaVersion === 8)
    ).toBe(true);
    expect(verifyBackup(result.directory).ok).toBe(true);
    expect(listBackups(home).map((b) => b.directory)).toContain(result.directory);
    if (process.platform !== 'win32')
      expect(fs.statSync(path.join(result.directory, 'db-0.sqlite')).mode & 0o777).toBe(0o600);
    await expect(createBackup({ home, out: result.directory })).rejects.toThrow();
    expect(verifyBackup(result.directory).ok).toBe(true);
  });
  it('selects group/project indexes while always including home knowledge and registry', async () => {
    const group = await createBackup({ home, scope: { kind: 'group', name: 'foundation-130' } });
    expect(group.manifest.databases).toHaveLength(5);
    const project = await createBackup({ home, scope: { kind: 'project', name: 'service-a' } });
    expect(
      project.manifest.databases.filter((d) => d.kind === 'indexes').map((d) => d.sourcePath)
    ).toEqual([fixture.sources[0].dbPath]);
    const small = await createBackup({ home, indexes: false });
    expect(small.manifest.databases.map((d) => d.kind)).toEqual(['registry', 'knowledge']);
    await expect(
      createBackup({ home, indexes: false, scope: { kind: 'group', name: 'missing' } })
    ).rejects.toThrow('Unknown group');
    const empty = path.join(fixture.root, 'empty');
    expect(discoverBackupSources(empty)).toEqual([]);
    expect(fs.existsSync(empty)).toBe(false);
  });
  it('backs up a WAL database while a separate process commits writes', async () => {
    const file = path.join(home, 'graph.db');
    const runtime = path.join(home, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, 'daemon.pid'), String(process.pid));
    const module = createRequire(import.meta.url).resolve('better-sqlite3');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const D=require(process.argv[1]);const db=new D(process.argv[2]);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE writes(n INTEGER PRIMARY KEY, payload TEXT)');let n=0;const stmt=db.prepare('INSERT INTO writes VALUES (?,?)');const tick=()=>db.transaction(()=>{for(let i=0;i<100;i++)stmt.run(++n,'x'.repeat(2000))})();tick();process.stdout.write('ready\\n');setInterval(tick,2);`,
        module,
        file
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    try {
      await once(child.stdout!, 'data');
      const before = new Database(file, { readonly: true });
      const start = (before.prepare('SELECT COUNT(*) n FROM writes').get() as { n: number }).n;
      before.close();
      const backup = await createBackup({ home, indexes: false });
      expect(verifyBackup(backup.directory).ok).toBe(true);
      const entry = backup.manifest.databases.find((d) => d.kind === 'knowledge')!;
      const saved = new Database(path.join(backup.directory, entry.file), { readonly: true });
      const rows = saved.prepare('SELECT COUNT(*) n, MAX(n) max FROM writes').get() as {
        n: number;
        max: number;
      };
      saved.close();
      expect(rows.n).toBeGreaterThanOrEqual(start);
      expect(rows.max).toBe(rows.n);
      const live = new Database(file, { readonly: true });
      expect(
        (live.prepare('SELECT COUNT(*) n FROM writes').get() as { n: number }).n
      ).toBeGreaterThan(start);
      live.close();
    } finally {
      child.kill();
      await once(child, 'exit');
    }
  });
  it('detects checksum changes, SQLite corruption, missing files and refuses restore', async () => {
    const backup = await createBackup({ home, indexes: false });
    const graph = backup.manifest.databases.find((d) => d.kind === 'knowledge')!;
    const target = path.join(backup.directory, graph.file);
    const db = new Database(target);
    db.prepare("UPDATE saved SET value='tampered'").run();
    db.close();
    expect(verifyBackup(backup.directory).errors.join(' ')).toContain('checksum mismatch');
    fs.writeFileSync(target, 'broken database');
    const verified = verifyBackup(backup.directory);
    expect(verified.ok).toBe(false);
    expect(verified.errors.length).toBeGreaterThan(1);
    await expect(restoreBackup(backup.directory, { home })).rejects.toThrow('verification failed');
    fs.unlinkSync(target);
    expect(verifyBackup(backup.directory).ok).toBe(false);
  });
  it('restores all databases and preserves a verified safety backup of current state', async () => {
    const backup = await createBackup({ home });
    await closeStores();
    const graphPath = path.join(home, 'graph.db');
    const graph = new Database(graphPath);
    graph.pragma('journal_mode=WAL');
    graph.prepare("UPDATE saved SET value='changed'").run();
    graph.close();
    const index = new Database(fixture.sources[0].dbPath);
    index.prepare('DELETE FROM files').run();
    index.close();
    const result = await restoreBackup(backup.directory, { home });
    expect(value(graphPath)).toBe('original');
    expect(result.files).toHaveLength(5);
    expect(result.safetyBackup).toBeTruthy();
    const safety = verifyBackup(result.safetyBackup!);
    expect(safety.ok).toBe(true);
    const safetyGraph = safety.manifest.databases.find((d) => d.kind === 'knowledge')!;
    expect(value(path.join(result.safetyBackup!, safetyGraph.file))).toBe('changed');
    const restored = new Database(fixture.sources[0].dbPath, { readonly: true });
    expect(
      (restored.prepare('SELECT COUNT(*) n FROM files').get() as { n: number }).n
    ).toBeGreaterThan(0);
    restored.close();
  });
  it('dry-run performs validation without backups or modifications; only selects requested kind', async () => {
    const backup = await createBackup({ home });
    const before = fs.readFileSync(path.join(home, 'graph.db'));
    const count = listBackups(home).length;
    const dry = await restoreBackup(backup.directory, { home, dryRun: true, only: 'knowledge' });
    expect(dry).toEqual({ dryRun: true, files: [path.join(home, 'graph.db')], safetyBackup: null });
    expect(listBackups(home)).toHaveLength(count);
    expect(fs.readFileSync(path.join(home, 'graph.db'))).toEqual(before);
    await closeStores();
    const result = await restoreBackup(backup.directory, { home, only: 'knowledge' });
    expect(result.files).toEqual(dry.files);
  });
  it('refuses live shared or legacy daemons, permits dry-run and explicit force', async () => {
    const backup = await createBackup({ home, indexes: false });
    const runtime = path.join(home, 'runtime');
    fs.mkdirSync(runtime, { recursive: true });
    const pid = path.join(runtime, 'daemon.pid');
    fs.writeFileSync(pid, String(process.pid));
    await expect(restoreBackup(backup.directory, { home })).rejects.toThrow('running');
    expect((await restoreBackup(backup.directory, { home, dryRun: true })).dryRun).toBe(true);
    await closeStores();
    expect(
      (await restoreBackup(backup.directory, { home, only: 'knowledge', force: true })).dryRun
    ).toBe(false);
    fs.unlinkSync(pid);
    const legacyPid = path.join(fixture.sources[0].rootPath, '.contextos', 'daemon.pid');
    fs.mkdirSync(path.dirname(legacyPid), { recursive: true });
    fs.writeFileSync(legacyPid, String(process.pid));
    await expect(restoreBackup(backup.directory, { home })).rejects.toThrow('running');
  });
  it('rejects traversal, duplicate entries, unsafe destinations and symlink payloads', async () => {
    const backup = await createBackup({ home, indexes: false });
    const manifestFile = path.join(backup.directory, 'manifest.json');
    const write = () => fs.writeFileSync(manifestFile, JSON.stringify(backup.manifest));
    const entry = backup.manifest.databases[0];
    const original = entry.file;
    entry.file = '../registry.db';
    write();
    expect(() => verifyBackup(backup.directory)).toThrow();
    entry.file = original;
    entry.sourcePath = path.join(fixture.root, 'unrelated.db');
    write();
    await expect(restoreBackup(backup.directory, { home, dryRun: true })).rejects.toThrow(
      'Unsafe restore destination'
    );
    entry.sourcePath = path.join(home, 'registry.db');
    backup.manifest.databases.push(entry);
    write();
    expect(() => verifyBackup(backup.directory)).toThrow('Duplicate');
    backup.manifest.databases.pop();
    write();
    const target = path.join(backup.directory, entry.file);
    fs.unlinkSync(target);
    fs.symlinkSync(entry.sourcePath, target);
    expect(verifyBackup(backup.directory).ok).toBe(false);
  });
  it('prunes only valid backup directories and enforces retention arguments', async () => {
    for (let n = 0; n < 4; n++) await createBackup({ home, indexes: false });
    const unrelated = path.join(home, 'backups', 'unrelated');
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, 'precious'), 'keep');
    const newest = listBackups(home)
      .slice(0, 2)
      .map((b) => b.directory);
    expect(pruneBackups(2, home)).toHaveLength(2);
    expect(listBackups(home).map((b) => b.directory)).toEqual(newest);
    expect(fs.existsSync(unrelated)).toBe(true);
    expect(() => pruneBackups(-1, home)).toThrow();
    expect(() => pruneBackups(1.5, home)).toThrow();
    expect(pruneBackups(0, home)).toHaveLength(2);
  });
  it('provides CLI create, scope, list, verify, dry-run and prune JSON commands', () => {
    const cli = (...args: string[]) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          ['--import', 'tsx', 'bin/contextos.ts', 'backup', ...args, '--json'],
          { env: { ...process.env, HOME: fixture.home }, encoding: 'utf8' }
        )
      );
    const backup = cli('--scope', 'project', 'service-a', '--no-indexes');
    expect(backup.manifest.databases).toHaveLength(2);
    expect(cli('list')).toHaveLength(1);
    expect(cli('verify', backup.directory).ok).toBe(true);
    expect(cli('restore', backup.directory, '--dry-run', '--only', 'knowledge').files).toHaveLength(
      1
    );
    expect(cli('prune', '--keep', '0').removed).toHaveLength(1);
  }, 30000);
});

describe('pre-migration backup helper', () => {
  it('waits for an online snapshot, keeps the last three and skips absent/memory databases', () => {
    const file = path.join(home, 'graph.db');
    const backups: string[] = [];
    for (let n = 0; n < 4; n++) {
      const saved = backupBeforeMigration(file)!;
      backups.push(saved);
      expect(value(saved)).toBe('original');
    }
    expect(fs.existsSync(backups[0])).toBe(false);
    expect(backups.slice(1).every((f) => fs.existsSync(f))).toBe(true);
    expect(backupBeforeMigration(':memory:')).toBeUndefined();
    expect(backupBeforeMigration(path.join(home, 'absent.db'))).toBeUndefined();
  });
  it('warns without blocking when backup cannot be created', () => {
    fs.writeFileSync(path.join(home, 'pre-migration-backups'), 'blocked');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(backupBeforeMigration(path.join(home, 'graph.db'))).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Pre-migration backup failed'));
  });
});
