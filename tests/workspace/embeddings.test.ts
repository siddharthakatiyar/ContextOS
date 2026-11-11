import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime } from '../../src/core/workspace/runtime.js';
import { retrieveWorkspace } from '../../src/core/workspace/retrieval.js';
import { searchEmbeddingChunks } from '../../src/core/embeddings/index.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';

vi.mock('../../src/core/embeddings/index.js', async (original) => {
  const actual = await original<typeof import('../../src/core/embeddings/index.js')>();
  return {
    ...actual,
    isEmbeddingsAvailable: () => true,
    indexChunkEmbeddings: vi.fn(),
    searchEmbeddingChunks: vi.fn(async (db) =>
      new ChunksRepo(db).findByFileStem('payment').map((chunk) => ({ ...chunk, score: 0.9 }))
    )
  };
});
describe('workspace hybrid retrieval', () => {
  it('searches embeddings in each selected owner database and honors repository configuration', async () => {
    const temp = fs.mkdtempSync(
      path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'cwh-')
    );
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(temp, 'home'));
    const registry = new WorkspaceRegistry();
    const runtime = new WorkspaceRuntime(registry);
    try {
      for (const name of ['backend', 'frontend']) {
        const root = path.join(temp, name);
        fs.cpSync(path.resolve('tests/fixtures/workspace', name), root, { recursive: true });
        fs.mkdirSync(path.join(root, '.contextos'));
        fs.writeFileSync(
          path.join(root, '.contextos', 'config.json'),
          JSON.stringify({ embeddingsEnabled: true, embeddingsRetrieval: true })
        );
        const source = registry.register(root);
        await runtime.get(source).index();
      }
      vi.mocked(searchEmbeddingChunks).mockClear();
      const all = await retrieveWorkspace(
        runtime,
        registry.select({ allRepos: true }, temp),
        'orbital lattice'
      );
      expect(searchEmbeddingChunks).toHaveBeenCalledTimes(2);
      expect(new Set(all.chunks.map((chunk) => chunk.repoName))).toEqual(
        new Set(['backend', 'frontend'])
      );
      vi.mocked(searchEmbeddingChunks).mockClear();
      const local = await retrieveWorkspace(
        runtime,
        registry.select({ repo: ['frontend'] }, temp),
        'orbital lattice'
      );
      expect(searchEmbeddingChunks).toHaveBeenCalledTimes(1);
      expect(local.chunks.every((chunk) => chunk.repoName === 'frontend')).toBe(true);
      runtime.get(registry.resolve('frontend')).config.embeddingsEnabled = false;
      vi.mocked(searchEmbeddingChunks).mockClear();
      await retrieveWorkspace(
        runtime,
        registry.select({ repo: ['frontend'] }, temp),
        'orbital lattice'
      );
      expect(searchEmbeddingChunks).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
      registry.close();
      vi.restoreAllMocks();
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
});
