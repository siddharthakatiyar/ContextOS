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
    // Skip integrity check on startup as it blocks the thread for minutes on large DBs
    this.runMigrations();
  }

  private runMigrations() {
    try {
      applyMigrations(this.db);
    } catch (e: any) {
      console.error(`Error executing schema migrations: ${e.message}`);
      // In a severe locked state, don't crash the server, but log it
    }
  }

  public getInstance(): Database.Database {
    return this.db;
  }

  /**
   * Close the database connection and release all file descriptors.
   */
  public close(): void {
    try {
      if (this.db.open) {
        // Ensure WAL file is checkpointed so it doesn't grow indefinitely
        // TRUNCATE mode commits transactions and truncates the WAL file to zero bytes
        try {
          this.db.pragma('wal_checkpoint(TRUNCATE)');
        } catch (e) {
          // ignore checkpoint errors on close
        }
        this.db.close();
      }
    } catch {
      // ignore close errors
    }
  }

  /**
   * Resolves databases for the current project.
   * Only opens the LOCAL project DB + the GLOBAL DB (max 2 connections).
   * 
   * Previously this walked from CWD all the way to filesystem root,
   * opening every .contextos/index.db it found. That caused excessive
   * file descriptor usage when multiple processes were running.
   */
  public static resolveDatabases(startDir: string = process.cwd()): DB[] {
    const dbs: DB[] = [];
    
    // 1. Open the local project DB (CWD)
    const localDbPath = path.join(startDir, '.contextos', 'index.db');
    if (fs.existsSync(localDbPath)) {
      dbs.push(new DB(localDbPath));
    } else {
      // No local DB exists yet — create one
      dbs.push(new DB(localDbPath));
    }

    // 2. Add global DB if it exists and is different from local
    const globalDbPath = path.join(getContextOSHome(), 'index.db');
    if (fs.existsSync(globalDbPath) && globalDbPath !== localDbPath) {
      dbs.push(new DB(globalDbPath));
    }

    return dbs;
  }
}

/**
 * Acquire a PID lockfile for the given project directory.
 * Returns true if we acquired the lock (no other server is running).
 * Returns false if another server process is already alive for this project.
 * Never throws — returns true on any error (allowing the server to start).
 */
export function acquireServerLock(projectDir: string): boolean {
  try {
    // Guard: don't try to write lockfiles to root or invalid paths
    if (!projectDir || projectDir === '/' || projectDir.length < 3) {
      return true;
    }

    const lockPath = path.join(projectDir, '.contextos', 'server.pid');
    const lockDir = path.dirname(lockPath);
    if (!fs.existsSync(lockDir)) {
      fs.mkdirSync(lockDir, { recursive: true });
    }

    // Check if an existing lock exists with a live process
    if (fs.existsSync(lockPath)) {
      try {
        const existingPid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
        if (!isNaN(existingPid)) {
          try {
            // Signal 0 doesn't kill — just checks if process exists
            process.kill(existingPid, 0);
            // Process is still alive — another server is running
            return false;
          } catch {
            // Process is dead — stale lockfile, we can take over
          }
        }
      } catch {
        // Can't read lockfile — overwrite it
      }
    }

    // Write our PID
    fs.writeFileSync(lockPath, String(process.pid));
    return true;
  } catch {
    // If anything fails (permissions, bad path, etc), just allow the server to start
    return true;
  }
}

/**
 * Release the PID lockfile for the given project directory.
 * Never throws.
 */
export function releaseServerLock(projectDir: string): void {
  try {
    if (!projectDir || projectDir === '/' || projectDir.length < 3) return;
    const lockPath = path.join(projectDir, '.contextos', 'server.pid');
    if (fs.existsSync(lockPath)) {
      const pid = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10);
      if (pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // ignore
  }
}
