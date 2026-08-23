import { describe, it, expect } from 'vitest';
import { DB, isCorruptionMessage } from '../../src/core/storage/database.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Database Auto-Recovery', () => {
  it('detects corruption and auto-recreates the database', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-dbrecovery-'));
    const dbPath = path.join(tmpdir, '.contextos', 'index.db');
    fs.mkdirSync(path.join(tmpdir, '.contextos'), { recursive: true });

    // 1. Create a valid DB
    const db = new DB(dbPath);
    // Write something to ensure it's initialized
    db.getInstance().exec('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY);');
    db.close();

    // 2. Corrupt the DB file by writing garbage over the header
    const fd = fs.openSync(dbPath, 'r+');
    const garbage = Buffer.alloc(100, 'x'); // Writes 'x' characters over the SQLite header
    fs.writeSync(fd, garbage, 0, garbage.length, 0);
    fs.closeSync(fd);

    // 3. Attempt to instantiate the DB again
    // This should trigger the `quick_check` or a native SQLite Error which we catch and auto-recover
    let recoveredDb: DB | undefined;
    expect(() => {
      recoveredDb = new DB(dbPath);
    }).not.toThrow();

    // 4. Verify it actually recovered by checking schema tables
    expect(recoveredDb).toBeDefined();
    if (recoveredDb) {
      const tables = recoveredDb
        .getInstance()
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      // Should contain the standard contextOS schema tables like 'chunks', 'files', etc.
      expect(tables.some((t) => t.name === 'chunks')).toBe(true);
      recoveredDb.close();
    }

    // Cleanup
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it('recognizes SQLite malformed-image errors as corruption', () => {
    // Regression: mid-operation corruption surfaces as "database disk image is
    // malformed", which the old substring list missed entirely.
    expect(isCorruptionMessage('database disk image is malformed')).toBe(true);
    expect(isCorruptionMessage('file is not a database')).toBe(true);
    expect(isCorruptionMessage('SQLiteCorruptException: corrupted page')).toBe(true);
    expect(isCorruptionMessage('some unrelated failure')).toBe(false);
  });

  it('refuses destructive recovery while a live daemon holds the database', () => {
    const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-dblive-'));
    const ctxDir = path.join(tmpdir, '.contextos');
    const dbPath = path.join(ctxDir, 'index.db');
    fs.mkdirSync(ctxDir, { recursive: true });

    new DB(dbPath).close();

    const corrupt = () => {
      const fd = fs.openSync(dbPath, 'r+');
      fs.writeSync(fd, Buffer.alloc(100, 'x'), 0, 100, 0);
      fs.closeSync(fd);
    };

    // Simulate a live daemon via its PID file (our own PID is provably alive)
    fs.writeFileSync(path.join(ctxDir, 'daemon.pid'), String(process.pid));
    corrupt();
    expect(() => new DB(dbPath)).toThrow();

    // With the daemon gone (stale PID), recovery proceeds again
    fs.writeFileSync(path.join(ctxDir, 'daemon.pid'), String(999_999_999));
    let recovered: DB | undefined;
    expect(() => {
      recovered = new DB(dbPath);
    }).not.toThrow();
    recovered?.close();

    fs.rmSync(tmpdir, { recursive: true, force: true });
  });
});
