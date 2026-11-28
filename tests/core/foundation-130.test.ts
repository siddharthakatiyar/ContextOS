import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applyMigrations, SCHEMA_SQL } from '../../src/core/storage/schema.js';
import {
  knowledgeColumns,
  migrateKnowledgeColumns,
  resolveKnowledgeWriteContext,
  transitionStatus,
  KNOWLEDGE_STATUSES
} from '../../src/core/knowledge/write-context.js';
import { GraphStore } from '../../src/core/knowledge/graph-store.js';
import { exportKnowledgeFacts, importKnowledgeFacts } from '../../src/core/knowledge/transfer.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { entityRef } from '../../src/core/workspace/identity.js';

describe('foundation knowledge migration', () => {
  it('upgrades a live v7 database, resumes partial columns, preserves facts and FTS triggers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-v7-'));
    const file = path.join(root, 'index.db');
    const old = new Database(file);
    old.exec(SCHEMA_SQL);
    // SCHEMA_SQL is the pre-ownership base; v7 adds repo_id separately.
    old.exec(
      'ALTER TABLE knowledge_facts ADD COLUMN repo_id TEXT; INSERT INTO schema_version VALUES (7)'
    );
    old.exec(
      "INSERT INTO knowledge_facts(id,fact,category,confidence,created_at,updated_at,last_accessed,access_count,repo_id) VALUES ('old','Historical fact','general',1,11,12,13,2,'view')"
    );
    old.exec('ALTER TABLE knowledge_facts ADD COLUMN author TEXT');
    const before = old.prepare('SELECT * FROM knowledge_facts').get() as object;
    const upgraded = new Database(file);
    try {
      applyMigrations(upgraded);
      applyMigrations(upgraded);
      expect(upgraded.prepare('SELECT version FROM schema_version').get()).toEqual({ version: 8 });
      expect(upgraded.prepare('SELECT * FROM knowledge_facts').get()).toMatchObject({
        ...before,
        status: 'verified',
        namespace: 'project',
        task_id: null,
        model: null,
        expires_at: null,
        verified_at: null,
        stale_reason: null
      });
      expect(old.prepare('SELECT status FROM knowledge_facts').get()).toEqual({
        status: 'verified'
      });
      const indexes = upgraded.prepare("PRAGMA index_list('knowledge_facts')").all() as {
        name: string;
      }[];
      expect(indexes.map((i) => i.name)).toEqual(
        expect.arrayContaining(['idx_knowledge_facts_task_id', 'idx_knowledge_facts_status'])
      );
      upgraded.exec("UPDATE knowledge_facts SET fact='Revised fact' WHERE id='old'");
      expect(
        upgraded
          .prepare("SELECT fact FROM knowledge_facts_fts WHERE knowledge_facts_fts MATCH 'Revised'")
          .all()
      ).toHaveLength(1);
      upgraded.exec(
        "INSERT INTO knowledge_facts(id,fact,category,created_at,updated_at,last_accessed) VALUES ('new','Inserted fact','general',1,1,1)"
      );
      expect(
        upgraded
          .prepare(
            "SELECT fact FROM knowledge_facts_fts WHERE knowledge_facts_fts MATCH 'Inserted'"
          )
          .all()
      ).toHaveLength(1);
      upgraded.exec("DELETE FROM knowledge_facts WHERE id='new'");
      expect(
        upgraded
          .prepare(
            "SELECT fact FROM knowledge_facts_fts WHERE knowledge_facts_fts MATCH 'Inserted'"
          )
          .all()
      ).toHaveLength(0);
    } finally {
      upgraded.close();
      old.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('migrates historical graph payloads without changing identities or revision', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-old-graph-'));
    const old = new Database(path.join(root, 'graph.db'));
    const fact = {
      id: 'fact',
      content: 'Historical choice',
      scope: 'view',
      scopeId: 'view',
      viewIds: ['view'],
      provenance: 'user',
      evidence: [],
      createdAt: 1,
      updatedAt: 2
    };
    const link = {
      id: 'link',
      source: 'a',
      target: 'b',
      type: 'imports',
      rationale: 'historical',
      evidence: [],
      createdAt: 3,
      updatedAt: 4
    };
    old.exec(
      "CREATE TABLE verified_facts (id TEXT PRIMARY KEY, identity TEXT UNIQUE, payload TEXT); CREATE TABLE verified_links (id TEXT PRIMARY KEY, identity TEXT UNIQUE, payload TEXT); CREATE TABLE graph_metadata (key TEXT PRIMARY KEY, value INTEGER); INSERT INTO graph_metadata VALUES ('revision',9)"
    );
    old
      .prepare('INSERT INTO verified_facts VALUES (?,?,?)')
      .run(fact.id, 'fact-identity', JSON.stringify(fact));
    old
      .prepare('INSERT INTO verified_links VALUES (?,?,?)')
      .run(link.id, 'link-identity', JSON.stringify(link));
    // Emulate a previously interrupted non-transactional attempt.
    migrateKnowledgeColumns(old, ['verified_facts']);
    const open = () =>
      new GraphStore({
        home: root,
        resolve: () => {
          throw new Error('not needed');
        }
      });
    try {
      for (let n = 0; n < 2; n++) {
        const graph = open();
        try {
          expect(graph.revision()).toBe(9);
          expect(graph.listLinks()).toEqual([
            expect.objectContaining({ ...link, status: 'verified', namespace: 'project' })
          ]);
          expect(graph.searchFacts('Historical', { viewIds: ['view'] })).toEqual([
            expect.objectContaining({ ...fact, status: 'verified' })
          ]);
        } finally {
          graph.close();
        }
      }
      expect(old.prepare('SELECT identity,payload FROM verified_links').get()).toEqual({
        identity: 'link-identity',
        payload: JSON.stringify(link)
      });
      expect(
        old.prepare("SELECT value FROM graph_metadata WHERE key='schema_version'").get()
      ).toEqual({ value: 1 });
      for (const table of ['verified_links', 'verified_facts']) {
        const indexes = old.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[];
        expect(indexes.map((i) => i.name)).toEqual(
          expect.arrayContaining([`idx_${table}_task_id`, `idx_${table}_status`])
        );
      }
    } finally {
      old.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('knowledge write context', () => {
  it('resolves defaults, environment and explicit MCP overrides', () => {
    expect(resolveKnowledgeWriteContext({}, {})).toMatchObject({
      status: 'verified',
      namespace: 'project'
    });
    const env = {
      CONTEXTOS_TASK_ID: 'env-task',
      CONTEXTOS_AUTHOR: 'env-author',
      CONTEXTOS_MODEL: 'env-model'
    };
    expect(resolveKnowledgeWriteContext({}, env)).toMatchObject({
      taskId: 'env-task',
      author: 'env-author',
      model: 'env-model'
    });
    expect(
      resolveKnowledgeWriteContext(
        {
          task_id: 'explicit-task',
          author: 'me',
          model: 'local',
          status: 'proposed',
          namespace: 'task',
          expires_at: 123
        },
        env
      )
    ).toEqual({
      taskId: 'explicit-task',
      author: 'me',
      model: 'local',
      status: 'proposed',
      namespace: 'task',
      expiresAt: 123
    });
    expect(resolveKnowledgeWriteContext({ expiresAt: null, expires_at: 123 }, {})).toMatchObject({
      expiresAt: null
    });
    expect(() => knowledgeColumns({ expiresAt: 0.5 })).toThrow('integer timestamp');
  });
  it('allows only the four lifecycle transitions', () => {
    const allowed = ['proposed:verified', 'verified:stale', 'stale:verified', 'proposed:stale'];
    for (const from of KNOWLEDGE_STATUSES)
      for (const to of KNOWLEDGE_STATUSES) {
        if (allowed.includes(`${from}:${to}`)) expect(transitionStatus(from, to)).toBe(to);
        else
          expect(() => transitionStatus(from, to)).toThrow('Invalid knowledge status transition');
      }
  });
});

it('constructs and indexes the reusable three-repository group and round-trips knowledge', async () => {
  const fixture = await createFixtureGroup();
  const graph = new GraphStore({
    home: fixture.registry.home,
    resolve: (id) => {
      const source = fixture.registry.resolve(id);
      return { source, db: fixture.runtime.get(source).db.getInstance() };
    }
  });
  try {
    expect(fixture.registry.home).toBe(path.join(fixture.home, '.contextos'));
    expect(fixture.registry.list('foundation-130')).toHaveLength(3);
    expect(fixture.sources.every((s) => s.state === 'ready' && s.generation > 0)).toBe(true);
    const [a, b] = fixture.sources;
    const refs = [a, b].map((source) => {
      const row = fixture.runtime
        .get(source)
        .db.getInstance()
        .prepare(
          "SELECT id FROM chunks WHERE source_file=? AND section_title='File Structure' LIMIT 1"
        )
        .get(
          path.join(source.rootPath, 'src', source.repoId === a.repoId ? 'client.ts' : 'worker.ts')
        ) as { id: string };
      return entityRef(source.repoId, 'chunk', row.id);
    });
    const context = {
      author: 'foundation-test',
      taskId: 'wave-0',
      model: 'test',
      status: 'proposed' as const,
      namespace: 'task',
      expiresAt: Date.now() + 60_000
    };
    const link = graph.link(
      {
        source: refs[1],
        target: refs[0],
        type: 'calls_api',
        rationale: 'Fixture transport client call to service A',
        expectedGenerations: Object.fromEntries(
          fixture.sources.map((s) => [s.repoId, s.generation])
        ),
        ...context
      },
      fixture.sources.map((s) => s.repoId)
    );
    expect(
      graph.getLink(
        link.id,
        fixture.sources.map((s) => s.repoId)
      )
    ).toMatchObject(context);
    const fact = graph.remember(
      {
        content: 'Fixture user choice',
        scope: 'view',
        scopeId: a.repoId,
        viewIds: [a.repoId],
        provenance: 'user',
        ...context,
        verifiedAt: 123,
        staleReason: 'Fixture reason'
      },
      [a.repoId]
    );
    const snapshot = JSON.parse(
      JSON.stringify(graph.exportKnowledge(fixture.sources.map((s) => s.repoId)))
    );
    graph.forget(fact.id, [a.repoId]);
    graph.unlink(
      link.id,
      fixture.sources.map((s) => s.repoId)
    );
    graph.importKnowledge(
      snapshot,
      fixture.sources.map((s) => s.repoId)
    );
    expect(graph.listLinks()).toEqual([expect.objectContaining(context)]);
    expect(graph.searchFacts('Fixture user', { viewIds: [a.repoId] })).toEqual([
      expect.objectContaining({ ...context, status: 'verified' })
    ]);
    expect(graph.searchFacts('Fixture user', { viewIds: [a.repoId] })[0]).toMatchObject({
      verifiedAt: 123,
      staleReason: 'Fixture reason'
    });
    const invalid = structuredClone(snapshot);
    invalid.links[0].evidence[0].fileHash = 'changed';
    expect(() =>
      graph.importKnowledge(
        invalid,
        fixture.sources.map((s) => s.repoId)
      )
    ).toThrow('Imported evidence changed');
    expect(() => graph.importKnowledge(snapshot, [a.repoId])).toThrow('outside the selected views');
    expect(graph.exportKnowledge(fixture.sources.map((s) => s.repoId))).toEqual(snapshot);
    const historical = structuredClone(snapshot);
    for (const record of [...historical.links, ...historical.facts])
      for (const field of [
        'author',
        'taskId',
        'model',
        'status',
        'namespace',
        'expiresAt',
        'verifiedAt',
        'staleReason'
      ])
        delete record[field];
    graph.importKnowledge(
      historical,
      fixture.sources.map((s) => s.repoId)
    );
    expect(graph.listLinks()[0]).toMatchObject({
      status: 'verified',
      namespace: 'project',
      expiresAt: null
    });
    const db = fixture.runtime.get(a).db;
    const store = new KnowledgeStore(db);
    store.learnFact('Legacy export fixture fact', 'general', context);
    db.getInstance().exec(
      "UPDATE knowledge_facts SET verified_at=7, stale_reason='fixture reason'"
    );
    const exported = JSON.parse(JSON.stringify(exportKnowledgeFacts(db.getInstance())));
    db.getInstance().exec('DELETE FROM knowledge_facts');
    importKnowledgeFacts(db.getInstance(), exported);
    expect(store.searchFacts('Legacy export')).toEqual([
      expect.objectContaining({
        author: context.author,
        task_id: context.taskId,
        status: 'proposed',
        namespace: 'task',
        expires_at: context.expiresAt,
        verified_at: 7,
        stale_reason: 'fixture reason'
      })
    ]);
    importKnowledgeFacts(db.getInstance()); // old CLI exports omitted the entire table
    importKnowledgeFacts(db.getInstance(), [{ id: 'old', fact: 'Old export missing metadata' }]);
    expect(store.getAllFacts().find((f) => f.id === 'old')).toMatchObject({
      status: 'verified',
      namespace: 'project',
      expires_at: null
    });
  } finally {
    graph.close();
    await fixture.cleanup();
  }
}, 30000);
