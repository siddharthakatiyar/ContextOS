import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DB, getContextOSHome } from '../storage/database.js';
import { bindRepository } from './identity.js';
import {
  canonicalDirectory,
  preparePrivateStateFile,
  tightenPrivateStateFile,
  writePrivateStateFile
} from '../../utils/secure-state.js';

export interface RepositorySource {
  repoId: string;
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
export interface ScopeSelectors {
  repo?: string[];
  workspace?: string;
  allRepos?: boolean;
}
export interface RetrievalScope {
  workspaceId?: string;
  repoIds: string[];
  activeRepoId?: string;
  sources: RepositorySource[];
}

type RepoRow = {
  id: string;
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

export class WorkspaceRegistry {
  private db: Database.Database;
  constructor(home = getContextOSHome()) {
    const file = preparePrivateStateFile(path.join(home, 'registry.db'));
    this.db = new Database(file);
    tightenPrivateStateFile(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repositories (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, root_path TEXT NOT NULL UNIQUE,
        db_path TEXT NOT NULL UNIQUE, state TEXT NOT NULL DEFAULT 'registered',
        generation INTEGER NOT NULL DEFAULT 0, last_success INTEGER, last_error TEXT,
        config_fingerprint TEXT, indexer_version INTEGER, progress TEXT, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id), repo_id TEXT NOT NULL REFERENCES repositories(id),
        PRIMARY KEY(workspace_id, repo_id));
      CREATE TABLE IF NOT EXISTS indexing_leases (entity_id TEXT PRIMARY KEY, owner TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registry_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT OR IGNORE INTO registry_metadata VALUES ('revision', '0');
    `);
    this.ensureWorkspace('default');
    this.importLegacy(home);
    for (const repo of this.listAll().filter((r) => r.state === 'registering'))
      this.finishRegistration(repo);
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
      .prepare(
        "UPDATE registry_metadata SET value = CAST(value AS INTEGER) + 1 WHERE key='revision'"
      )
      .run();
  }
  ensureWorkspace(name: string): Workspace {
    if (!name.trim() || name.includes('/') || name.includes('\\'))
      throw new Error('Workspace name must be a nonempty label.');
    this.db
      .prepare('INSERT OR IGNORE INTO workspaces VALUES (?, ?, ?)')
      .run(crypto.randomUUID(), name, Date.now());
    return this.workspace(name);
  }
  workspace(name: string): Workspace {
    const row = this.db
      .prepare('SELECT id, name FROM workspaces WHERE name = ? OR id = ?')
      .get(name, name) as Workspace | undefined;
    if (!row) throw new Error(`Unknown workspace: ${name}`);
    return row;
  }
  workspaces(): Workspace[] {
    return this.db.prepare('SELECT id, name FROM workspaces ORDER BY name').all() as Workspace[];
  }
  listAll(): RepositorySource[] {
    return (this.db.prepare('SELECT * FROM repositories ORDER BY name').all() as RepoRow[]).map(
      mapRepo
    );
  }
  list(workspace = 'default'): RepositorySource[] {
    return (
      this.db
        .prepare(
          `SELECT r.* FROM repositories r JOIN memberships m ON r.id=m.repo_id
      WHERE m.workspace_id=? ORDER BY r.name`
        )
        .all(this.workspace(workspace).id) as RepoRow[]
    ).map(mapRepo);
  }
  resolve(selector: string): RepositorySource {
    let root = path.resolve(selector);
    try {
      root = fs.realpathSync(root);
    } catch {
      /* unavailable registered paths remain selectable */
    }
    const row = this.db
      .prepare('SELECT * FROM repositories WHERE id=? OR name=? OR root_path=?')
      .get(selector, selector, root) as RepoRow | undefined;
    if (!row) throw new Error(`Unknown repository: ${selector}`);
    return mapRepo(row);
  }
  active(cwd: string): RepositorySource | undefined {
    let root = path.resolve(cwd);
    try {
      root = fs.realpathSync(root);
    } catch {
      /* retain lexical path */
    }
    return this.listAll()
      .filter((r) => root === r.rootPath || root.startsWith(r.rootPath + path.sep))
      .sort((a, b) => b.rootPath.length - a.rootPath.length)[0];
  }
  register(input: string, opts: { name?: string; workspace?: string } = {}): RepositorySource {
    const root = canonicalDirectory(input);
    const ws = this.workspace(opts.workspace ?? 'default');
    const repo = this.db
      .transaction(() => {
        let existing = this.db.prepare('SELECT * FROM repositories WHERE root_path=?').get(root) as
          RepoRow | undefined;
        if (!existing) {
          const dbPath = path.join(root, '.contextos', 'index.db');
          let id: string = crypto.randomUUID();
          if (fs.existsSync(dbPath)) {
            // Inspect identity without migrating or changing a database under an existing owner.
            const local = new Database(preparePrivateStateFile(dbPath), { readonly: true });
            try {
              if (
                local
                  .prepare("SELECT name FROM sqlite_master WHERE name='repository_metadata'")
                  .get()
              ) {
                const saved = local
                  .prepare("SELECT value FROM repository_metadata WHERE key='repo_id'")
                  .get() as { value: string } | undefined;
                if (
                  saved &&
                  !this.db.prepare('SELECT id FROM repositories WHERE id=?').get(saved.value)
                )
                  id = saved.value;
              }
            } finally {
              local.close();
            }
          }
          const name = opts.name ?? path.basename(root);
          if (
            !name.trim() ||
            this.db.prepare('SELECT id FROM repositories WHERE name=?').get(name)
          ) {
            throw new Error(
              `Repository name already exists or is empty: ${name}. Use --name <unique-name>.`
            );
          }
          this.db
            .prepare(
              `INSERT INTO repositories (id,name,root_path,db_path,state,created_at)
          VALUES (?,?,?,?, 'registering', ?)`
            )
            .run(id, name, root, dbPath, Date.now());
          existing = this.db.prepare('SELECT * FROM repositories WHERE id=?').get(id) as RepoRow;
        }
        this.db.prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)').run(ws.id, existing.id);
        this.touch();
        return mapRepo(existing);
      })
      .immediate();
    this.finishRegistration(repo);
    return this.resolve(repo.repoId);
  }
  private finishRegistration(repo: RepositorySource): void {
    if (!fs.existsSync(repo.rootPath)) {
      this.update(repo.repoId, {
        state: 'unavailable',
        lastError: 'Repository path is unavailable'
      });
      return;
    }
    const db = new DB(repo.dbPath);
    try {
      bindRepository(db.getInstance(), repo.repoId, repo.rootPath);
    } finally {
      db.close();
    }
    if (repo.state === 'registering')
      this.update(repo.repoId, { state: 'registered', lastError: null });
  }
  remove(selector: string, workspace = 'default'): void {
    const repo = this.resolve(selector);
    this.db.transaction(() => {
      const result = this.db
        .prepare('DELETE FROM memberships WHERE workspace_id=? AND repo_id=?')
        .run(this.workspace(workspace).id, repo.repoId);
      if (!result.changes)
        throw new Error(`${repo.name} is not a member of workspace ${workspace}`);
      this.touch();
    })();
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
      })) {
        if (key in values) columns.push([column, values[key as keyof typeof values]]);
      }
      if (values.progress !== undefined)
        columns.push(['progress', JSON.stringify(values.progress)]);
      if (columns.length)
        this.db
          .prepare(
            `UPDATE repositories SET ${columns.map(([key]) => `${key}=?`).join(',')} WHERE id=?`
          )
          .run(...columns.map(([, value]) => value), id);
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
    if (selectors.repo?.length && selectors.allRepos)
      throw new Error('--repo and --all-repos cannot be combined.');
    const active = activeRepoId ? this.resolve(activeRepoId) : this.active(cwd);
    let workspace: Workspace | undefined;
    let sources: RepositorySource[];
    if (selectors.workspace || selectors.allRepos) {
      workspace = this.workspace(selectors.workspace ?? defaultWorkspace ?? 'default');
      sources = this.list(workspace.id);
    } else sources = [];
    if (selectors.repo?.length) {
      const selected = [...new Set(selectors.repo)].map((r) => this.resolve(r));
      const boundWorkspace = selectors.workspace
        ? workspace
        : defaultWorkspace
          ? this.workspace(defaultWorkspace)
          : undefined;
      if (boundWorkspace) {
        const members = new Set(this.list(boundWorkspace.id).map((r) => r.repoId));
        if (selected.some((r) => !members.has(r.repoId)))
          throw new Error('Selected repository is outside the workspace.');
        workspace = boundWorkspace;
      }
      sources = selected;
    } else if (!selectors.workspace && !selectors.allRepos) {
      if (!active)
        throw new Error('No active repository. Select --repo, --workspace, or --all-repos.');
      sources = [active];
    }
    if (!sources.length)
      throw new Error('The selected workspace has no repositories. Use contextos repo add <path>.');
    return {
      workspaceId: workspace?.id,
      repoIds: sources.map((r) => r.repoId),
      activeRepoId: active?.repoId,
      sources
    };
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
        const current = this.lease(id);
        if (current) {
          let occupied = true;
          try {
            process.kill(current.pid, 0);
          } catch (error) {
            occupied = (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
          if (occupied) return current;
        }
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
  private importLegacy(home: string): void {
    if (this.db.prepare("SELECT value FROM registry_metadata WHERE key='legacy_imported'").get())
      return;
    const file = path.join(home, 'workspaces.json');
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { repos?: string[] }>;
    if (!fs.existsSync(file + '.backup'))
      writePrivateStateFile(file + '.backup', fs.readFileSync(file, 'utf8'));
    this.db.transaction(() => {
      for (const [name, config] of Object.entries(data)) {
        const ws = this.ensureWorkspace(name);
        for (const input of config.repos ?? []) {
          let root = path.resolve(input);
          try {
            root = canonicalDirectory(root);
          } catch {
            /* retain missing registration */
          }
          let row = this.db.prepare('SELECT id FROM repositories WHERE root_path=?').get(root) as
            { id: string } | undefined;
          if (!row) {
            row = { id: crypto.randomUUID() };
            let name = path.basename(root);
            if (this.db.prepare('SELECT id FROM repositories WHERE name=?').get(name))
              name += '-' + row.id.slice(0, 8);
            this.db
              .prepare(
                `INSERT INTO repositories (id,name,root_path,db_path,state,created_at)
              VALUES (?,?,?,?,?,?)`
              )
              .run(
                row.id,
                name,
                root,
                path.join(root, '.contextos', 'index.db'),
                fs.existsSync(root) ? 'registering' : 'unavailable',
                Date.now()
              );
          }
          this.db.prepare('INSERT OR IGNORE INTO memberships VALUES (?,?)').run(ws.id, row.id);
        }
      }
      this.db.prepare("INSERT INTO registry_metadata VALUES ('legacy_imported','1')").run();
      this.touch();
    })();
  }
}
