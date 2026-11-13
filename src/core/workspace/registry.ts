import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB, getContextOSHome } from '../storage/database.js';
import { bindRepository } from './identity.js';
import {
  discoverProject,
  localBranches,
  type DiscoveredProject,
  type DiscoveredWorktree
} from './discovery.js';
import { projectStateDirectory, viewDatabasePath, viewStateDirectory } from './storage-paths.js';
import {
  assertNoSymlinkInPath,
  preparePrivateStateFile,
  tightenPrivateStateFile,
  writePrivateStateFile
} from '../../utils/secure-state.js';

export interface RepositorySource {
  /** Compatibility namespace: a repository source is one branch/worktree view. */
  repoId: string;
  projectId: string;
  worktreeId: string;
  viewId: string;
  branch: string | null;
  head: string | null;
  gitDir: string | null;
  commonDir: string | null;
  active: boolean;
  checkoutGeneration: number;
  name: string;
  rootPath: string;
  dbPath: string;
  state: string;
  generation: number;
  lastSuccess: number | null;
  lastError: string | null;
  configFingerprint: string | null;
}
export interface Workspace {
  id: string;
  name: string;
}
export interface Project {
  id: string;
  name: string;
  rootPath: string;
  commonDir: string | null;
}
export interface Worktree {
  id: string;
  projectId: string;
  rootPath: string;
  gitDir: string | null;
  locked: boolean;
  available: boolean;
  removed: boolean;
}
export interface ScopeSelectors {
  repo?: string[];
  workspace?: string;
  allRepos?: boolean;
  project?: string[];
  group?: string;
  branch?: string;
  worktree?: string;
  allWorktrees?: boolean;
}
export interface RetrievalScope {
  workspaceId?: string;
  groupId?: string;
  repoIds: string[];
  activeRepoId?: string;
  sources: RepositorySource[];
}
interface PendingDeletion {
  action: CleanupAction;
  views: { id: string; projectId: string; dbPath: string }[];
}
export interface CleanupAction {
  kind: 'worktree' | 'branch' | 'project';
  id: string;
  projectId: string;
  viewIds: string[];
  reason: string;
}
type RepoRow = {
  id: string;
  project_id: string;
  worktree_id: string;
  branch: string | null;
  head: string | null;
  git_dir: string | null;
  common_dir: string | null;
  active: number;
  checkout_generation: number;
  name: string;
  root_path: string;
  db_path: string;
  state: string;
  generation: number;
  last_success: number | null;
  last_error: string | null;
  config_fingerprint: string | null;
};
function mapRepo(r: RepoRow): RepositorySource {
  return {
    repoId: r.id,
    projectId: r.project_id,
    worktreeId: r.worktree_id,
    viewId: r.id,
    branch: r.branch,
    head: r.head,
    gitDir: r.git_dir,
    commonDir: r.common_dir,
    active: Boolean(r.active),
    checkoutGeneration: r.checkout_generation,
    name: r.name,
    rootPath: r.root_path,
    dbPath: r.db_path,
    state: r.state,
    generation: r.generation,
    lastSuccess: r.last_success,
    lastError: r.last_error,
    configFingerprint: r.config_fingerprint
  };
}
function canonical(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export class WorkspaceRegistry {
  private db: Database.Database;
  readonly home: string;
  private discoveryFingerprints = new Map<string, string>();
  constructor(home = getContextOSHome()) {
    this.home = home;
    const file = preparePrivateStateFile(path.join(home, 'registry.db'));
    this.db = new Database(file);
    tightenPrivateStateFile(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS registry_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO registry_metadata VALUES ('revision','0');
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS indexing_leases (entity_id TEXT PRIMARY KEY, owner TEXT NOT NULL);`);
    const old = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='repositories'")
      .get();
    if (
      old &&
      !(this.db.pragma('table_info(repositories)') as { name: string }[]).some(
        (c) => c.name === 'project_id'
      )
    ) {
      for (const row of this.db.prepare('SELECT owner FROM indexing_leases').all() as {
        owner: string;
      }[]) {
        if (alive(JSON.parse(row.owner).pid))
          throw new Error(
            'Stop existing ContextOS daemons before migrating to global project storage.'
          );
      }
      const backup = path.join(home, 'registry.pre-groups.db');
      if (!fs.existsSync(backup))
        this.db.prepare('VACUUM INTO ?').run(preparePrivateStateFile(backup));
      this.db
        .transaction(() => {
          this.db.exec(
            'ALTER TABLE repositories RENAME TO legacy_repositories; ALTER TABLE memberships RENAME TO legacy_memberships;'
          );
        })
        .immediate();
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL,
      common_dir TEXT, identity_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worktrees (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), root_path TEXT NOT NULL,
        git_dir TEXT, locked INTEGER NOT NULL DEFAULT 0, available INTEGER NOT NULL DEFAULT 1,
        removed INTEGER NOT NULL DEFAULT 0, checkout_generation INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id,root_path));
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), worktree_id TEXT NOT NULL REFERENCES worktrees(id),
        branch TEXT, branch_key TEXT NOT NULL, head TEXT, git_dir TEXT, common_dir TEXT,
        active INTEGER NOT NULL DEFAULT 1, checkout_generation INTEGER NOT NULL DEFAULT 0,
        name TEXT NOT NULL, root_path TEXT NOT NULL, db_path TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'registered', generation INTEGER NOT NULL DEFAULT 0,
        last_success INTEGER, last_error TEXT, config_fingerprint TEXT, indexer_version INTEGER, progress TEXT, created_at INTEGER NOT NULL,
        UNIQUE(worktree_id,branch_key));
      CREATE INDEX IF NOT EXISTS repository_project ON repositories(project_id);
      CREATE TABLE IF NOT EXISTS pending_deletions (id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), project_id TEXT NOT NULL REFERENCES projects(id),
        PRIMARY KEY(workspace_id,project_id));`);
    this.db.pragma('foreign_keys = ON');
    this.ensureWorkspace('default');
    try {
      this.migrateRegistry();
      this.importLegacy();
      this.recoverPendingDeletions();
      for (const repo of this.views().filter((r) => r.state === 'registering'))
        this.finishRegistration(repo);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
  revision(): number {
    return Number(
      (
        this.db.prepare("SELECT value FROM registry_metadata WHERE key='revision'").get() as {
          value: string;
        }
      ).value
    );
  }
  private touch(): void {
    this.db
      .prepare("UPDATE registry_metadata SET value=CAST(value AS INTEGER)+1 WHERE key='revision'")
      .run();
  }
  ensureWorkspace(name: string): Workspace {
    if (!name.trim() || /[/\\]/.test(name)) throw new Error('Group name must be a nonempty label.');
    const result = this.db
      .prepare('INSERT OR IGNORE INTO workspaces VALUES (?,?,?)')
      .run(crypto.randomUUID(), name, Date.now());
    if (result.changes) this.touch();
    return this.workspace(name);
  }
  ensureGroup(name: string): Workspace {
    return this.ensureWorkspace(name);
  }
  group(name: string): Workspace {
    return this.workspace(name);
  }
  groups(): Workspace[] {
    return this.workspaces();
  }
  workspace(name: string): Workspace {
    const row = this.db
      .prepare('SELECT id,name FROM workspaces WHERE name=? OR id=?')
      .get(name, name) as Workspace | undefined;
    if (!row) throw new Error(`Unknown workspace/group: ${name}`);
    return row;
  }
  workspaces(): Workspace[] {
    return this.db.prepare('SELECT id,name FROM workspaces ORDER BY name').all() as Workspace[];
  }
  projects(): Project[] {
    return (
      this.db.prepare('SELECT * FROM projects ORDER BY name').all() as {
        id: string;
        name: string;
        root_path: string;
        common_dir: string | null;
      }[]
    ).map((p) => ({ id: p.id, name: p.name, rootPath: p.root_path, commonDir: p.common_dir }));
  }
  worktrees(selector?: string): Worktree[] {
    const projectId = selector ? this.project(selector).id : undefined;
    return (
      this.db
        .prepare(
          `SELECT * FROM worktrees ${projectId ? 'WHERE project_id=?' : ''} ORDER BY root_path`
        )
        .all(...(projectId ? [projectId] : [])) as {
        id: string;
        project_id: string;
        root_path: string;
        git_dir: string | null;
        locked: number;
        available: number;
        removed: number;
      }[]
    ).map((w) => ({
      id: w.id,
      projectId: w.project_id,
      rootPath: w.root_path,
      gitDir: w.git_dir,
      locked: !!w.locked,
      available: !!w.available,
      removed: !!w.removed
    }));
  }
  project(selector: string): Project {
    const direct = this.projects().find(
      (p) => p.id === selector || p.name === selector || p.rootPath === canonical(selector)
    );
    if (direct) return direct;
    const view = this.views().find(
      (v) =>
        v.repoId === selector || v.worktreeId === selector || v.rootPath === canonical(selector)
    );
    const found = view && this.projects().find((p) => p.id === view.projectId);
    if (!found) throw new Error(`Unknown repository/project: ${selector}`);
    return found;
  }
  views(selector?: string): RepositorySource[] {
    const id = selector ? this.project(selector).id : undefined;
    return (
      this.db
        .prepare(
          `SELECT * FROM repositories ${id ? 'WHERE project_id=?' : ''} ORDER BY name,root_path,branch_key`
        )
        .all(...(id ? [id] : [])) as RepoRow[]
    ).map(mapRepo);
  }
  listAll(): RepositorySource[] {
    return this.views().filter((r) => r.active);
  }
  private primary(sources: RepositorySource[]): RepositorySource[] {
    const selected = new Map<string, RepositorySource>();
    const projects = new Map(this.projects().map((p) => [p.id, p]));
    for (const view of sources) {
      const old = selected.get(view.projectId);
      if (
        !old ||
        (view.rootPath === projects.get(view.projectId)?.rootPath &&
          old.rootPath !== view.rootPath) ||
        (old.state === 'unavailable' && view.state !== 'unavailable')
      )
        selected.set(view.projectId, view);
    }
    return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  list(workspace = 'default', allWorktrees = false): RepositorySource[] {
    const members = new Set(
      (
        this.db
          .prepare('SELECT project_id FROM memberships WHERE workspace_id=?')
          .all(this.workspace(workspace).id) as { project_id: string }[]
      ).map((r) => r.project_id)
    );
    const sources = this.listAll().filter((r) => members.has(r.projectId));
    return allWorktrees ? sources : this.primary(sources);
  }
  resolve(selector: string): RepositorySource {
    const views = this.views();
    const exact = views.find((r) => r.repoId === selector);
    if (exact) return exact;
    const root = canonical(selector);
    const matches = views.filter(
      (r) => r.active && (r.worktreeId === selector || r.rootPath === root)
    );
    if (matches.length === 1) return matches[0];
    const project = this.project(selector);
    const view = this.primary(views.filter((r) => r.active && r.projectId === project.id))[0];
    if (!view) throw new Error(`No live checkout for project: ${selector}`);
    return view;
  }
  active(cwd: string): RepositorySource | undefined {
    const root = canonical(cwd);
    return this.listAll()
      .filter((r) => root === r.rootPath || root.startsWith(r.rootPath + path.sep))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  }
  register(
    input: string,
    opts: { name?: string; workspace?: string; group?: string } = {}
  ): RepositorySource {
    const discovery = discoverProject(input);
    const requested = canonical(input);
    const ws = this.workspace(opts.group ?? opts.workspace ?? 'default');
    let preferred: { id: string; root: string; dbPath: string } | undefined;
    const legacyPath = path.join(discovery.rootPath, '.contextos', 'index.db');
    if (fs.existsSync(legacyPath)) {
      this.assertLegacyStopped(legacyPath);
      const legacy = new Database(legacyPath, { readonly: true });
      try {
        if (
          legacy.prepare("SELECT name FROM sqlite_master WHERE name='repository_metadata'").get()
        ) {
          const metadata = Object.fromEntries(
            (
              legacy.prepare('SELECT key,value FROM repository_metadata').all() as {
                key: string;
                value: string;
              }[]
            ).map((r) => [r.key, r.value])
          );
          if (
            metadata.repo_id &&
            metadata.root_path === discovery.rootPath &&
            !this.db.prepare('SELECT id FROM repositories WHERE id=?').get(metadata.repo_id)
          )
            preferred = { id: metadata.repo_id, root: discovery.rootPath, dbPath: legacyPath };
        }
      } finally {
        legacy.close();
      }
    }
    const sources = this.upsertDiscovery(discovery, opts.name, preferred);
    this.db
      .prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)')
      .run(ws.id, sources[0].projectId);
    this.touch();
    for (const source of sources)
      if (source.state === 'registering') this.finishRegistration(source);
    return this.active(requested) ?? this.resolve(sources[0].projectId);
  }
  private upsertDiscovery(
    discovery: DiscoveredProject,
    name?: string,
    preferred?: { id: string; root: string; dbPath: string }
  ): RepositorySource[] {
    const key = crypto
      .createHash('sha256')
      .update(discovery.commonDir ?? discovery.rootPath)
      .digest('hex');
    const project = this.db
      .transaction(() => {
        let row = this.db.prepare('SELECT id FROM projects WHERE identity_key=?').get(key) as
          { id: string } | undefined;
        if (!row) {
          const display = name ?? path.basename(discovery.rootPath);
          if (
            !display.trim() ||
            this.db.prepare('SELECT id FROM projects WHERE name=?').get(display)
          )
            throw new Error(
              `Repository name already exists or is empty: ${display}. Use --name <unique-name>.`
            );
          row = { id: crypto.randomUUID() };
          this.db
            .prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)')
            .run(row.id, display, discovery.rootPath, discovery.commonDir, key, Date.now());
        }
        if (this.projectHasPendingDeletion(row!.id))
          throw new Error(
            'Project cleanup is in progress. Restart ContextOS to finish cleanup before registering it.'
          );
        return this.projects().find((p) => p.id === row!.id)!;
      })
      .immediate();
    const sources: RepositorySource[] = [];
    const hasLegacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE name='legacy_repositories'")
      .get();
    for (const tree of discovery.worktrees) {
      const legacy = hasLegacy
        ? (this.db
            .prepare('SELECT id,root_path,db_path FROM legacy_repositories WHERE root_path=?')
            .get(tree.rootPath) as { id: string; root_path: string; db_path: string } | undefined)
        : undefined;
      sources.push(
        this.upsertWorktree(
          project,
          tree,
          legacy ? { id: legacy.id, root: legacy.root_path, dbPath: legacy.db_path } : preferred
        )
      );
    }
    return sources;
  }
  private upsertWorktree(
    project: Project,
    tree: DiscoveredWorktree,
    preferred?: { id: string; root: string; dbPath: string }
  ): RepositorySource {
    const branchKey = tree.branch ?? (tree.head ? `detached:${tree.head}` : 'working');
    return this.db
      .transaction(() => {
        let mutated = false;
        let wt = this.db
          .prepare(
            'SELECT id,checkout_generation,root_path FROM worktrees WHERE project_id=? AND (root_path=? OR (git_dir IS NOT NULL AND git_dir=?))'
          )
          .get(project.id, tree.rootPath, tree.gitDir) as
          { id: string; checkout_generation: number; root_path?: string } | undefined;
        if (!wt) {
          mutated = true;
          wt = { id: crypto.randomUUID(), checkout_generation: 0 };
          this.db
            .prepare(
              'INSERT INTO worktrees (id,project_id,root_path,git_dir,locked,available) VALUES (?,?,?,?,?,?)'
            )
            .run(wt.id, project.id, tree.rootPath, tree.gitDir, +tree.locked, +tree.available);
        }
        const previous = this.db
          .prepare('SELECT * FROM repositories WHERE worktree_id=? AND active=1')
          .get(wt.id) as (RepoRow & { branch_key: string }) | undefined;
        const switched = Boolean(previous && previous.branch_key !== branchKey);
        const moved = Boolean(wt.root_path && wt.root_path !== tree.rootPath);
        const wtState = this.db
          .prepare('SELECT git_dir,locked,available,removed FROM worktrees WHERE id=?')
          .get(wt.id) as {
          git_dir: string | null;
          locked: number;
          available: number;
          removed: number;
        };
        mutated ||=
          switched ||
          wtState.git_dir !== tree.gitDir ||
          wtState.locked !== +tree.locked ||
          wtState.available !== +tree.available ||
          Boolean(wtState.removed);
        if (switched || moved || (previous && previous.head !== tree.head))
          wt.checkout_generation++;
        this.db
          .prepare(
            'UPDATE worktrees SET git_dir=?,locked=?,available=?,removed=0,checkout_generation=?,root_path=? WHERE id=?'
          )
          .run(
            tree.gitDir,
            +tree.locked,
            +tree.available,
            wt.checkout_generation,
            tree.rootPath,
            wt.id
          );
        this.db
          .prepare('UPDATE repositories SET active=0,root_path=? WHERE worktree_id=?')
          .run(tree.rootPath, wt.id);
        let row = this.db
          .prepare('SELECT * FROM repositories WHERE worktree_id=? AND branch_key=?')
          .get(wt.id, branchKey) as RepoRow | undefined;
        if (!row) {
          mutated = true;
          const id = preferred?.root === tree.rootPath ? preferred.id : crypto.randomUUID();
          this.db
            .prepare(
              `INSERT INTO repositories (id,project_id,worktree_id,branch,branch_key,head,git_dir,common_dir,active,checkout_generation,name,root_path,db_path,state,created_at)
          VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`
            )
            .run(
              id,
              project.id,
              wt.id,
              tree.branch,
              branchKey,
              tree.head,
              tree.gitDir,
              tree.commonDir,
              wt.checkout_generation,
              project.name,
              tree.rootPath,
              viewDatabasePath(project.id, id, this.home),
              tree.available ? 'registering' : 'unavailable',
              Date.now()
            );
        } else {
          const changed = row.head !== tree.head || switched || moved;
          mutated ||=
            changed ||
            !previous ||
            row.git_dir !== tree.gitDir ||
            (!tree.available && row.state !== 'unavailable') ||
            (tree.available && row.state === 'unavailable');
          this.db
            .prepare(
              `UPDATE repositories SET active=1,head=?,git_dir=?,checkout_generation=?,state=?,last_error=? WHERE id=?`
            )
            .run(
              tree.head,
              tree.gitDir,
              wt.checkout_generation,
              !tree.available
                ? 'unavailable'
                : changed
                  ? 'registered'
                  : row.state === 'unavailable'
                    ? 'registered'
                    : row.state,
              tree.available
                ? changed || row.state === 'unavailable'
                  ? null
                  : row.last_error
                : 'Repository path is unavailable',
              row.id
            );
          if (changed && fs.existsSync(row.db_path)) {
            const local = new Database(row.db_path);
            try {
              local
                .prepare("INSERT OR REPLACE INTO repository_metadata VALUES ('needs_reindex','1')")
                .run();
              local
                .prepare("INSERT OR REPLACE INTO repository_metadata VALUES ('head',?)")
                .run(tree.head ?? '');
              local
                .prepare("INSERT OR REPLACE INTO repository_metadata VALUES ('branch',?)")
                .run(tree.branch ?? '');
              local
                .prepare(
                  "INSERT OR REPLACE INTO repository_metadata VALUES ('checkout_generation',?)"
                )
                .run(String(wt.checkout_generation));
            } finally {
              local.close();
            }
          }
        }
        row = this.db
          .prepare('SELECT * FROM repositories WHERE worktree_id=? AND branch_key=?')
          .get(wt.id, branchKey) as RepoRow;
        if (mutated) this.touch();
        return mapRepo(row);
      })
      .immediate();
  }
  private finishRegistration(
    repo: RepositorySource,
    legacyPath = path.join(repo.rootPath, '.contextos', 'index.db')
  ): void {
    // Initialization can take seconds (schema migrations and legacy copies). Keep the
    // registry write lock short and use the existing per-view lease to serialize it.
    // The same lease also prevents cleanup from removing the view mid-registration.
    const candidate = { pid: process.pid, token: crypto.randomUUID(), endpoint: '', protocol: 0 };
    const deadline = Date.now() + 60_000;
    for (;;) {
      const owner = this.db
        .transaction(() => {
          const row = this.db
            .prepare('SELECT state FROM repositories WHERE id=?')
            .get(repo.repoId) as { state: string } | undefined;
          if (!row || row.state === 'deleting')
            throw new Error(`View ${repo.repoId} was removed or is being cleaned up.`);
          const existing = this.lease(repo.repoId);
          if (existing && alive(existing.pid)) return existing;
          this.db
            .prepare(
              'INSERT INTO indexing_leases VALUES (?,?) ON CONFLICT(entity_id) DO UPDATE SET owner=excluded.owner'
            )
            .run(repo.repoId, JSON.stringify(candidate));
          return candidate;
        })
        .immediate();
      if (owner.token === candidate.token) break;
      if (Date.now() >= deadline)
        throw new Error(`Timed out waiting for registration of view ${repo.repoId}.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
    try {
      this.completeRegistration(repo, legacyPath);
    } finally {
      this.releaseLease(repo.repoId, candidate.token);
    }
  }
  private completeRegistration(repo: RepositorySource, legacyPath: string): void {
    const current = this.db
      .prepare('SELECT state FROM repositories WHERE id=?')
      .get(repo.repoId) as { state: string } | undefined;
    if (current && current.state !== 'registering' && fs.existsSync(repo.dbPath)) return;
    if (!fs.existsSync(repo.rootPath)) {
      this.update(repo.repoId, {
        state: 'unavailable',
        lastError: 'Repository path is unavailable'
      });
      return;
    }
    let copiedLegacy = false;
    if (!fs.existsSync(repo.dbPath) && fs.existsSync(legacyPath)) {
      this.assertLegacyStopped(legacyPath);
      const local = new Database(legacyPath, { readonly: true });
      try {
        const pending = preparePrivateStateFile(repo.dbPath + '.migration-pending');
        fs.rmSync(pending, { force: true });
        local.prepare('VACUUM INTO ?').run(pending);
        tightenPrivateStateFile(pending);
        fs.renameSync(pending, repo.dbPath);
        copiedLegacy = true;
      } finally {
        local.close();
      }
    }
    const legacyConfig = path.join(repo.rootPath, '.contextos', 'config.json');
    const projectConfig = path.join(
      projectStateDirectory(repo.projectId, this.home),
      'config.json'
    );
    if (fs.existsSync(legacyConfig) && !fs.existsSync(projectConfig))
      writePrivateStateFile(projectConfig, fs.readFileSync(legacyConfig, 'utf8'));
    const db = new DB(preparePrivateStateFile(repo.dbPath));
    try {
      if (copiedLegacy)
        db.getInstance()
          .prepare("INSERT OR REPLACE INTO repository_metadata VALUES ('needs_reindex','1')")
          .run();
      bindRepository(db.getInstance(), repo.repoId, repo.rootPath, {
        projectId: repo.projectId,
        worktreeId: repo.worktreeId,
        viewId: repo.viewId,
        branch: repo.branch,
        head: repo.head,
        checkoutGeneration: repo.checkoutGeneration
      });
    } finally {
      db.close();
    }
    if (repo.state === 'registering')
      this.update(repo.repoId, { state: 'registered', lastError: null });
  }
  private assertLegacyStopped(dbPath: string): void {
    for (const file of ['daemon.pid', 'indexer.pid']) {
      const pidFile = path.join(path.dirname(dbPath), file);
      if (!fs.existsSync(pidFile)) continue;
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (pid > 0 && alive(pid))
        throw new Error(
          `Stop the existing ContextOS daemon (PID ${pid}) before migrating ${dbPath}.`
        );
    }
  }
  remove(selector: string, workspace = 'default'): void {
    const project = this.project(selector);
    const result = this.db
      .prepare('DELETE FROM memberships WHERE workspace_id=? AND project_id=?')
      .run(this.workspace(workspace).id, project.id);
    if (!result.changes)
      throw new Error(`${project.name} is not a member of workspace/group ${workspace}`);
    this.touch();
  }
  update(
    id: string,
    values: {
      state?: string;
      lastError?: string | null;
      lastSuccess?: number;
      configFingerprint?: string;
      indexerVersion?: number;
      progress?: unknown;
      incrementGeneration?: boolean;
    }
  ): void {
    this.db.transaction(() => {
      const columns: [string, unknown][] = [];
      for (const [key, column] of Object.entries({
        state: 'state',
        lastError: 'last_error',
        lastSuccess: 'last_success',
        configFingerprint: 'config_fingerprint',
        indexerVersion: 'indexer_version'
      }))
        if (key in values) columns.push([column, values[key as keyof typeof values]]);
      if (values.progress !== undefined)
        columns.push(['progress', JSON.stringify(values.progress)]);
      if (columns.length)
        this.db
          .prepare(
            `UPDATE repositories SET ${columns.map(([key]) => `${key}=?`).join(',')} WHERE id=?`
          )
          .run(...columns.map(([, v]) => v), id);
      if (values.incrementGeneration)
        this.db.prepare('UPDATE repositories SET generation=generation+1 WHERE id=?').run(id);
      this.touch();
    })();
  }
  select(
    selectors: ScopeSelectors,
    cwd: string,
    defaultWorkspace?: string,
    activeRepoId?: string
  ): RetrievalScope {
    this.reconcile();
    const repos = selectors.project ?? selectors.repo;
    if (repos?.length && selectors.allRepos)
      throw new Error('--repo/--project and --all-repos cannot be combined.');
    const priorActive = activeRepoId ? this.resolve(activeRepoId) : undefined;
    const active = priorActive
      ? (this.listAll().find((v) => v.worktreeId === priorActive.worktreeId) ?? priorActive)
      : this.active(cwd);
    const explicitGroup = selectors.group ?? selectors.workspace;
    let workspace: Workspace | undefined;
    let sources: RepositorySource[] = [];
    if (
      explicitGroup ||
      selectors.allRepos ||
      (selectors.allWorktrees && !repos?.length && !selectors.worktree)
    ) {
      workspace = this.workspace(explicitGroup ?? defaultWorkspace ?? 'default');
      sources = this.list(workspace.id, Boolean(selectors.allWorktrees || selectors.branch));
      if (!selectors.allWorktrees && !selectors.branch && active)
        sources = sources.map((s) => (s.projectId === active.projectId ? active : s));
    }
    if (repos?.length) {
      sources = [...new Set(repos)].flatMap((selector) => {
        const selected = this.resolve(selector);
        return selectors.allWorktrees || selectors.branch
          ? this.listAll().filter((r) => r.projectId === selected.projectId)
          : [active?.projectId === selected.projectId ? active : selected];
      });
      const bound = explicitGroup
        ? workspace
        : defaultWorkspace
          ? this.workspace(defaultWorkspace)
          : undefined;
      if (bound) {
        const members = new Set(this.list(bound.id, true).map((r) => r.projectId));
        if (sources.some((r) => !members.has(r.projectId)))
          throw new Error('Selected repository/project is outside the workspace/group.');
        workspace = bound;
      }
    } else if (
      !explicitGroup &&
      !selectors.allRepos &&
      !selectors.allWorktrees &&
      !selectors.worktree
    ) {
      if (!active)
        throw new Error('No active repository. Select --project, --group, or --all-repos.');
      sources = [active];
      if (selectors.branch)
        sources = this.listAll().filter((r) => r.projectId === active.projectId);
    }
    if (selectors.worktree) {
      const root = canonical(selectors.worktree);
      const matches = this.listAll().filter(
        (r) =>
          r.worktreeId === selectors.worktree ||
          r.repoId === selectors.worktree ||
          r.rootPath === root
      );
      if (!matches.length) throw new Error(`Unknown worktree: ${selectors.worktree}`);
      const allowed = new Set(sources.map((r) => r.projectId));
      if ((explicitGroup || repos?.length) && matches.some((r) => !allowed.has(r.projectId)))
        throw new Error('Selected worktree is outside the selected project/group.');
      sources = matches;
    }
    if (selectors.branch) {
      sources = sources.filter((r) => r.branch === selectors.branch);
      const counts = new Map<string, number>();
      for (const r of sources) counts.set(r.projectId, (counts.get(r.projectId) ?? 0) + 1);
      if (!selectors.allWorktrees && [...counts.values()].some((n) => n > 1))
        throw new Error('Branch matches multiple checkouts. Select --worktree.');
      if (!sources.length)
        throw new Error(`No live indexed checkout for branch: ${selectors.branch}`);
    }
    sources = [...new Map(sources.map((r) => [r.repoId, r])).values()];
    if (!sources.length)
      throw new Error(
        'The selected workspace/group has no repositories. Use contextos group add <group> <path>.'
      );
    return {
      workspaceId: workspace?.id,
      groupId: workspace?.id,
      repoIds: sources.map((r) => r.repoId),
      activeRepoId: active?.repoId,
      sources
    };
  }
  reconcile(selector?: string): RepositorySource[] {
    const projects = selector ? [this.project(selector)] : this.projects();
    for (const project of projects) {
      const trees = this.worktrees(project.id);
      if (this.projectHasPendingDeletion(project.id)) continue;
      const fingerprint = this.discoveryFingerprint(project, trees);
      if (this.discoveryFingerprints.get(project.id) === fingerprint) continue;
      const root = [project.rootPath, ...trees.map((w) => w.rootPath)].find((p) =>
        fs.existsSync(p)
      );
      if (!root) {
        for (const view of this.views(project.id).filter((v) => v.active))
          this.update(view.repoId, {
            state: 'unavailable',
            lastError: 'Repository path is unavailable'
          });
        continue;
      }
      let discovery: DiscoveredProject;
      try {
        discovery = discoverProject(root);
      } catch {
        continue;
      }
      // A missing mount or replaced directory must not silently become another project.
      if (discovery.commonDir !== project.commonDir) {
        for (const view of this.views(project.id).filter((v) => v.active))
          this.update(view.repoId, {
            state: 'unavailable',
            lastError: 'Registered Git repository identity changed'
          });
        continue;
      }
      const current = this.upsertDiscovery(discovery);
      const currentWorktreeIds = new Set(current.map((w) => w.worktreeId));
      for (const tree of trees)
        if (!currentWorktreeIds.has(tree.id) && !tree.locked && project.commonDir) {
          this.db.prepare('UPDATE worktrees SET removed=1,available=0 WHERE id=?').run(tree.id);
          this.db
            .prepare("UPDATE repositories SET active=0,state='removed' WHERE worktree_id=?")
            .run(tree.id);
          this.touch();
        }
      for (const view of current) if (view.state === 'registering') this.finishRegistration(view);
      this.discoveryFingerprints.set(
        project.id,
        this.discoveryFingerprint(project, this.worktrees(project.id))
      );
    }
    return this.listAll();
  }
  private discoveryFingerprint(project: Project, trees: Worktree[]): string {
    const pieces: string[] = [];
    const inspect = (file: string, contents = false): void => {
      try {
        const stat = fs.statSync(file);
        pieces.push(file, String(stat.mtimeMs), String(stat.size));
        if (contents && stat.isFile()) pieces.push(fs.readFileSync(file, 'utf8'));
      } catch {
        pieces.push(file, 'missing');
      }
    };
    for (const tree of trees) {
      inspect(tree.rootPath);
      if (tree.gitDir) inspect(path.join(tree.gitDir, 'HEAD'), true);
    }
    if (project.commonDir) {
      inspect(path.join(project.commonDir, 'HEAD'), true);
      inspect(path.join(project.commonDir, 'packed-refs'));
      const refs = path.join(project.commonDir, 'refs', 'heads');
      const walk = (directory: string): void => {
        inspect(directory);
        try {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else inspect(file, true);
          }
        } catch {
          /* absent refs */
        }
      };
      walk(refs);
      const worktrees = path.join(project.commonDir, 'worktrees');
      inspect(worktrees);
      try {
        for (const entry of fs.readdirSync(worktrees)) {
          const dir = path.join(worktrees, entry);
          inspect(dir);
          inspect(path.join(dir, 'HEAD'), true);
          inspect(path.join(dir, 'locked'));
          inspect(path.join(dir, 'gitdir'), true);
        }
      } catch {
        /* no linked worktrees */
      }
    }
    return crypto.createHash('sha256').update(pieces.join('\0')).digest('hex');
  }
  cleanup(options: { dryRun?: boolean } = {}): CleanupAction[] {
    this.reconcile();
    const actions: CleanupAction[] = [];
    for (const project of this.projects()) {
      for (const tree of this.worktrees(project.id).filter((w) => w.removed && !w.locked))
        actions.push({
          kind: 'worktree',
          id: tree.id,
          projectId: project.id,
          viewIds: this.views(project.id)
            .filter((v) => v.worktreeId === tree.id)
            .map((v) => v.repoId),
          reason: 'Git no longer lists this worktree'
        });
      if (project.commonDir) {
        const root = this.worktrees(project.id).find((w) => w.available && !w.removed)?.rootPath;
        if (!root) continue;
        let branches: Set<string>;
        try {
          branches = localBranches(root);
        } catch {
          continue;
        }
        const removedIds = new Set(actions.flatMap((a) => a.viewIds));
        for (const view of this.views(project.id))
          if (
            !view.active &&
            view.branch &&
            !branches.has(view.branch) &&
            !removedIds.has(view.repoId)
          )
            actions.push({
              kind: 'branch',
              id: view.repoId,
              projectId: project.id,
              viewIds: [view.repoId],
              reason: 'Branch was deleted and has no live checkout'
            });
      }
    }
    if (!options.dryRun) {
      const staged = this.stageDeletions(actions);
      for (const pending of staged) this.finishDeletion(pending.id, pending.record);
    }
    return actions;
  }
  purgeProject(selector: string): CleanupAction {
    const project = this.project(selector);
    const action: CleanupAction = {
      kind: 'project',
      id: project.id,
      projectId: project.id,
      viewIds: this.views(project.id).map((v) => v.repoId),
      reason: 'Project explicitly purged'
    };
    const staged = this.stageDeletions([action]);
    for (const pending of staged) this.finishDeletion(pending.id, pending.record);
    return action;
  }
  private projectHasPendingDeletion(projectId: string): boolean {
    return Boolean(
      this.db
        .prepare(
          "SELECT 1 FROM pending_deletions WHERE json_extract(payload,'$.action.projectId')=? LIMIT 1"
        )
        .get(projectId)
    );
  }
  private validateOwnedView(view: { id: string; projectId: string; dbPath: string }): void {
    const expected = viewDatabasePath(view.projectId, view.id, this.home);
    if (path.resolve(view.dbPath) !== path.resolve(expected))
      throw new Error(`Refusing cleanup outside owned project storage: ${view.dbPath}`);
    assertNoSymlinkInPath(viewStateDirectory({ dbPath: expected }));
  }
  private stageDeletions(actions: CleanupAction[]): { id: string; record: PendingDeletion }[] {
    return this.db
      .transaction(() => {
        const staged = actions.map((action) => ({
          id: crypto.randomUUID(),
          record: {
            action,
            views: action.viewIds.map((id) => {
              const row = this.db
                .prepare('SELECT id,project_id,db_path FROM repositories WHERE id=?')
                .get(id) as { id: string; project_id: string; db_path: string } | undefined;
              if (!row || row.project_id !== action.projectId)
                throw new Error(`View disappeared or changed project during cleanup: ${id}`);
              return { id: row.id, projectId: row.project_id, dbPath: row.db_path };
            })
          }
        }));
        // Validate every affected view before changing any membership, row or file.
        for (const pending of staged) {
          const projectPath = projectStateDirectory(pending.record.action.projectId, this.home);
          assertNoSymlinkInPath(projectPath);
          for (const view of pending.record.views) {
            this.validateOwnedView(view);
            const lease = this.lease(view.id);
            if (lease && alive(lease.pid))
              throw new Error(
                `View ${view.id} is in use. Stop its ContextOS indexing owner before cleanup.`
              );
          }
        }
        for (const pending of staged) {
          this.db
            .prepare('INSERT INTO pending_deletions VALUES (?,?,?)')
            .run(pending.id, JSON.stringify(pending.record), Date.now());
          for (const view of pending.record.views)
            this.db
              .prepare("UPDATE repositories SET state='deleting',active=0 WHERE id=?")
              .run(view.id);
        }
        if (staged.length) this.touch();
        return staged;
      })
      .immediate();
  }
  private recoverPendingDeletions(): void {
    const pending = this.db
      .prepare('SELECT id,payload FROM pending_deletions ORDER BY created_at,id')
      .all() as { id: string; payload: string }[];
    for (const row of pending)
      this.finishDeletion(row.id, JSON.parse(row.payload) as PendingDeletion);
  }
  private finishDeletion(id: string, pending: PendingDeletion): void {
    const { action, views } = pending;
    assertNoSymlinkInPath(projectStateDirectory(action.projectId, this.home));
    for (const view of views) {
      this.validateOwnedView(view);
      const lease = this.lease(view.id);
      if (lease && alive(lease.pid))
        throw new Error(`Cleanup for view ${view.id} is waiting for its indexing owner to stop.`);
    }
    this.deleteGraphViews(
      views.map((v) => v.id),
      action.kind === 'project' ? action.projectId : undefined
    );
    // Keep the durable journal and registry tombstones until all filesystem work succeeds.
    for (const view of views)
      fs.rmSync(viewStateDirectory({ dbPath: view.dbPath }), { recursive: true, force: true });
    if (action.kind === 'project')
      fs.rmSync(projectStateDirectory(action.projectId, this.home), {
        recursive: true,
        force: true
      });
    this.db
      .transaction(() => {
        for (const view of views) {
          this.db.prepare('DELETE FROM indexing_leases WHERE entity_id=?').run(view.id);
          this.db.prepare('DELETE FROM repositories WHERE id=?').run(view.id);
        }
        if (action.kind === 'worktree')
          this.db.prepare('DELETE FROM worktrees WHERE id=?').run(action.id);
        if (action.kind === 'project') {
          this.db.prepare('DELETE FROM memberships WHERE project_id=?').run(action.projectId);
          this.db.prepare('DELETE FROM worktrees WHERE project_id=?').run(action.projectId);
          this.db.prepare('DELETE FROM projects WHERE id=?').run(action.projectId);
        }
        this.db.prepare('DELETE FROM pending_deletions WHERE id=?').run(id);
        this.touch();
      })
      .immediate();
    this.discoveryFingerprints.delete(action.projectId);
  }
  private deleteGraphViews(ids: string[], projectId?: string): void {
    // Graph implementation may add tables independently. Delete only recognized view ownership columns.
    const graphPath = path.join(this.home, 'graph.db');
    if (fs.existsSync(graphPath)) {
      const graph = new Database(preparePrivateStateFile(graphPath));
      try {
        const tables = graph
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        graph.transaction(() => {
          let removed = 0;
          if (projectId && tables.some((table) => table.name === 'verified_facts'))
            removed += graph
              .prepare(
                "DELETE FROM verified_facts WHERE json_extract(payload,'$.scope')='project' AND json_extract(payload,'$.scopeId')=?"
              )
              .run(projectId).changes;
          for (const table of tables) {
            if (['verified_links', 'verified_facts'].includes(table.name))
              for (const id of ids) {
                const query =
                  table.name === 'verified_facts'
                    ? "DELETE FROM verified_facts WHERE NOT (COALESCE(json_extract(payload,'$.provenance'),'')='user' AND COALESCE(json_extract(payload,'$.scope'),'') IN ('project','group')) AND (EXISTS (SELECT 1 FROM json_each(payload,'$.viewIds') WHERE value=?) OR EXISTS (SELECT 1 FROM json_each(payload,'$.evidence') WHERE json_extract(value,'$.viewId')=?))"
                    : "DELETE FROM verified_links WHERE EXISTS (SELECT 1 FROM json_each(payload,'$.evidence') WHERE json_extract(value,'$.viewId')=?)";
                removed += graph
                  .prepare(query)
                  .run(...(table.name === 'verified_facts' ? [id, id] : [id])).changes;
              }
            const name = table.name.replaceAll('"', '""');
            const cols = (graph.pragma(`table_info("${name}")`) as { name: string }[])
              .map((c) => c.name)
              .filter((c) =>
                [
                  'view_id',
                  'source_view_id',
                  'target_view_id',
                  'repo_id',
                  'source_repo_id',
                  'target_repo_id'
                ].includes(c)
              );
            if (cols.length)
              for (const id of ids)
                graph
                  .prepare(
                    `DELETE FROM "${name}" WHERE ${cols.map((c) => `"${c}"=?`).join(' OR ')}`
                  )
                  .run(...cols.map(() => id));
          }
          if (removed && tables.some((t) => t.name === 'graph_metadata'))
            graph.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
        })();
      } finally {
        graph.close();
      }
    }
  }
  lease(
    id: string
  ): { pid: number; token: string; endpoint: string; protocol: number } | undefined {
    const row = this.db.prepare('SELECT owner FROM indexing_leases WHERE entity_id=?').get(id) as
      { owner: string } | undefined;
    return row ? JSON.parse(row.owner) : undefined;
  }
  takeLease(
    id: string,
    candidate: { pid: number; token: string; endpoint: string; protocol: number }
  ): typeof candidate {
    return this.db
      .transaction(() => {
        if (!id.startsWith('workspace:')) {
          const view = this.db
            .prepare('SELECT state,active FROM repositories WHERE id=?')
            .get(id) as { state: string; active: number } | undefined;
          if (!view || view.state === 'deleting' || !view.active)
            throw new Error(
              `View ${id} is deleted, inactive, or being cleaned up. Refresh repository selection.`
            );
        }
        const current = this.lease(id);
        if (current && alive(current.pid)) return current;
        this.db
          .prepare(
            'INSERT INTO indexing_leases VALUES (?,?) ON CONFLICT(entity_id) DO UPDATE SET owner=excluded.owner'
          )
          .run(id, JSON.stringify(candidate));
        return candidate;
      })
      .immediate();
  }
  releaseLease(id: string, token: string): void {
    this.db
      .prepare("DELETE FROM indexing_leases WHERE entity_id=? AND json_extract(owner,'$.token')=?")
      .run(id, token);
  }
  private migrateRegistry(): void {
    if (
      !this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='legacy_repositories'")
        .get()
    )
      return;
    if (this.db.prepare("SELECT value FROM registry_metadata WHERE key='groups_migrated'").get())
      return;
    const rows = this.db.prepare('SELECT * FROM legacy_repositories').all() as {
      id: string;
      name: string;
      root_path: string;
      db_path: string;
      generation: number;
      last_success: number | null;
      last_error: string | null;
      config_fingerprint: string | null;
    }[];
    for (const row of rows) {
      const migrated = this.db
        .prepare('SELECT project_id FROM repositories WHERE id=?')
        .get(row.id) as { project_id: string } | undefined;
      if (migrated) {
        const memberships = this.db
          .prepare('SELECT workspace_id FROM legacy_memberships WHERE repo_id=?')
          .all(row.id) as { workspace_id: string }[];
        for (const member of memberships)
          this.db
            .prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)')
            .run(member.workspace_id, migrated.project_id);
        continue;
      }
      this.assertLegacyStopped(row.db_path);
      let discovery: DiscoveredProject;
      try {
        discovery = discoverProject(row.root_path);
      } catch {
        discovery = {
          rootPath: row.root_path,
          commonDir: null,
          worktrees: [
            {
              rootPath: row.root_path,
              gitDir: null,
              commonDir: null,
              branch: null,
              head: null,
              locked: false,
              prunable: false,
              available: false
            }
          ]
        };
      }
      const registered = this.upsertDiscovery(discovery, row.name, {
        id: row.id,
        root: row.root_path,
        dbPath: row.db_path
      });
      const primary = registered.find((v) => v.repoId === row.id) ?? registered[0];
      for (const source of registered)
        if (source.state === 'registering')
          this.finishRegistration(source, source.repoId === row.id ? row.db_path : undefined);
      this.db
        .prepare(
          'UPDATE repositories SET generation=?,last_success=?,last_error=?,config_fingerprint=? WHERE id=?'
        )
        .run(
          row.generation,
          row.last_success,
          row.last_error,
          row.config_fingerprint,
          primary.repoId
        );
      const memberships = this.db
        .prepare('SELECT workspace_id FROM legacy_memberships WHERE repo_id=?')
        .all(row.id) as { workspace_id: string }[];
      for (const member of memberships)
        this.db
          .prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)')
          .run(member.workspace_id, primary.projectId);
    }
    this.db
      .prepare("INSERT OR REPLACE INTO registry_metadata VALUES ('groups_migrated','1')")
      .run();
  }
  private importLegacy(): void {
    if (this.db.prepare("SELECT value FROM registry_metadata WHERE key='legacy_imported'").get())
      return;
    const file = path.join(this.home, 'workspaces.json');
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { repos?: string[] }>;
    if (!fs.existsSync(file + '.backup'))
      writePrivateStateFile(file + '.backup', fs.readFileSync(file, 'utf8'));
    for (const [name, config] of Object.entries(data)) {
      const ws = this.ensureWorkspace(name);
      for (const input of config.repos ?? []) {
        try {
          this.register(input, { workspace: ws.id });
        } catch (error) {
          if (fs.existsSync(input)) throw error;
          const root = path.resolve(input);
          let display = path.basename(root);
          if (this.projects().some((p) => p.name === display))
            display += '-' + crypto.randomUUID().slice(0, 8);
          const sources = this.upsertDiscovery(
            {
              rootPath: root,
              commonDir: null,
              worktrees: [
                {
                  rootPath: root,
                  gitDir: null,
                  commonDir: null,
                  branch: null,
                  head: null,
                  locked: false,
                  prunable: false,
                  available: false
                }
              ]
            },
            display
          );
          this.db
            .prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)')
            .run(ws.id, sources[0].projectId);
        }
      }
    }
    this.db
      .prepare("INSERT OR REPLACE INTO registry_metadata VALUES ('legacy_imported','1')")
      .run();
    this.touch();
  }
}
