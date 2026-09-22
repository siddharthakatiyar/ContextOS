import { test, expect, describe, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { BackgroundIndexer } from '../../src/core/daemon/background-indexer.js';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';

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

  test('enforces repository ignore files and reconciles deleted sources', async () => {
    const ignored = path.join(tempDir, 'secret.ts');
    const visible = path.join(tempDir, 'visible.ts');
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-workspace-root-'));
    const workspaceFile = path.join(workspaceDir, 'shared.ts');
    fs.writeFileSync(ignored, 'export const secret = "do not index";');
    fs.writeFileSync(visible, 'export const visible = true;');
    fs.writeFileSync(workspaceFile, 'export const shared = true;');

    try {
      // A full repo scan must only reconcile its own layer. This represents a
      // workspace source rooted elsewhere plus a manually saved fact.
      await new Indexer(db, workspaceDir).indexFile(workspaceFile, 'workspace', 'shared-team');
      const factId = new KnowledgeStore(db).learnFact('preserve this manually recorded fact');

      const indexer = new BackgroundIndexer(db, tempDir);
      const config = { indexablePatterns: ['**/*.ts'], ignorePatterns: [] };
      await indexer.startFullIndex(config);

      const indexedPaths = (
        db.getInstance().prepare('SELECT path FROM files WHERE layer = ?').all('repo') as {
          path: string;
        }[]
      ).map((row) => row.path);
      expect(indexedPaths).toContain(visible);
      expect(indexedPaths).toContain(ignored);

      // Changing the documented ignore policy must reconcile a previously
      // indexed source just like an offline deletion.
      fs.writeFileSync(path.join(tempDir, '.gitignore'), 'secret.ts\n');
      fs.unlinkSync(visible);
      await indexer.startFullIndex(config);
      const afterDelete = (
        db.getInstance().prepare('SELECT path FROM files WHERE layer = ?').all('repo') as {
          path: string;
        }[]
      ).map((row) => row.path);
      expect(afterDelete).not.toContain(visible);
      expect(afterDelete).not.toContain(ignored);

      const workspaceRow = db
        .getInstance()
        .prepare('SELECT workspace_name FROM files WHERE path = ? AND layer = ?')
        .get(workspaceFile, 'workspace') as { workspace_name: string } | undefined;
      expect(workspaceRow?.workspace_name).toBe('shared-team');
      expect(
        (
          db.getInstance().prepare('SELECT id FROM knowledge_facts WHERE id = ?').get(factId) as
            { id: string } | undefined
        )?.id
      ).toBe(factId);
    } finally {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('does not reconcile stale rows when scan setup fails', async () => {
    const stale = path.join(tempDir, 'stale-after-failure.ts');
    fs.writeFileSync(stale, 'export const staleAfterFailure = true;');
    await new Indexer(db, tempDir).indexFile(stale, 'repo');
    fs.unlinkSync(stale);

    const indexer = new BackgroundIndexer(db, tempDir);
    await indexer.startFullIndex({
      // glob rejects a non-string pattern before a scan can complete. The
      // failed run must not treat an empty result as an authoritative scan.
      indexablePatterns: [null as unknown as string],
      ignorePatterns: []
    });

    const retained = db
      .getInstance()
      .prepare('SELECT path FROM files WHERE path = ?')
      .get(stale) as { path: string } | undefined;
    expect(retained?.path).toBe(stale);
  });

  test('uses the canonical root and removes rows replaced by an outside symlink', async () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-canonical-root-'));
    const symlinkRoot = `${realRoot}-link`;
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-outside-root-'));
    const source = path.join(realRoot, 'source.ts');
    const outside = path.join(outsideRoot, 'outside.ts');
    fs.mkdirSync(path.join(realRoot, '.contextos'), { recursive: true });
    fs.writeFileSync(source, 'export const inside = true;');
    fs.writeFileSync(outside, 'export const outside = true;');
    fs.symlinkSync(realRoot, symlinkRoot, 'dir');

    const canonicalDb = new DB(path.join(realRoot, '.contextos', 'index.db'));
    const canonicalSource = fs.realpathSync(source);
    try {
      const indexer = new BackgroundIndexer(canonicalDb, symlinkRoot);
      await indexer.startFullIndex({ indexablePatterns: ['**/*.ts'], ignorePatterns: [] });
      expect(
        (
          canonicalDb.getInstance().prepare('SELECT path FROM files WHERE path = ?').get(source) as
            { path: string } | undefined
        )?.path
      ).toBe(canonicalSource);

      fs.unlinkSync(source);
      fs.symlinkSync(outside, source, 'file');
      await indexer.startFullIndex({ indexablePatterns: ['**/*.ts'], ignorePatterns: [] });
      expect(
        canonicalDb
          .getInstance()
          .prepare('SELECT path FROM files WHERE path = ?')
          .get(canonicalSource)
      ).toBeUndefined();
    } finally {
      canonicalDb.close();
      fs.rmSync(symlinkRoot, { recursive: true, force: true });
      fs.rmSync(realRoot, { recursive: true, force: true });
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test('does not delete a path that has been reassigned to another layer', async () => {
    const shared = path.join(tempDir, 'shared-layer.ts');
    fs.writeFileSync(shared, 'export const sharedLayer = true;');
    const indexer = new Indexer(db, tempDir);
    await indexer.indexFile(shared, 'workspace', 'team-a');

    expect(await indexer.removeFile(shared, 'repo')).toBe(false);
    const retained = db
      .getInstance()
      .prepare('SELECT layer, workspace_name FROM files WHERE path = ?')
      .get(shared) as { layer: string; workspace_name: string } | undefined;
    expect(retained).toEqual({ layer: 'workspace', workspace_name: 'team-a' });

    expect(await indexer.removeFile(shared, 'workspace')).toBe(true);
    expect(
      db.getInstance().prepare('SELECT path FROM files WHERE path = ?').get(shared)
    ).toBeUndefined();
  });
});
