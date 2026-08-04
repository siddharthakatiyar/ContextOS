import { Database } from 'better-sqlite3';
import { FileRecord, Layer } from './types.js';
import { prepareCached } from './stmt-cache.js';

interface FileRow {
  path: string;
  layer: Layer;
  workspace_name: string | null;
  hash: string;
  last_indexed: number;
  importance: number;
  chunk_count: number;
}

export class FilesRepo {
  constructor(private db: Database) {}

  public upsert(file: FileRecord): void {
    const stmt = prepareCached(
      this.db,
      `
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
    `
    );
    stmt.run(file);
  }

  public getByPath(path: string): FileRecord | null {
    const stmt = prepareCached(this.db, 'SELECT * FROM files WHERE path = ?');
    const row = stmt.get(path) as FileRow | undefined;
    return row ? this.mapRow(row) : null;
  }

  public isChanged(path: string, currentHash: string): boolean {
    const record = this.getByPath(path);
    if (!record) return true;
    return record.hash !== currentHash;
  }

  public deleteByPath(path: string): void {
    const stmt = prepareCached(this.db, 'DELETE FROM files WHERE path = ?');
    stmt.run(path);
  }

  public listByLayer(layer: Layer): FileRecord[] {
    const stmt = prepareCached(this.db, 'SELECT * FROM files WHERE layer = ?');
    return (stmt.all(layer) as FileRow[]).map((r) => this.mapRow(r));
  }

  private mapRow(row: FileRow): FileRecord {
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
