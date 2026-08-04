import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { BackgroundIndexer } from '../../src/core/daemon/background-indexer.js';
import { DB } from '../../src/core/storage/database.js';

describe('BackgroundIndexer', () => {
  let tempDir: string;
  let db: DB;
  let previousEmbeddings: string | undefined;

  beforeAll(() => {
    previousEmbeddings = process.env.CONTEXTOS_EMBEDDINGS;
    process.env.CONTEXTOS_EMBEDDINGS = '0';
    tempDir = path.join(process.cwd(), 'tests', 'fixtures', 'temp_background');
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(tempDir, { recursive: true });

    // Create a few dummy files
    fs.writeFileSync(path.join(tempDir, 'file1.ts'), 'export const a = 1;');
    fs.writeFileSync(
      path.join(tempDir, 'file2.ts'),
      'import { a } from "./file1"; console.log(a);'
    );

    // Create context dir
    fs.mkdirSync(path.join(tempDir, '.contextos'), { recursive: true });

    db = new DB(path.join(tempDir, '.contextos', 'index.db'));
  });

  afterAll(() => {
    try {
      db.close();
    } catch {}
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousEmbeddings === undefined) delete process.env.CONTEXTOS_EMBEDDINGS;
    else process.env.CONTEXTOS_EMBEDDINGS = previousEmbeddings;
  });

  test('indexes repository in background', async () => {
    const indexer = new BackgroundIndexer(db, tempDir);

    const config = {
      indexablePatterns: ['**/*.ts'],
      ignorePatterns: []
    };

    const indexPromise = indexer.startFullIndex(config);

    // Status should immediately show it is indexing
    let status = indexer.getStatus();
    expect(status.isIndexing).toBe(true);

    await indexPromise;

    // Status should show complete
    status = indexer.getStatus();
    expect(status.isIndexing).toBe(false);
    expect(status.totalFiles).toBe(2);
    expect(status.processedFiles).toBe(2);

    // Should have written to status.json
    const statusFile = path.join(tempDir, '.contextos', 'status.json');
    expect(fs.existsSync(statusFile)).toBe(true);
    const savedStatus = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    expect(savedStatus.fullIndexCompleted).toBe(true);

    // Database should be populated
    const fileCount = (
      db.getInstance().prepare('SELECT count(*) as c FROM files').get() as { c: number }
    ).c;
    expect(fileCount).toBeGreaterThan(0);
  });
});
