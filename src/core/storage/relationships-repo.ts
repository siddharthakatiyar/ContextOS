import { Database } from 'better-sqlite3';
import { Relationship, Layer } from './types.js';
import { prepareCached } from './stmt-cache.js';

interface RelationshipRow {
  id: number;
  source: string;
  target: string;
  relationship_type: string;
  weight: number;
  source_chunk_id: string;
  layer: Layer | null;
  created_at: number;
}

export class RelationshipsRepo {
  constructor(private db: Database) {}

  public upsert(rel: Relationship): void {
    const stmt = prepareCached(
      this.db,
      `
      INSERT INTO relationships (
        source, target, relationship_type, weight, source_chunk_id, layer, created_at
      ) VALUES (
        @source, @target, @relationshipType, @weight, @sourceChunkId, @layer, @createdAt
      ) ON CONFLICT(source, target, relationship_type, source_chunk_id) DO UPDATE SET
        weight = excluded.weight,
        layer = excluded.layer
    `
    );
    stmt.run(rel);
  }

  public bulkUpsert(rels: Relationship[]): void {
    const stmt = prepareCached(
      this.db,
      `
      INSERT INTO relationships (
        source, target, relationship_type, weight, source_chunk_id, layer, created_at
      ) VALUES (
        @source, @target, @relationshipType, @weight, @sourceChunkId, @layer, @createdAt
      ) ON CONFLICT(source, target, relationship_type, source_chunk_id) DO UPDATE SET
        weight = excluded.weight,
        layer = excluded.layer
    `
    );
    const transaction = this.db.transaction((items: Relationship[]) => {
      for (const item of items) {
        stmt.run(item);
      }
    });
    transaction(rels);
  }

  public findBySource(source: string): Relationship[] {
    const stmt = prepareCached(this.db, 'SELECT * FROM relationships WHERE source = ?');
    return (stmt.all(source) as RelationshipRow[]).map((r) => this.mapRow(r));
  }

  public findByTarget(target: string): Relationship[] {
    const stmt = prepareCached(this.db, 'SELECT * FROM relationships WHERE target = ?');
    return (stmt.all(target) as RelationshipRow[]).map((r) => this.mapRow(r));
  }

  public findRelated(entity: string): Relationship[] {
    const stmt = prepareCached(
      this.db,
      'SELECT * FROM relationships WHERE source = ? OR target = ?'
    );
    return (stmt.all(entity, entity) as RelationshipRow[]).map((r) => this.mapRow(r));
  }

  public deleteByChunk(chunkId: string): void {
    const stmt = prepareCached(this.db, 'DELETE FROM relationships WHERE source_chunk_id = ?');
    stmt.run(chunkId);
  }

  private mapRow(row: RelationshipRow): Relationship {
    return {
      id: row.id,
      source: row.source,
      target: row.target,
      relationshipType: row.relationship_type,
      weight: row.weight,
      sourceChunkId: row.source_chunk_id,
      layer: row.layer,
      createdAt: row.created_at
    };
  }
}
