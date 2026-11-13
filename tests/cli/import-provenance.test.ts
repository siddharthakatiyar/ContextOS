import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importCommand } from '../../src/cli/commands/import.js';
import { exportCommand } from '../../src/cli/commands/export.js';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { WorkspaceRegistry, type RepositorySource } from '../../src/core/workspace/registry.js';
import { SessionStore } from '../../src/core/session/session-store.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';

let temp: string;
let originalCwd: string;
let registry: WorkspaceRegistry;
let a: RepositorySource;
let b: RepositorySource;
let exported: string;

function snapshot(source: RepositorySource): unknown {
  const db = new DB(source.dbPath);
  try {
    return [
      'files',
      'chunks',
      'relationships',
      'sessions',
      'session_events',
      'knowledge_facts'
    ].map((table) => db.getInstance().prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
  } finally {
    db.close();
  }
}

async function importData(data: unknown, destination = a): Promise<void> {
  const file = path.join(temp, 'incoming.json');
  fs.writeFileSync(file, JSON.stringify(data));
  process.chdir(destination.rootPath);
  await importCommand.parseAsync(['node', 'import', file]);
}

function legacyData() {
  const data = JSON.parse(fs.readFileSync(exported, 'utf8'));
  delete data.repository;
  for (const table of ['files', 'chunks', 'relationships'])
    for (const row of data.data[table]) delete row.repo_id;
  return data;
}

beforeEach(async () => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-import-'));
  originalCwd = process.cwd();
  const home = path.join(temp, 'home');
  fs.mkdirSync(home);
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  registry = new WorkspaceRegistry();
  const sources = [];
  for (const name of ['a', 'b']) {
    const root = path.join(temp, name);
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, 'limiter.ts'),
      "import { capacity } from './capacity.js';\nexport function tokenBucket() { return capacity; }"
    );
    const source = registry.register(root, { name });
    const db = new DB(source.dbPath);
    await new Indexer(db, root).indexFile(path.join(root, 'limiter.ts'), 'repo');
    const sessions = new SessionStore(db);
    const session = sessions.createSession(root);
    sessions.addEvent({
      sessionId: session.id,
      eventType: 'user_prompt',
      content: 'Keep the limiter history',
      relatedFiles: null
    });
    new KnowledgeStore(db).learnFact('The token bucket holds 100 tokens');
    db.close();
    sources.push(source);
  }
  [a, b] = sources;
  exported = path.join(temp, 'a.json');
  process.chdir(a.rootPath);
  await exportCommand.parseAsync(['node', 'export', exported]);
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  process.chdir(originalCwd);
  registry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('per-view graph import provenance', () => {
  it('roundtrips its own export while retaining local facts and session history', async () => {
    const before = snapshot(a);
    await importData(JSON.parse(fs.readFileSync(exported, 'utf8')));
    expect(process.exitCode).toBe(0);
    expect(snapshot(a)).toEqual(before);
  });

  it('rejects another registered view without modifying the destination', async () => {
    const before = snapshot(b);
    await importData(JSON.parse(fs.readFileSync(exported, 'utf8')), b);
    expect(process.exitCode).toBe(1);
    expect(snapshot(b)).toEqual(before);
  });

  it('accepts legacy snapshots only when their source paths belong to the destination', async () => {
    const data = legacyData();
    const beforeA = snapshot(a);
    await importData(data);
    expect(process.exitCode).toBe(0);
    expect(snapshot(a)).toEqual(beforeA);
    const beforeB = snapshot(b);
    await importData(data, b);
    expect(process.exitCode).toBe(1);
    expect(snapshot(b)).toEqual(beforeB);
  });

  it.each(['files', 'relationships'])(
    'rejects conflicting %s ownership atomically',
    async (table) => {
      const data = JSON.parse(fs.readFileSync(exported, 'utf8'));
      expect(data.data[table].length).toBeGreaterThan(0);
      data.data[table][0].repo_id = b.repoId;
      const before = snapshot(a);
      await importData(data);
      expect(process.exitCode).toBe(1);
      expect(snapshot(a)).toEqual(before);
    }
  );

  it('rejects an absolute foreign path even when the snapshot names the local view', async () => {
    const data = JSON.parse(fs.readFileSync(exported, 'utf8'));
    data.data.chunks[0].source_file = path.join(b.rootPath, 'limiter.ts');
    const before = snapshot(a);
    await importData(data);
    expect(process.exitCode).toBe(1);
    expect(snapshot(a)).toEqual(before);
  });

  it('rejects traversal and missing files below an escaping symlink', async () => {
    fs.symlinkSync(b.rootPath, path.join(a.rootPath, 'outside'), 'dir');
    fs.symlinkSync(path.join(temp, 'unavailable'), path.join(a.rootPath, 'dangling'), 'dir');
    for (const incoming of ['../b/limiter.ts', 'outside/deleted.ts', 'dangling/deleted.ts']) {
      const data = legacyData();
      data.data.files[0].path = incoming;
      const before = snapshot(a);
      await importData(data);
      expect(process.exitCode).toBe(1);
      expect(snapshot(a)).toEqual(before);
    }
  });

  it('binds legacy null ownership to the local view and resolves local relative paths', async () => {
    const data = legacyData();
    for (const table of ['files', 'chunks', 'relationships'])
      for (const row of data.data[table]) row.repo_id = null;
    data.data.files[0].path = 'limiter.ts';
    for (const row of data.data.chunks) row.source_file = 'limiter.ts';
    const before = snapshot(a);
    await importData(data);
    expect(process.exitCode).toBe(0);
    expect(snapshot(a)).toEqual(before);
  });

  it.each(['missing-files', 'nonarray-chunks', 'missing-content'])(
    'rejects malformed %s input atomically',
    async (malformation) => {
      const data = legacyData();
      if (malformation === 'missing-files') delete data.data.files;
      if (malformation === 'nonarray-chunks') data.data.chunks = {};
      if (malformation === 'missing-content') delete data.data.chunks[0].content;
      const before = snapshot(a);
      await importData(data);
      expect(process.exitCode).toBe(1);
      expect(snapshot(a)).toEqual(before);
    }
  );
});
