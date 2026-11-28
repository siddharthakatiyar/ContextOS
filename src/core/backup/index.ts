export { backupBeforeMigration } from './pre-migration.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getPackageVersion } from '../../utils/version.js';
import {
  assertNoSymlinkInPath,
  ensurePrivateStateDir,
  writePrivateStateFile
} from '../../utils/secure-state.js';

export type BackupKind = 'registry' | 'knowledge' | 'indexes';
export type BackupScope = { kind: 'all' } | { kind: 'group' | 'project'; name: string };
const entrySchema = z.object({
  kind: z.enum(['registry', 'knowledge', 'indexes']),
  file: z.string().regex(/^db-\d+\.sqlite$/),
  sourcePath: z.string().refine(path.isAbsolute),
  schemaVersion: z.union([z.string(), z.number(), z.null()]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime()
});
export const backupManifestSchema = z.object({
  formatVersion: z.literal(1),
  contextosVersion: z.string(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all') }),
    z.object({ kind: z.literal('group'), name: z.string() }),
    z.object({ kind: z.literal('project'), name: z.string() })
  ]),
  indexes: z.boolean(),
  databases: z.array(entrySchema)
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;
export const backupHome = () => path.join(os.homedir(), '.contextos');
const stamp = () => new Date().toISOString();
const uniqueName = () => `${stamp().replaceAll(':', '-')}-${crypto.randomUUID().slice(0, 8)}`;
function checksum(file: string): string {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}
function readManifest(dir: string): BackupManifest {
  assertNoSymlinkInPath(path.join(dir, 'manifest.json'));
  const result = backupManifestSchema.parse(
    JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  );
  if (
    new Set(result.databases.map((d) => d.file)).size !== result.databases.length ||
    new Set(result.databases.map((d) => d.sourcePath)).size !== result.databases.length
  )
    throw new Error('Duplicate database in manifest');
  return result;
}
function schemaVersion(db: Database.Database, kind: BackupKind): string | number | null {
  const table =
    kind === 'indexes'
      ? 'schema_version'
      : `${kind === 'knowledge' ? 'graph' : 'registry'}_metadata`;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))
    return null;
  if (kind === 'indexes')
    return (
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
        version: number | null;
      }
    ).version;
  return (
    (
      db.prepare(`SELECT value FROM ${table} WHERE key='schema_version'`).get() as
        { value: string | number } | undefined
    )?.value ?? null
  );
}
interface Source {
  kind: BackupKind;
  sourcePath: string;
}
/** Discovery never constructs a migrating registry or an index. All views, including inactive branches, are included. */
export function discoverBackupSources(
  home = backupHome(),
  scope: BackupScope = { kind: 'all' },
  indexes = true
): Source[] {
  const sources: Source[] = [];
  const registry = path.join(home, 'registry.db');
  if (fs.existsSync(registry)) sources.push({ kind: 'registry', sourcePath: registry });
  else if (scope.kind !== 'all') throw new Error('No registry found for selected scope');
  const graph = path.join(home, 'graph.db');
  if (fs.existsSync(graph)) sources.push({ kind: 'knowledge', sourcePath: graph });
  if (!fs.existsSync(registry)) return sources;
  const db = new Database(registry, { readonly: true });
  try {
    let projectIds: string[] | undefined;
    if (scope.kind !== 'all') {
      const table = scope.kind === 'group' ? 'workspaces' : 'projects';
      const row = db
        .prepare(`SELECT id FROM ${table} WHERE name=? OR id=?`)
        .get(scope.name, scope.name) as { id: string } | undefined;
      if (!row) throw new Error(`Unknown ${scope.kind}: ${scope.name}`);
      projectIds =
        scope.kind === 'project'
          ? [row.id]
          : (
              db.prepare('SELECT project_id FROM memberships WHERE workspace_id=?').all(row.id) as {
                project_id: string;
              }[]
            ).map((r) => r.project_id);
    }
    if (indexes)
      for (const row of db.prepare('SELECT project_id, db_path FROM repositories').all() as {
        project_id: string;
        db_path: string;
      }[]) {
        if ((!projectIds || projectIds.includes(row.project_id)) && fs.existsSync(row.db_path))
          sources.push({ kind: 'indexes', sourcePath: row.db_path });
      }
  } finally {
    db.close();
  }
  return sources.filter(
    (s, i) => sources.findIndex((other) => other.sourcePath === s.sourcePath) === i
  );
}
async function snapshot(
  sources: Source[],
  out: string,
  scope: BackupScope,
  indexes: boolean
): Promise<BackupManifest> {
  assertNoSymlinkInPath(out);
  // Never merge into an existing backup or remove somebody else's output on failure.
  ensurePrivateStateDir(path.dirname(out));
  fs.mkdirSync(out, { mode: 0o700 });
  const manifest: BackupManifest = {
    formatVersion: 1,
    contextosVersion: getPackageVersion(),
    startedAt: stamp(),
    completedAt: stamp(),
    scope,
    indexes,
    databases: []
  };
  try {
    for (const source of sources) {
      assertNoSymlinkInPath(source.sourcePath);
      const file = `db-${manifest.databases.length}.sqlite`;
      const target = path.join(out, file);
      const startedAt = stamp();
      const db = new Database(source.sourcePath, { readonly: true });
      try {
        await db.backup(target);
      } finally {
        db.close();
      }
      fs.chmodSync(target, 0o600);
      const saved = new Database(target, { readonly: true });
      try {
        manifest.databases.push({
          ...source,
          file,
          schemaVersion: schemaVersion(saved, source.kind),
          sha256: checksum(target),
          startedAt,
          completedAt: stamp()
        });
      } finally {
        saved.close();
      }
    }
    manifest.completedAt = stamp();
    writePrivateStateFile(
      path.join(out, 'manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n'
    );
    return manifest;
  } catch (error) {
    fs.rmSync(out, { recursive: true, force: true });
    throw error;
  }
}
export async function createBackup(
  options: { home?: string; out?: string; scope?: BackupScope; indexes?: boolean } = {}
) {
  const home = path.resolve(options.home ?? backupHome());
  const scope = options.scope ?? { kind: 'all' };
  const indexes = options.indexes ?? true;
  const out = path.resolve(options.out ?? path.join(home, 'backups', uniqueName()));
  const manifest = await snapshot(discoverBackupSources(home, scope, indexes), out, scope, indexes);
  return { directory: out, manifest };
}
export function verifyBackup(dir: string): {
  ok: boolean;
  errors: string[];
  manifest: BackupManifest;
} {
  const manifest = readManifest(dir);
  const errors: string[] = [];
  for (const entry of manifest.databases) {
    let db: Database.Database | undefined;
    try {
      const file = assertNoSymlinkInPath(path.join(dir, entry.file));
      if (checksum(file) !== entry.sha256) errors.push(`${entry.file}: checksum mismatch`);
      db = new Database(file, { readonly: true });
      const result = db.pragma('integrity_check', { simple: true });
      if (result !== 'ok') errors.push(`${entry.file}: integrity_check: ${String(result)}`);
      if (schemaVersion(db, entry.kind) !== entry.schemaVersion)
        errors.push(`${entry.file}: schema version mismatch`);
    } catch (error) {
      errors.push(`${entry.file}: ${(error as Error).message}`);
    } finally {
      db?.close();
    }
  }
  return { ok: errors.length === 0, errors, manifest };
}
export function listBackups(
  home = backupHome()
): { directory: string; manifest: BackupManifest }[] {
  const root = path.join(home, 'backups');
  if (!fs.existsSync(root)) return [];
  assertNoSymlinkInPath(root);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => {
      const directory = path.join(root, d.name);
      try {
        return [{ directory, manifest: readManifest(directory) }];
      } catch {
        return [];
      }
    })
    .sort(
      (a, b) =>
        b.manifest.startedAt.localeCompare(a.manifest.startedAt) ||
        b.directory.localeCompare(a.directory)
    );
}
export function pruneBackups(keep: number, home = backupHome()): string[] {
  if (!Number.isSafeInteger(keep) || keep < 0)
    throw new Error('--keep must be a non-negative integer');
  const removed = listBackups(home)
    .slice(keep)
    .map((b) => b.directory);
  for (const dir of removed) fs.rmSync(dir, { recursive: true });
  return removed;
}
function assertDaemonStopped(home: string, sources: Source[]): void {
  const dirs = new Set([
    path.join(home, 'runtime'),
    home,
    ...sources.map((s) => path.dirname(s.sourcePath))
  ]);
  const registry = path.join(home, 'registry.db');
  if (fs.existsSync(registry)) {
    const db = new Database(registry, { readonly: true });
    try {
      for (const row of db.prepare('SELECT root_path FROM repositories').all() as {
        root_path: string;
      }[])
        dirs.add(path.join(row.root_path, '.contextos'));
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='indexing_leases'").get()) {
        for (const row of db.prepare('SELECT owner FROM indexing_leases').all() as {
          owner: string;
        }[]) {
          const owner = JSON.parse(row.owner) as { pid?: number };
          if (owner.pid) checkPid(owner.pid);
        }
      }
    } finally {
      db.close();
    }
  }
  for (const dir of dirs)
    for (const name of ['daemon.pid', 'indexer.pid']) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) checkPid(Number(fs.readFileSync(file, 'utf8').trim()));
    }
}
function checkPid(pid: number): void {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
  }
  throw new Error(
    `Daemon or indexer running (PID ${pid}); stop it before restoring or use --force`
  );
}
export async function restoreBackup(
  dir: string,
  options: { home?: string; dryRun?: boolean; only?: BackupKind; force?: boolean } = {}
) {
  const home = path.resolve(options.home ?? backupHome());
  const verified = verifyBackup(dir);
  if (!verified.ok) throw new Error(`Backup verification failed: ${verified.errors.join('; ')}`);
  const entries = verified.manifest.databases.filter(
    (e) => !options.only || e.kind === options.only
  );
  const allowed = new Set(discoverBackupSources(home).map((s) => path.resolve(s.sourcePath)));
  for (const entry of entries) {
    const target = path.resolve(entry.sourcePath);
    const relative = path.relative(home, target);
    const standard =
      (entry.kind === 'registry' && relative === 'registry.db') ||
      (entry.kind === 'knowledge' && relative === 'graph.db') ||
      (entry.kind === 'indexes' &&
        /^projects\/[a-zA-Z0-9_-]+\/views\/[a-zA-Z0-9_-]+\/index\.db$/.test(
          relative.split(path.sep).join('/')
        ));
    if (!standard && !(entry.kind === 'indexes' && allowed.has(target)))
      throw new Error(`Unsafe restore destination: ${target}`);
    assertNoSymlinkInPath(target);
    for (const suffix of ['-wal', '-shm']) assertNoSymlinkInPath(target + suffix);
  }
  if (options.dryRun)
    return { dryRun: true, files: entries.map((e) => e.sourcePath), safetyBackup: null };
  if (!options.force) assertDaemonStopped(home, entries);
  // Include current registered indexes AND any current destination no longer in the registry.
  const sources = discoverBackupSources(home);
  for (const entry of entries)
    if (fs.existsSync(entry.sourcePath) && !sources.some((s) => s.sourcePath === entry.sourcePath))
      sources.push(entry);
  const safetyBackup = path.join(home, 'backups', uniqueName());
  await snapshot(sources, safetyBackup, { kind: 'all' }, true);
  const staged: { temp: string; target: string }[] = [];
  try {
    for (const entry of entries) {
      ensurePrivateStateDir(path.dirname(entry.sourcePath));
      const temp = `${entry.sourcePath}.restore-${crypto.randomUUID()}`;
      staged.push({ temp, target: entry.sourcePath });
      const db = new Database(path.join(dir, entry.file), { readonly: true });
      try {
        await db.backup(temp);
      } finally {
        db.close();
      }
      fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    if (!options.force) assertDaemonStopped(home, entries);
    for (const { temp, target } of staged) {
      for (const suffix of ['-wal', '-shm']) fs.rmSync(target + suffix, { force: true });
      fs.renameSync(temp, target);
    }
  } finally {
    for (const { temp } of staged) fs.rmSync(temp, { force: true });
  }
  return { dryRun: false, files: entries.map((e) => e.sourcePath), safetyBackup };
}
