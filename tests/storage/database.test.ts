import { describe, it, expect, vi } from 'vitest';
import { DB } from '../../src/core/storage/database.js';
import os from 'os';

describe('database', () => {
  it('should initialize an in-memory database', () => {
    const db = new DB(':memory:');
    const instance = db.getInstance();
    expect(instance).toBeDefined();

    // Check if schema was applied
    const tables = instance.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
      name: string;
    }[];
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toContain('files');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('relationships');
    expect(tableNames).toContain('chunks_fts');
    expect(tableNames).toContain('chunk_embeddings');

    const version = instance
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get() as { version: number };
    expect(version.version).toBe(6);

    const cols = (instance.prepare('PRAGMA table_info(chunks)').all() as { name: string }[]).map(
      (column) => column.name
    );
    expect(cols).toContain('start_line');
    expect(cols).toContain('end_line');
    expect(cols).toContain('file_stem');
  });

  it('should resolve hierarchical databases', () => {
    // resolveDatabases returns an array, fallback to global or local
    const dbs = DB.resolveDatabases(os.tmpdir());
    expect(dbs.length).toBeGreaterThanOrEqual(1);
    for (const db of dbs) db.close();
  });

  it('should gracefully handle unopenable local databases', () => {
    const fs = require('fs');
    const path = require('path');

    const tmpdir = os.tmpdir();
    const badPath = path.join(tmpdir, '.contextos', 'index.db');

    // Ensure it's a directory
    fs.rmSync(badPath, { force: true, recursive: true });
    fs.mkdirSync(badPath, { recursive: true });

    // Should not throw, should just log and continue
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolvedDbs = DB.resolveDatabases(tmpdir);
    expect(consoleSpy).toHaveBeenCalled();
    for (const db of resolvedDbs) db.close();

    // Cleanup
    consoleSpy.mockRestore();
    fs.rmSync(badPath, { force: true, recursive: true });
  });
});
