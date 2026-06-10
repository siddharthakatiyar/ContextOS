import { describe, it, expect } from 'vitest';
import { DB } from '../../src/core/storage/database.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('database', () => {
  it('should initialize an in-memory database', () => {
    const db = new DB(':memory:');
    const instance = db.getInstance();
    expect(instance).toBeDefined();
    
    // Check if schema was applied
    const tables = instance.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[];
    const tableNames = tables.map(t => t.name);
    
    expect(tableNames).toContain('files');
    expect(tableNames).toContain('chunks');
    expect(tableNames).toContain('relationships');
    expect(tableNames).toContain('chunks_fts');
  });

  it('should resolve hierarchical databases', () => {
    // resolveDatabases returns an array, fallback to global or local
    const dbs = DB.resolveDatabases(os.tmpdir());
    expect(dbs.length).toBeGreaterThanOrEqual(1);
  });
});
