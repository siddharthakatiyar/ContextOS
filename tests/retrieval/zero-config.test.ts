import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { RetrievalEngine } from '../../src/core/retrieval/index.js';
import { scoreChunks } from '../../src/core/retrieval/scorer.js';
import { DB } from '../../src/core/storage/database.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../src/core/storage/relationships-repo.js';
import type { ScoredChunk } from '../../src/core/retrieval/types.js';

vi.mock('../../src/config/index.js', () => ({ loadConfig: vi.fn() }));

function chunk(id: string): ScoredChunk {
  return {
    id,
    sourceFile: 'src/worker.ts',
    layer: 'repo',
    workspaceName: null,
    sectionTitle: null,
    sectionDepth: 0,
    content: `export function ${id}() { return 1; }`,
    summary: null,
    keywords: id,
    hash: id,
    importance: 0,
    tokenCount: 15,
    createdAt: 0,
    updatedAt: 0,
    score: 10,
    symbolName: id,
    symbolKind: 'function'
  };
}

beforeEach(() => {
  vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
  vi.mocked(loadConfig).mockReturnValue({
    ...defaultConfig,
    embeddingsEnabled: false,
    embeddingsRetrieval: false
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('zero-valued retrieval configuration', () => {
  it('returns keyword evidence without traversing graph neighbors when depth is zero', async () => {
    const db = new DB(':memory:');
    try {
      const chunks = new ChunksRepo(db.getInstance());
      const relationships = new RelationshipsRepo(db.getInstance());
      db.getInstance()
        .prepare(
          "INSERT INTO files(path,layer,hash,last_indexed,importance,chunk_count) VALUES ('src/worker.ts','repo','fixture',1,1,2)"
        )
        .run();
      chunks.bulkUpsert([chunk('originWorker'), chunk('linkedWorker')]);
      relationships.upsert({
        source: 'originWorker',
        target: 'linkedWorker',
        relationshipType: 'calls',
        sourceChunkId: 'originWorker',
        layer: 'repo',
        weight: 1,
        createdAt: 0
      });
      const enabled = await new RetrievalEngine(chunks, relationships, {
        ...defaultConfig,
        graphExpansionDepth: 1
      }).retrieve('originWorker');
      expect(enabled.expandedEntities.some((item) => item.entity === 'linkedWorker')).toBe(true);
      expect(enabled.chunks.some((item) => item.id === 'linkedWorker')).toBe(true);

      const disabled = await new RetrievalEngine(chunks, relationships, {
        ...defaultConfig,
        graphExpansionDepth: 0
      }).retrieve('originWorker');
      expect(disabled.expandedEntities).toEqual([]);
      expect(disabled.chunks.some((item) => item.id === 'originWorker')).toBe(true);
      expect(disabled.chunks.some((item) => item.id === 'linkedWorker')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('removes graph keyword boost when the maximum boost is zero', () => {
    const onSignals = vi.fn();
    const entities = [{ entity: 'originWorker', relationshipType: 'calls', depth: 1, score: 1 }];
    const enabled = scoreChunks([chunk('originWorker')], entities, {}, { config: defaultConfig });
    const disabled = scoreChunks(
      [chunk('originWorker')],
      entities,
      {},
      {
        config: { ...defaultConfig, maxGraphBoost: 0 },
        onSignals
      }
    );

    expect(onSignals.mock.calls[0][1].graphKeywordBoost).toBe(0);
    expect(disabled[0].score).toBeLessThan(enabled[0].score);
    expect(disabled[0].score).toBe(
      scoreChunks([chunk('originWorker')], [], {}, { config: defaultConfig })[0].score
    );
  });

  it('applies zero diversity decay to repeated-file results beyond the configured threshold', () => {
    const candidates = ['first', 'second', 'third'].map(chunk);
    const enabled = scoreChunks(
      candidates,
      [],
      {},
      {
        config: { ...defaultConfig, diversityPenaltyStart: 1 }
      }
    );
    const zeroDecay = scoreChunks(
      candidates,
      [],
      {},
      {
        config: { ...defaultConfig, diversityPenaltyStart: 1, diversityDecay: 0 }
      }
    );

    expect(enabled[1].score).toBeGreaterThan(0);
    expect(zeroDecay[0].score).toBeGreaterThan(0);
    expect(zeroDecay.slice(1).map((item) => item.score)).toEqual([0, 0]);
  });

  it('starts diversity decay immediately when the penalty threshold is zero', () => {
    const unpenalized = scoreChunks(
      [chunk('first')],
      [],
      {},
      {
        config: { ...defaultConfig, diversityDecay: 0.5, diversityPenaltyStart: 1 }
      }
    );
    const immediate = scoreChunks(
      [chunk('first')],
      [],
      {},
      {
        config: { ...defaultConfig, diversityDecay: 0.5, diversityPenaltyStart: 0 }
      }
    );

    expect(immediate[0].score).toBe(unpenalized[0].score * 0.5);
  });

  it('honors zero layer weight while preserving results from other layers', () => {
    const repo = chunk('repoWorker');
    const global = { ...chunk('globalWorker'), layer: 'global' as const };
    const scored = scoreChunks(
      [repo, global],
      [],
      {},
      {
        config: { ...defaultConfig, layerBoosts: { ...defaultConfig.layerBoosts, repo: 0 } }
      }
    );

    expect(scored.find((item) => item.id === repo.id)?.score).toBe(0);
    expect(scored.find((item) => item.id === global.id)?.score).toBeGreaterThan(0);
  });
});
