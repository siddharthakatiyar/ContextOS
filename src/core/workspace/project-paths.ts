import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Read-only discovery for configuration/doctor; never initializes a project. */
export function registeredProjectPaths(
  root: string,
  homeDirectory = os.homedir()
): { dbPath: string; projectDir: string; rootPath: string } | undefined {
  const file = path.join(homeDirectory, '.contextos', 'registry.db');
  if (!fs.existsSync(file)) return undefined;
  let db: Database.Database | undefined;
  try {
    let canonical = path.resolve(root);
    try {
      canonical = fs.realpathSync(canonical);
    } catch {
      /* Missing roots are not initialized here. */
    }
    db = new Database(file, { readonly: true });
    const columns = db.prepare('PRAGMA table_info(repositories)').all() as { name: string }[];
    const rows = db
      .prepare(
        `SELECT root_path, db_path FROM repositories${columns.some((c) => c.name === 'active') ? ' WHERE active=1' : ''}`
      )
      .all() as { root_path: string; db_path: string }[];
    const match = rows
      .filter(
        (row) => canonical === row.root_path || canonical.startsWith(row.root_path + path.sep)
      )
      .sort((a, b) => b.root_path.length - a.root_path.length)[0];
    if (!match) return undefined;
    return {
      dbPath: match.db_path,
      projectDir: path.dirname(path.dirname(path.dirname(match.db_path))),
      rootPath: match.root_path
    };
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}
