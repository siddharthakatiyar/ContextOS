import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { BackgroundIndexer } from '../../src/core/daemon/background-indexer.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime } from '../../src/core/workspace/runtime.js';
import { collectDoctorReport } from '../../src/cli/commands/doctor.js';
import { statusCommand } from '../../src/cli/commands/status.js';
import { reindexCommand } from '../../src/cli/commands/reindex.js';

const config = { indexablePatterns: ['**/*.ts'], ignorePatterns: [] };
function scratchRoot(): string {
  // Gitignored in-repo fixture root: the indexer skips the OS temp directory.
  const dir = path.resolve('scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

let temporary: string;
let registry: WorkspaceRegistry;
let runtime: WorkspaceRuntime;
let source: ReturnType<WorkspaceRegistry['register']>;
let root: string;
let failures: Set<string>;
let error: Error;
let indexFile: MockInstance<Indexer['indexFile']>;
const originalIndexFile = Indexer.prototype.indexFile;

beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(scratchRoot(), 'partial-index-'));
  vi.stubEnv('GIT_CEILING_DIRECTORIES', temporary);
  root = path.join(temporary, 'project');
  fs.mkdirSync(root);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(temporary, 'home'));
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  registry = new WorkspaceRegistry();
  source = registry.register(root);
  runtime = new WorkspaceRuntime(registry);
  fs.writeFileSync(path.join(root, 'good.ts'), 'export const good = true;');
  fs.writeFileSync(path.join(root, 'bad.ts'), 'export const bad = true;');
  failures = new Set([path.join(root, 'bad.ts')]);
  error = new Error('parser unavailable');
  indexFile = vi.spyOn(Indexer.prototype, 'indexFile').mockImplementation(function (
    this: Indexer,
    ...args
  ) {
    if (failures.has(args[0])) return Promise.reject(error);
    return originalIndexFile.apply(this, args);
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  await runtime.close();
  registry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});
function status() {
  return JSON.parse(fs.readFileSync(path.join(path.dirname(source.dbPath), 'status.json'), 'utf8'));
}

describe('partial indexing', () => {
  it('keeps successful content ready, persists diagnostics and retries only failed files through the CLI', async () => {
    await runtime.get(source).index();
    expect(registry.resolve(source.repoId).state).toBe('ready');
    expect(runtime.get(source).status().files).toBe(1);
    expect(status()).toMatchObject({
      fullIndexCompleted: true,
      partial: true,
      processed: 2,
      total: 2,
      progressPercentage: 100,
      failedFileCount: 1,
      failedFiles: [{ path: path.join(root, 'bad.ts'), error: 'parser unavailable' }]
    });
    const report = await collectDoctorReport({
      cwd: root,
      homeDirectory: path.join(temporary, 'home')
    });
    const check = report.checks.find((item) => item.id === 'index-status');
    expect(check?.status).toBe('warn');
    expect(check?.summary).toContain('bad.ts: parser unavailable');
    expect(check?.details?.failedFileCount).toBe(1);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await statusCommand.parseAsync(['node', 'contextos', '--project', source.projectId]);
    expect(log.mock.calls.flat().join('\n')).toContain('bad.ts: parser unavailable');
    // Leave the owner running to exercise propagation across the request socket.
    failures.clear();
    indexFile.mockClear();
    await reindexCommand.parseAsync([
      'node',
      'contextos',
      '--project',
      source.projectId,
      '--failed'
    ]);
    expect(indexFile.mock.calls.map((call) => call[0])).toEqual([path.join(root, 'bad.ts')]);
    expect(status()).toMatchObject({
      fullIndexCompleted: true,
      partial: false,
      failedFileCount: 0,
      processed: 1,
      total: 1,
      progressPercentage: 100
    });
    expect(runtime.get(source).status().files).toBe(2);
  });

  it('fails when every file fails and permits a failed-files recovery', async () => {
    failures.add(path.join(root, 'good.ts'));
    await expect(runtime.get(source).index()).rejects.toThrow('All 2 file(s) failed');
    expect(registry.resolve(source.repoId).state).toBe('failed');
    expect(status()).toMatchObject({
      fullIndexCompleted: false,
      processed: 2,
      total: 2,
      progressPercentage: 100,
      failedFileCount: 2
    });
    failures.clear();
    await runtime.get(source).request({ action: 'index', force: true, failedOnly: true });
    expect(registry.resolve(source.repoId).state).toBe('ready');
    expect(status().partial).toBe(false);
  });

  it('keeps a partial view ready when a retry still fails', async () => {
    await runtime.get(source).index();
    indexFile.mockClear();
    await runtime.get(source).request({ action: 'index', force: true, failedOnly: true });
    expect(indexFile).toHaveBeenCalledTimes(1);
    expect(status()).toMatchObject({ fullIndexCompleted: true, partial: true, failedFileCount: 1 });
    expect(registry.resolve(source.repoId).state).toBe('ready');
  });

  it('treats SQLite errors as fatal even when other files succeed', async () => {
    error = Object.assign(new Error('disk full'), { code: 'SQLITE_FULL' });
    await expect(runtime.get(source).index()).rejects.toThrow('disk full');
    expect(registry.resolve(source.repoId).state).toBe('failed');
    expect(status().fullIndexCompleted).toBe(false);
    await expect(
      runtime.get(source).request({ action: 'index', force: true, failedOnly: true })
    ).rejects.toThrow('run a full reindex');
  });

  it('caps status diagnostics but retries every failed path and preserves successful rows', async () => {
    for (let i = 0; i < 105; i++) {
      const file = path.join(root, `bad-${i}.ts`);
      fs.writeFileSync(file, 'export const value = 1;');
      failures.add(file);
    }
    await runtime.get(source).index();
    expect(status().failedFiles).toHaveLength(100);
    expect(status().failureDetailsTruncated).toBe(true);
    failures.clear();
    indexFile.mockClear();
    await runtime.get(source).request({ action: 'index', force: true, failedOnly: true });
    expect(indexFile).toHaveBeenCalledTimes(106);
    expect(indexFile.mock.calls.some((call) => call[0].endsWith('good.ts'))).toBe(false);
    expect(runtime.get(source).status().files).toBe(107);
  });

  it('resolves deleted failed files without treating permission errors as deletion', async () => {
    const bad = path.join(root, 'bad.ts');
    const repository = runtime.get(source);
    await originalIndexFile.call(new Indexer(repository.db, root), bad, 'repo');
    await repository.index();
    expect(repository.status().files).toBe(2);
    const stat = fs.statSync;
    const statSpy = vi.spyOn(fs, 'statSync').mockImplementation(((
      file: fs.PathLike,
      ...args: unknown[]
    ) => {
      if (file === bad) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      return Reflect.apply(stat, fs, [file, ...args]);
    }) as typeof fs.statSync);
    await repository.request({ action: 'index', force: true, failedOnly: true });
    expect(status()).toMatchObject({ partial: true, failedFileCount: 1 });
    expect(repository.status().files).toBe(2);
    statSpy.mockRestore();
    fs.unlinkSync(bad);
    await repository.request({ action: 'index', force: true, failedOnly: true });
    expect(status()).toMatchObject({ partial: false, failedFileCount: 0 });
    expect(repository.status().files).toBe(1);
  });

  it.each(['size cap', 'ignored'])(
    'resolves failed files that became %s and removes stale rows',
    async (reason) => {
      const bad = path.join(root, 'bad.ts');
      const repository = runtime.get(source);
      await originalIndexFile.call(new Indexer(repository.db, root), bad, 'repo');
      await repository.index();
      expect(repository.status().files).toBe(2);
      if (reason === 'size cap') fs.writeFileSync(bad, 'x'.repeat(2 * 1024 * 1024 + 1));
      else fs.writeFileSync(path.join(root, '.contextosignore'), 'bad.ts\n');
      indexFile.mockClear();
      await repository.request({ action: 'index', force: true, failedOnly: true });
      expect(status()).toMatchObject({
        fullIndexCompleted: true,
        partial: false,
        failedFileCount: 0
      });
      expect(repository.status().files).toBe(1);
      expect(indexFile).not.toHaveBeenCalled();
    }
  );

  it('preserves the pending file and failed count when a retry aborts before processing', async () => {
    await runtime.get(source).index();
    const file = path.join(path.dirname(source.dbPath), 'failed-index-files.json');
    const pending = fs.readFileSync(file, 'utf8');
    const indexer = new BackgroundIndexer(runtime.get(source).db, root, undefined, () => {
      throw new Error('lease lost');
    });
    await indexer.startFullIndex(config, true);
    expect(indexer.lastError).toBe('lease lost');
    expect(fs.readFileSync(file, 'utf8')).toBe(pending);
    expect(status()).toMatchObject({ failedFileCount: 1, failedFiles: JSON.parse(pending) });
  });

  it('merges unprocessed pending files with new failures after a retry batch aborts', async () => {
    for (let i = 0; i < 15; i++) {
      const file = path.join(root, `retry-${i}.ts`);
      fs.writeFileSync(file, 'export const retry = true;');
      failures.add(file);
    }
    await runtime.get(source).index();
    const file = path.join(path.dirname(source.dbPath), 'failed-index-files.json');
    const pending = JSON.parse(fs.readFileSync(file, 'utf8')) as { path: string; error: string }[];
    indexFile.mockClear();
    failures.clear();
    failures.add(pending[0].path);
    const indexer = new BackgroundIndexer(runtime.get(source).db, root, undefined, () => {
      if (indexer.processedFiles >= 10) throw new Error('lease lost');
    });
    await indexer.startFullIndex(config, true);
    expect(indexer.lastError).toBe('lease lost');
    const attempted = new Set(indexFile.mock.calls.map((call) => call[0]));
    expect(attempted.size).toBe(10);
    const remaining = JSON.parse(fs.readFileSync(file, 'utf8')) as { path: string }[];
    expect(remaining.map((entry) => entry.path).sort()).toEqual(
      pending
        .filter((entry) => !attempted.has(entry.path) || failures.has(entry.path))
        .map((entry) => entry.path)
        .sort()
    );
    expect(status().failedFileCount).toBe(pending.length);
  });

  it('fails the view when reconciliation fails after successful file indexing', async () => {
    failures.clear();
    vi.spyOn(Indexer.prototype, 'removeFilesNotIn').mockRejectedValue(
      new Error('database unavailable')
    );
    await expect(runtime.get(source).index()).rejects.toThrow('database unavailable');
    expect(status().fullIndexCompleted).toBe(false);
    expect(registry.resolve(source.repoId).state).toBe('failed');
  });

  it('reports a complete empty scan at 100 percent', async () => {
    const db = runtime.get(source).db;
    const indexer = new BackgroundIndexer(db, root);
    await indexer.startFullIndex({ ...config, indexablePatterns: ['**/*.missing'] });
    expect(status()).toMatchObject({
      fullIndexCompleted: true,
      partial: false,
      processed: 0,
      total: 0,
      progressPercentage: 100
    });
    expect(indexer.getStatus().progressPercentage).toBe(100);
  });
});
