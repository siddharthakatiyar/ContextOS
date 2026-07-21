import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import fs from 'fs';
import os from 'os';

describe('Path Traversal Guard', () => {
  let db: DB;
  let indexer: Indexer;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-'));
    db = new DB(path.join(tempDir, 'test.db'));
    indexer = new Indexer(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects files outside the specified workspace root', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot);

    // Create a file outside the workspace root (e.g. escaping the boundary)
    const secretFilePath = path.join(tempDir, 'secret.txt');
    fs.writeFileSync(secretFilePath, 'secret data');

    // Attempt to index it passing the workspaceRoot as the boundary
    await expect(indexer.indexFile(secretFilePath, 'workspace', workspaceRoot)).rejects.toThrow(
      /Path traversal blocked/
    );
  });

  it('allows files inside the specified workspace root', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot);

    const safeFilePath = path.join(workspaceRoot, 'safe.txt');
    fs.writeFileSync(safeFilePath, 'safe data');

    const stats = await indexer.indexFile(safeFilePath, 'workspace', workspaceRoot);
    expect(stats.filesProcessed).toBe(1);
    expect(stats.chunksCreated).toBeGreaterThan(0);
  });
});
