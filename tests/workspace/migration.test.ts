import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SCHEMA_SQL, applyMigrations } from '../../src/core/storage/schema.js';
import { bindRepository } from '../../src/core/workspace/identity.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';

describe('schema v6 to v7 ownership migration', () => {
  it('retains local IDs, FTS, embeddings, feedback and memories through restartable migration', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO schema_version VALUES (6)').run();
    db.prepare(
      "INSERT INTO files (path,layer,hash,last_indexed) VALUES ('/repo/payment.ts','repo','hash',1)"
    ).run();
    db.prepare(
      `INSERT INTO chunks (id,source_file,layer,section_depth,content,hash,token_count,created_at,updated_at)
      VALUES ('historical-chunk','/repo/payment.ts','repo',1,'payment status retained','hash',4,1,1)`
    ).run();
    const vector = Buffer.from(new Float32Array([0.1, 0.2, 0.3]).buffer);
    db.prepare('INSERT INTO chunk_embeddings VALUES (?,?,?,?,?)').run(
      'historical-chunk',
      vector,
      3,
      'fixture',
      1
    );
    db.prepare(
      "INSERT INTO feedback_signals VALUES ('feedback','historical-chunk',1,'useful',1)"
    ).run();
    db.prepare(
      "INSERT INTO knowledge_facts (id,fact,created_at,updated_at,last_accessed) VALUES ('memory','payment memory',1,1,1)"
    ).run();
    applyMigrations(db);
    bindRepository(db, 'persistent-repository', '/repo');
    applyMigrations(db);
    bindRepository(db, 'persistent-repository', '/repo');
    expect(new ChunksRepo(db).getByIds(['historical-chunk'])[0].repoId).toBe(
      'persistent-repository'
    );
    expect(
      db
        .prepare(
          "SELECT id FROM chunks WHERE rowid IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'payment')"
        )
        .all()
    ).toEqual([{ id: 'historical-chunk' }]);
    expect(
      (db.prepare('SELECT embedding FROM chunk_embeddings').get() as { embedding: Buffer })
        .embedding
    ).toEqual(vector);
    expect(db.prepare('SELECT score_adjustment FROM feedback_signals').get()).toEqual({
      score_adjustment: 1
    });
    expect(db.prepare('SELECT id,repo_id FROM knowledge_facts').get()).toEqual({
      id: 'memory',
      repo_id: 'persistent-repository'
    });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
  it('leaves shared global records unowned until a repository is explicitly bound', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    expect(
      db.prepare("SELECT value FROM repository_metadata WHERE key='repo_id'").get()
    ).toBeUndefined();
    db.close();
  });
});
