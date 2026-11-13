import type { RetrievalResult } from '../../src/core/retrieval/types.js';
import type { RetrievalScope } from '../../src/core/workspace/registry.js';
import type { CompilerDiagnostics } from '../../src/core/compiler/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceQuery } from '../../src/cli/commands/workspace-query.js';
import { configFingerprint } from '../../src/core/workspace/runtime.js';
import { WorkspaceRegistry, type RepositorySource } from '../../src/core/workspace/registry.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { DB } from '../../src/core/storage/database.js';
import { hashContent } from '../../src/utils/hash.js';

describe('CLI query scope and provenance', () => {
  let home: string;
  let originalCwd: string;
  let roots: string[];
  let homedirSpy: ReturnType<typeof vi.spyOn>;
  let outputSpy: ReturnType<typeof vi.spyOn>;
  let sources: RepositorySource[];

  const addIndexedProject = (registry: WorkspaceRegistry, name: string, group?: string) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `contextos-query-${name}-`));
    roots.push(root);
    const source = registry.register(root, { name, group });
    const relativePath = 'src/payment.ts';
    const file = path.join(root, relativePath);
    const content =
      name === 'backend'
        ? "export type PaymentStatus = 'pending' | 'paid';\nexport function processPaymentStatus(status: PaymentStatus) { return status === 'paid'; }\n"
        : name === 'frontend'
          ? "export type PaymentStatus = 'pending' | 'paid';\nexport function displayPaymentStatus(status: PaymentStatus) { return status.toUpperCase(); }\n"
          : 'PaymentStatus in an unrelated infrastructure fixture.\n';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);

    const db = new DB(source.dbPath);
    try {
      const instance = db.getInstance();
      const fileHash = hashContent(content);
      instance
        .prepare(
          'INSERT INTO files (repo_id,path,layer,workspace_name,hash,last_indexed,importance,chunk_count) VALUES (?,?,?,NULL,?,?,?,?)'
        )
        .run(source.repoId, file, 'repo', fileHash, Date.now(), 8, 1);
      new ChunksRepo(instance).upsert({
        id: 'reused-local-chunk-id',
        sourceFile: file,
        layer: 'repo',
        workspaceName: null,
        sectionTitle: `${name} PaymentStatus implementation`,
        sectionDepth: 0,
        content,
        summary: `${name} payment status definition and implementation`,
        keywords: 'PaymentStatus payment status process display',
        hash: fileHash,
        importance: 8,
        tokenCount: Math.ceil(content.length / 4),
        fileType: 'code',
        language: 'typescript',
        symbolName: name === 'infrastructure' ? null : 'PaymentStatus',
        symbolKind: name === 'infrastructure' ? undefined : 'type',
        startLine: 1,
        endLine: 2,
        fileStem: 'payment',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    } finally {
      db.close();
    }
    registry.update(source.repoId, {
      state: 'ready',
      configFingerprint: configFingerprint(root),
      lastSuccess: Date.now()
    });
    return source;
  };

  const lastJson = () => {
    const last = outputSpy.mock.calls.at(-1)?.[0];
    return JSON.parse(String(last)) as Omit<RetrievalResult, 'scope' | 'explanation'> & {
      scope: RetrievalScope;
      context: string;
      tokens: number;
      explanation: {
        retrieval: NonNullable<RetrievalResult['explanation']>;
        compilation: CompilerDiagnostics;
      };
    };
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-query-home-'));
    originalCwd = process.cwd();
    roots = [];
    sources = [];
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    fs.mkdirSync(path.join(home, '.contextos'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.contextos', 'config.json'),
      JSON.stringify({ embeddingsEnabled: false, embeddingsRetrieval: false })
    );
    outputSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const registry = new WorkspaceRegistry();
    try {
      registry.ensureGroup('payments');
      sources.push(addIndexedProject(registry, 'backend', 'payments'));
      sources.push(addIndexedProject(registry, 'frontend', 'payments'));
      addIndexedProject(registry, 'infrastructure');
      process.chdir(sources[0].rootPath);
    } finally {
      registry.close();
    }
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    homedirSpy.mockRestore();
    for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('defaults to the active checkout and returns qualified evidence with explain provenance', async () => {
    await workspaceQuery('PaymentStatus', { json: true, explain: true });

    const result = lastJson();
    expect(result).toHaveProperty('intent');
    expect(result).toHaveProperty('latencyMs');
    expect(result).toHaveProperty('chunks');
    expect(result).toHaveProperty('expandedEntities');
    expect(result).toHaveProperty('context');
    expect(result).toHaveProperty('tokens');
    expect(result.scope.sources.map((source: RepositorySource) => source.projectId)).toEqual([
      sources[0].projectId
    ]);
    expect(result.scope.activeRepoId).toBe(sources[0].repoId);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toMatchObject({
      repoId: sources[0].repoId,
      projectId: sources[0].projectId,
      viewId: sources[0].viewId,
      repoName: 'backend',
      relativePath: 'src/payment.ts',
      localId: 'reused-local-chunk-id'
    });
    expect(result.chunks[0].id).toContain(sources[0].repoId);
    expect(result.explanation.retrieval.chunks[result.chunks[0].id].repository).toMatchObject({
      repoId: sources[0].repoId,
      name: 'backend',
      localityMultiplier: 1
    });
    expect(result.explanation.compilation).toBeDefined();
  });

  it('searches the selected group and keeps identical local IDs in separate project namespaces', async () => {
    await workspaceQuery('PaymentStatus', { group: 'payments', json: true, explain: true });

    const result = lastJson();
    expect(result.scope.groupId).toBeTruthy();
    expect(result.scope.sources.map((source: RepositorySource) => source.name).sort()).toEqual([
      'backend',
      'frontend'
    ]);
    expect(result.chunks).toHaveLength(2);
    expect(result.chunks.map((chunk) => chunk.localId)).toEqual([
      'reused-local-chunk-id',
      'reused-local-chunk-id'
    ]);
    expect(new Set(result.chunks.map((chunk) => chunk.id)).size).toBe(2);
    expect(new Set(result.chunks.map((chunk) => chunk.repoId).sort())).toEqual(
      new Set([sources[0].repoId, sources[1].repoId])
    );
    expect(result.chunks.map((chunk) => chunk.repoName).sort()).toEqual(['backend', 'frontend']);
    expect(result.chunks.every((chunk) => chunk.relativePath === 'src/payment.ts')).toBe(true);
    expect(Object.keys(result.explanation.retrieval.chunks)).toEqual(
      expect.arrayContaining(result.chunks.map((chunk) => chunk.id))
    );
    expect(
      result.explanation.retrieval.chunks[result.chunks[0].id].repository?.localityMultiplier
    ).toBe(1.1);
    expect(result.chunks.some((chunk) => chunk.repoName === 'infrastructure')).toBe(false);
  });
});
