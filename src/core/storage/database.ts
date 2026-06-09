import Database from 'better-sqlite3';
import { loadConfig } from '../../config/index.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SCHEMA_SQL, applyMigrations } from './schema.js';

export function getContextOSHome(): string {
  return path.join(os.homedir(), '.contextos');
}

export class DB {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const config = loadConfig();
    let resolvedPath = dbPath;
    if (!resolvedPath) {
      // Per-project isolation: use .contextos/index.db in current working directory
      const localDbPath = path.join(process.cwd(), '.contextos', 'index.db');
      resolvedPath = localDbPath;
    }
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  private runMigrations() {
    try {
      applyMigrations(this.db);
    } catch (e: any) {
      console.error(`Error executing schema migrations: ${e.message}`);
    }
  }

  public getInstance(): Database.Database {
    return this.db;
  }

  /**
   * Resolves all databases in the hierarchy from startDir up to root,
   * plus the global database. Returns an array of DB instances.
   */
  public static resolveDatabases(startDir: string = process.cwd()): DB[] {
    const dbs: DB[] = [];
    const config = loadConfig();
    
    // Find up to root
    let currentDir = startDir;
    while (true) {
      const maybeDb = path.join(currentDir, '.contextos', 'index.db');
      if (fs.existsSync(maybeDb)) {
        dbs.push(new DB(maybeDb));
      }
      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) break; // reached root
      currentDir = parentDir;
    }

    // Add global db if it's not already in the list
    const globalDbPath = path.join(getContextOSHome(), 'index.db');
    if (fs.existsSync(globalDbPath)) {
      if (!dbs.some(db => db.db.name === globalDbPath)) {
        dbs.push(new DB(globalDbPath));
      }
    } else {
      // If no local DBs and no global DB, just initialize the local one
      if (dbs.length === 0) {
        dbs.push(new DB());
      }
    }

    return dbs;
  }
}
