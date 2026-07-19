import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Indexer } from '../../src/core/indexer/index.js';
import { DB } from '../../src/core/storage/database.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadConfig } from '../../src/config/index.js';

vi.mock('../../src/core/embeddings/index.js', () => ({
  isEmbeddingsAvailable: () => false,
  ensureEmbeddingsLoaded: async () => {},
  embedChunks: async () => {},
}));

describe('Indexer', () => {
  let tmpdir: string;
  let dbPath: string;
  let db: DB;
  let indexer: Indexer;

  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-indexer-'));
    dbPath = path.join(tmpdir, '.contextos', 'index.db');
    fs.mkdirSync(path.join(tmpdir, '.contextos'), { recursive: true });
    
    // We create a DB manually so it doesn't fail trying to resolve workspace DBs
    db = new DB(dbPath);
    
    // Create an Indexer
    indexer = new Indexer(db);
  });

  afterEach(() => {
    try { db.close(); } catch {}
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  describe('indexFile', () => {
    it('skips symlinks', async () => {
      const target = path.join(tmpdir, 'target.txt');
      const symlink = path.join(tmpdir, 'symlink.txt');
      fs.writeFileSync(target, 'hello');
      try {
        fs.symlinkSync(target, symlink);
      } catch (e) {
        return;
      }
      
      const result = await indexer.indexFile(symlink, 'repo');
      expect(result.filesProcessed).toBe(0);
    });

    it('skips binary files', async () => {
      const binFile = path.join(tmpdir, 'app.exe');
      const buf = Buffer.alloc(8192);
      buf.fill(0);
      fs.writeFileSync(binFile, buf);
      
      const result = await indexer.indexFile(binFile, 'repo');
      expect(result.filesProcessed).toBe(0);
    });

    it('skips generated files', async () => {
      const genFile = path.join(tmpdir, 'package-lock.json');
      fs.writeFileSync(genFile, '{}');
      
      const result = await indexer.indexFile(genFile, 'repo');
      expect(result.filesProcessed).toBe(0);
    });

    it('skips unchanged files (hash match)', async () => {
      const file = path.join(tmpdir, 'test.ts');
      fs.writeFileSync(file, 'const a = 1;');
      
      const result1 = await indexer.indexFile(file, 'repo');
      expect(result1.filesProcessed).toBe(1);
      
      const result2 = await indexer.indexFile(file, 'repo');
      expect(result2.filesProcessed).toBe(0);
    });

    it('processes and chunks valid source files', async () => {
      const file = path.join(tmpdir, 'code.ts');
      fs.writeFileSync(file, 'export function add(a: number, b: number) { return a + b; }');
      
      const result = await indexer.indexFile(file, 'repo');
      expect(result.filesProcessed).toBe(1);
      
      const chunks = db.getInstance().prepare('SELECT * FROM chunks WHERE source_file = ?').all(file);
      expect(chunks.length).toBeGreaterThan(0);
    });
  });
});
