import { Database } from 'better-sqlite3';
import { FileRecord, Layer } from './types.js';

export class FilesRepo {
  constructor(private db: Database) {}

  public upsert(file: FileRecord): void {
    const stmt = this.db.prepare(`
      INSERT INTO files (
        path, layer, workspace_name, hash, last_indexed, importance, chunk_count
      ) VALUES (
        @path, @layer, @workspaceName, @hash, @lastIndexed, @importance, @chunkCount
      ) ON CONFLICT(path) DO UPDATE SET
        layer = excluded.layer,
        workspace_name = excluded.workspace_name,
        hash = excluded.hash,
        last_indexed = excluded.last_indexed,
        importance = excluded.importance,
        chunk_count = excluded.chunk_count
    `);
    stmt.run(file);
  }

  public getByPath(path: string): FileRecord | null {
    const stmt = this.db.prepare('SELECT * FROM files WHERE path = ?');
    const row = stmt.get(path) as any;
    return row ? this.mapRow(row) : null;
  }

  public isChanged(path: string, currentHash: string): boolean {
    const record = this.getByPath(path);
    if (!record) return true;
    return record.hash !== currentHash;
  }

  public deleteByPath(path: string): void {
    const stmt = this.db.prepare('DELETE FROM files WHERE path = ?');
    stmt.run(path);
  }

  public listByLayer(layer: Layer): FileRecord[] {
    const stmt = this.db.prepare('SELECT * FROM files WHERE layer = ?');
    return (stmt.all(layer) as any[]).map(r => this.mapRow(r));
  }

  private mapRow(row: any): FileRecord {
    return {
      path: row.path,
      layer: row.layer,
      workspaceName: row.workspace_name,
      hash: row.hash,
      lastIndexed: row.last_indexed,
      importance: row.importance,
      chunkCount: row.chunk_count
    };
  }
}
