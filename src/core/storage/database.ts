import Database from 'better-sqlite3';
import { loadConfig } from '../../config/index.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { SCHEMA_SQL, applyMigrations } from './schema.js';

export function getContextOSHome(): string {
  return path.join(os.homedir(), '.contextos');
}

/**
 * Apply connection PRAGMAs for durability/perf. Shared by the primary-open and
 * corruption-recovery paths. `busy_timeout` follows config.busyTimeout (default
 * 5000); the perf PRAGMAs (synchronous=NORMAL, larger page cache, mmap, in-memory
 * temp store) are safe for an ephemeral, self-healing index DB.
 */
function applyConnectionPragmas(db: Database.Database): void {
  let busyTimeout = 5000;
  try {
    busyTimeout = Math.max(0, Math.floor(Number(loadConfig().busyTimeout ?? 5000)));
  } catch {
    // config not loadable this early — keep the default
  }
  db.pragma('journal_mode = WAL');
  db.pragma(`busy_timeout = ${busyTimeout}`);
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // ~64MB page cache
  db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O
  db.pragma('temp_store = MEMORY');
}

export class DB {
  private db: Database.Database;

  constructor(dbPath?: string) {
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
    let dbInstance: Database.Database | undefined;

    try {
      dbInstance = new Database(resolvedPath);
      applyConnectionPragmas(dbInstance);

      // 1. Validate B-Tree structure (faster than integrity_check)
      const check = dbInstance.pragma('quick_check') as { quick_check: string }[];
      if (!check || check.length === 0 || check[0].quick_check !== 'ok') {
        throw new Error('DatabaseCorruptedError: quick_check failed');
      }

      this.db = dbInstance;
      // 2. Run migrations
      this.runMigrations();
    } catch (err: any) {
      // If corruption is detected either by quick_check, a SQLITE_CORRUPT error, or "file is not a database"
      if (
        err.message.includes('corrupt') ||
        err.message.includes('DatabaseCorruptedError') ||
        err.message.includes('file is not a database')
      ) {
        console.error(
          `[ContextOS] Database corruption detected at ${resolvedPath}. Auto-recovering...`
        );
        if (dbInstance) {
          try {
            dbInstance.close();
          } catch {}
        }

        // Delete all DB files to start fresh
        if (fs.existsSync(resolvedPath)) fs.unlinkSync(resolvedPath);
        if (fs.existsSync(resolvedPath + '-wal')) fs.unlinkSync(resolvedPath + '-wal');
        if (fs.existsSync(resolvedPath + '-shm')) fs.unlinkSync(resolvedPath + '-shm');

        // Re-init
        this.db = new Database(resolvedPath);
        applyConnectionPragmas(this.db);

        // Re-run migrations
        this.runMigrations();
      } else {
        throw err;
      }
    }
  }

  private runMigrations() {
    try {
      applyMigrations(this.db);
    } catch (e: any) {
      console.error(`Error executing schema migrations: ${e.message}`);
      // Re-throw so the constructor can catch SQLITE_CORRUPT and recover
      throw e;
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
    try {
      dbs.push(new DB(localDbPath));
    } catch (e: any) {
      console.error(`Failed to open local DB at ${localDbPath}: ${e.message}`);
    }

    // 2. Add global DB if it exists and is different from local
    const globalDbPath = path.join(getContextOSHome(), 'index.db');
    if (fs.existsSync(globalDbPath) && globalDbPath !== localDbPath) {
      try {
        dbs.push(new DB(globalDbPath));
      } catch (e: any) {
        console.error(`Failed to open global DB at ${globalDbPath}: ${e.message}`);
      }
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
