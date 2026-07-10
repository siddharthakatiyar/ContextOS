import { Database } from 'better-sqlite3';
import { Chunk, Layer, ChunkStats } from './types.js';
import { sanitizeFTSQuery } from './fts-sanitizer.js';
import path from 'path';

export interface ScoredChunk extends Chunk {
  score: number;
}

export interface SearchOpts {
  layer?: Layer;
  limit?: number;
}

export class ChunksRepo {
  constructor(private db: Database) {}

  public upsert(chunk: Chunk): void {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (
        id, source_file, layer, workspace_name, section_title, section_depth,
        content, summary, keywords, hash, importance, token_count,
        file_type, language, symbol_name, symbol_kind, parent_symbol,
        created_at, updated_at
      ) VALUES (
        @id, @sourceFile, @layer, @workspaceName, @sectionTitle, @sectionDepth,
        @content, @summary, @keywords, @hash, @importance, @tokenCount,
        @fileType, @language, @symbolName, @symbolKind, @parentSymbol,
        @createdAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        source_file = excluded.source_file,
        layer = excluded.layer,
        workspace_name = excluded.workspace_name,
        section_title = excluded.section_title,
        section_depth = excluded.section_depth,
        content = excluded.content,
        summary = excluded.summary,
        keywords = excluded.keywords,
        hash = excluded.hash,
        importance = excluded.importance,
        token_count = excluded.token_count,
        file_type = excluded.file_type,
        language = excluded.language,
        symbol_name = excluded.symbol_name,
        symbol_kind = excluded.symbol_kind,
        parent_symbol = excluded.parent_symbol,
        updated_at = excluded.updated_at
    `);
    stmt.run({
      ...chunk,
      fileType: chunk.fileType || null,
      language: chunk.language || null,
      symbolName: chunk.symbolName || null,
      symbolKind: chunk.symbolKind || null,
      parentSymbol: chunk.parentSymbol || null,
    });
  }

  public bulkUpsert(chunks: Chunk[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO chunks (
        id, source_file, layer, workspace_name, section_title, section_depth,
        content, summary, keywords, hash, importance, token_count,
        file_type, language, symbol_name, symbol_kind, parent_symbol,
        created_at, updated_at
      ) VALUES (
        @id, @sourceFile, @layer, @workspaceName, @sectionTitle, @sectionDepth,
        @content, @summary, @keywords, @hash, @importance, @tokenCount,
        @fileType, @language, @symbolName, @symbolKind, @parentSymbol,
        @createdAt, @updatedAt
      ) ON CONFLICT(id) DO UPDATE SET
        source_file = excluded.source_file,
        layer = excluded.layer,
        workspace_name = excluded.workspace_name,
        section_title = excluded.section_title,
        section_depth = excluded.section_depth,
        content = excluded.content,
        summary = excluded.summary,
        keywords = excluded.keywords,
        hash = excluded.hash,
        importance = excluded.importance,
        token_count = excluded.token_count,
        file_type = excluded.file_type,
        language = excluded.language,
        symbol_name = excluded.symbol_name,
        symbol_kind = excluded.symbol_kind,
        parent_symbol = excluded.parent_symbol,
        updated_at = excluded.updated_at
    `);
    const transaction = this.db.transaction((items: Chunk[]) => {
      for (const item of items) {
        stmt.run({
          ...item,
          fileType: item.fileType || null,
          language: item.language || null,
          symbolName: item.symbolName || null,
          symbolKind: item.symbolKind || null,
          parentSymbol: item.parentSymbol || null,
        });
      }
    });
    transaction(chunks);
  }

  public deleteBySource(sourceFile: string): void {
    const stmt = this.db.prepare('DELETE FROM chunks WHERE source_file = ?');
    stmt.run(sourceFile);
  }

  public findByLayer(layer: Layer, limit: number = 100): Chunk[] {
    const stmt = this.db.prepare('SELECT * FROM chunks WHERE layer = ? LIMIT ?');
    return (stmt.all(layer, limit) as any[]).map(r => this.mapRow(r)) as Chunk[];
  }

  public searchFTS(query: string, opts?: SearchOpts): ScoredChunk[] {
    let sql = `
      SELECT c.*, bm25(chunks_fts, 10.0, 1.0, 20.0, 8.0) AS score
      FROM chunks_fts
      JOIN chunks c ON chunks_fts.rowid = c.rowid
      WHERE chunks_fts MATCH ?
    `;
    const sanitizedQuery = sanitizeFTSQuery(query);
    const params: any[] = [sanitizedQuery];
    
    if (opts?.layer) {
      sql += ` AND c.layer = ?`;
      params.push(opts.layer);
    }
    
    sql += ` ORDER BY score LIMIT ?`;
    params.push(opts?.limit ?? 30);
    
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(r => this.mapRow(r)) as ScoredChunk[];
  }

  public findByKeyword(keyword: string): Chunk[] {
    const sql = `
      SELECT c.*, bm25(chunks_fts, 10.0, 1.0, 20.0, 8.0) AS score
      FROM chunks_fts
      JOIN chunks c ON chunks_fts.rowid = c.rowid
      WHERE chunks_fts MATCH 'keywords:' || ?
      ORDER BY score LIMIT 20
    `;
    const stmt = this.db.prepare(sql);
    const sanitizedKeyword = sanitizeFTSQuery(keyword);
    const rows = stmt.all(`"${sanitizedKeyword.replace(/"/g, '""')}"`) as any[];
    return rows.map(r => this.mapRow(r)) as Chunk[];
  }

  public findByTitleMatch(concept: string): Chunk[] {
    const stmt = this.db.prepare(`SELECT * FROM chunks WHERE section_title LIKE ? LIMIT 20`);
    return (stmt.all(`%${concept}%`) as any[]).map(r => this.mapRow(r)) as Chunk[];
  }

  public findBySymbolName(name: string): Chunk[] {
    // Exact or prefix match only — avoid '%Session%' hitting createSession via substring
    const stmt = this.db.prepare(`
      SELECT * FROM chunks
      WHERE symbol_name = ? COLLATE NOCASE
         OR symbol_name LIKE ? ESCAPE '\\'
      LIMIT 20
    `);
    const prefix = name.replace(/[%_\\]/g, '\\$&') + '%';
    return (stmt.all(name, prefix) as any[]).map(r => this.mapRow(r)) as Chunk[];
  }

  /** Looser symbol search for concept tokens (e.g. schema → SCHEMA_SQL). */
  public findBySymbolFuzzy(name: string): Chunk[] {
    if (!name || name.length < 5) return [];
    const stmt = this.db.prepare(`
      SELECT * FROM chunks
      WHERE lower(symbol_name) LIKE '%' || lower(?) || '%'
      LIMIT 15
    `);
    return (stmt.all(name) as any[]).map(r => this.mapRow(r)) as Chunk[];
  }

  public findByParentSymbol(name: string): Chunk[] {
    const stmt = this.db.prepare(`
      SELECT * FROM chunks
      WHERE parent_symbol = ? COLLATE NOCASE
      LIMIT 30
    `);
    return (stmt.all(name) as any[]).map(r => this.mapRow(r)) as Chunk[];
  }

  /**
   * Find chunks whose source_file basename stem matches a prompt token
   * (e.g. "scoring" -> scorer.ts, "schema" -> schema.ts).
   */
  public findByFileStem(stem: string, limit: number = 20): Chunk[] {
    if (!stem || stem.length < 3) return [];
    const stemLower = stem.toLowerCase();
    const like = `%${stemLower}%`;
    const stmt = this.db.prepare(`
      SELECT * FROM chunks
      WHERE lower(source_file) LIKE ?
      LIMIT ?
    `);
    const rows = stmt.all(like, limit * 8) as any[];
    const scored = rows.map(r => {
      const parts = (r.source_file || '').toLowerCase().split(/[/\\]/);
      const base = parts[parts.length - 1] || '';
      const fileStem = base.replace(/\.[^.]+$/, '');
      let rank = 0;
      if (fileStem === stemLower) rank = 3;
      else if (fileStem.includes(stemLower) || stemLower.includes(fileStem)) rank = 2;
      else if (parts.some((p: string) => p === stemLower)) rank = 1;
      else rank = 0;
      return { row: r, rank };
    }).filter(x => x.rank > 0);
    scored.sort((a, b) => b.rank - a.rank);
    return scored.slice(0, limit).map(x => this.mapRow(x.row)) as Chunk[];
  }

  public getByIds(ids: string[]): Chunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = this.db.prepare(`SELECT * FROM chunks WHERE id IN (${placeholders})`);
    return (stmt.all(...ids) as any[]).map(r => this.mapRow(r)) as Chunk[];
  }

  public getFeedbackAdjustments(chunkIds: string[]): Record<string, number> {
    if (!chunkIds || chunkIds.length === 0) return {};
    
    // Check if table exists (in case running on older db)
    try {
      const placeholders = chunkIds.map(() => '?').join(',');
      const results = this.db.prepare(`
        SELECT chunk_id, SUM(score_adjustment) as total_adjustment
        FROM feedback_signals
        WHERE chunk_id IN (${placeholders})
        GROUP BY chunk_id
      `).all(...chunkIds) as any[];

      const adjustments: Record<string, number> = {};
      for (const r of results) {
        adjustments[r.chunk_id] = r.total_adjustment;
      }
      return adjustments;
    } catch (e) {
      // Table might not exist yet
      return {};
    }
  }

  public getStats(): ChunkStats {
    const totalRow = this.db.prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM chunks').get() as any;
    const layersRow = this.db.prepare('SELECT layer, COUNT(*) as c FROM chunks GROUP BY layer').all() as any[];
    
    const stats: ChunkStats = {
      totalChunks: totalRow.c || 0,
      totalTokens: totalRow.t || 0,
      byLayer: { global: 0, workspace: 0, repo: 0, session: 0 }
    };
    
    for (const r of layersRow) {
      stats.byLayer[r.layer as Layer] = r.c;
    }
    
    return stats;
  }

  private mapRow(row: any): any {
    return {
      id: row.id,
      sourceFile: row.source_file,
      layer: row.layer,
      workspaceName: row.workspace_name,
      sectionTitle: row.section_title,
      sectionDepth: row.section_depth,
      content: row.content,
      summary: row.summary,
      keywords: row.keywords,
      hash: row.hash,
      importance: row.importance,
      tokenCount: row.token_count,
      fileType: row.file_type,
      language: row.language,
      symbolName: row.symbol_name,
      symbolKind: row.symbol_kind,
      parentSymbol: row.parent_symbol ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      score: row.score !== undefined ? Math.abs(row.score) : undefined
    };
  }
}
