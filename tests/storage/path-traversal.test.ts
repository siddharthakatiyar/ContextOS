import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import fs from 'fs';
import os from 'os';

describe('Path Traversal Guard', () => {
  let db: DB;
  let tempDir: string;
  let previousEmbeddings: string | undefined;

  beforeEach(() => {
    previousEmbeddings = process.env.CONTEXTOS_EMBEDDINGS;
    process.env.CONTEXTOS_EMBEDDINGS = '0';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-'));
    db = new DB(path.join(tempDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousEmbeddings === undefined) delete process.env.CONTEXTOS_EMBEDDINGS;
    else process.env.CONTEXTOS_EMBEDDINGS = previousEmbeddings;
  });

  it('rejects files outside the specified workspace root', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot);

    // Create a file outside the workspace root (e.g. escaping the boundary)
    const secretFilePath = path.join(tempDir, 'secret.txt');
    fs.writeFileSync(secretFilePath, 'secret data');

    // A workspace label is metadata; the configured repository root remains
    // the filesystem boundary.
    const workspaceIndexer = new Indexer(db, workspaceRoot);
    await expect(workspaceIndexer.indexFile(secretFilePath, 'workspace', 'team-a')).rejects.toThrow(
      /Path traversal blocked/
    );
  });

  it('allows files inside the specified workspace root', async () => {
    const workspaceRoot = path.join(tempDir, 'workspace');
    fs.mkdirSync(workspaceRoot);

    const safeFilePath = path.join(workspaceRoot, 'safe.txt');
    fs.writeFileSync(safeFilePath, 'safe data');

    const workspaceIndexer = new Indexer(db, workspaceRoot);
    const stats = await workspaceIndexer.indexFile(safeFilePath, 'workspace', 'team-a');
    expect(stats.filesProcessed).toBe(1);
    expect(stats.chunksCreated).toBeGreaterThan(0);
    const storedWorkspace = (
      db
        .getInstance()
        .prepare('SELECT workspace_name FROM files WHERE path = ?')
        .get(safeFilePath) as { workspace_name: string | null } | undefined
    )?.workspace_name;
    expect(storedWorkspace).toBe('team-a');
  });
});
