import { Database } from 'better-sqlite3';
import { Chunk, Layer, ChunkStats } from './types.js';
import { sanitizeFTSQuery, sanitizeFTSTerm } from './fts-sanitizer.js';
import { prepareCached } from './stmt-cache.js';

export interface ScoredChunk extends Chunk {
  score: number;
}

export interface SearchOpts {
  layer?: Layer;
  layers?: string[];
  limit?: number;
}

export interface QueryFilterOpts {
  layers?: string[];
  limit?: number;
}

interface ChunkRow {
  id: string;
  source_file: string;
  layer: Layer;
  workspace_name: string | null;
  section_title: string | null;
  section_depth: number;
  content: string;
  summary: string | null;
  keywords: string | null;
  hash: string;
  importance: number;
  token_count: number;
  file_type?: Chunk['fileType'];
  language?: string;
  symbol_name?: string | null;
  symbol_kind?: string;
  parent_symbol?: string | null;
  start_line?: number | null;
  end_line?: number | null;
  file_stem?: string | null;
  created_at: number;
  updated_at: number;
  score?: number;
}

interface FeedbackAdjustmentRow {
  chunk_id: string;
  total_adjustment: number;
}

interface ChunkTotalsRow {
  c: number;
  t: number | null;
}

interface LayerCountRow {
  layer: Layer;
  c: number;
}

export class ChunksRepo {
  constructor(private db: Database) {}

  /** Expose the underlying DB for embeddings / cross-repo helpers. */
  public getDatabase(): Database {
    return this.db;
  }

  public upsert(chunk: Chunk): void {
    const stmt = prepareCached(
      this.db,
      `
      INSERT INTO chunks (
        id, source_file, layer, workspace_name, section_title, section_depth,
        content, summary, keywords, hash, importance, token_count,
        file_type, language, symbol_name, symbol_kind, parent_symbol,
        start_line, end_line, file_stem,
        created_at, updated_at
      ) VALUES (
        @id, @sourceFile, @layer, @workspaceName, @sectionTitle, @sectionDepth,
        @content, @summary, @keywords, @hash, @importance, @tokenCount,
        @fileType, @language, @symbolName, @symbolKind, @parentSymbol,
        @startLine, @endLine, @fileStem,
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
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        file_stem = excluded.file_stem,
        updated_at = excluded.updated_at
    `
    );
    stmt.run({
      ...chunk,
      fileType: chunk.fileType || null,
      language: chunk.language || null,
      symbolName: chunk.symbolName || null,
      symbolKind: chunk.symbolKind || null,
      parentSymbol: chunk.parentSymbol || null,
      startLine: chunk.startLine ?? null,
      endLine: chunk.endLine ?? null,
      fileStem: chunk.fileStem || null
    });
  }

  public bulkUpsert(chunks: Chunk[]): void {
    const stmt = prepareCached(
      this.db,
      `
      INSERT INTO chunks (
        id, source_file, layer, workspace_name, section_title, section_depth,
        content, summary, keywords, hash, importance, token_count,
        file_type, language, symbol_name, symbol_kind, parent_symbol,
        start_line, end_line, file_stem,
        created_at, updated_at
      ) VALUES (
        @id, @sourceFile, @layer, @workspaceName, @sectionTitle, @sectionDepth,
        @content, @summary, @keywords, @hash, @importance, @tokenCount,
        @fileType, @language, @symbolName, @symbolKind, @parentSymbol,
        @startLine, @endLine, @fileStem,
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
        start_line = excluded.start_line,
        end_line = excluded.end_line,
        file_stem = excluded.file_stem,
        updated_at = excluded.updated_at
    `
    );
    const transaction = this.db.transaction((items: Chunk[]) => {
      for (const item of items) {
        stmt.run({
          ...item,
          fileType: item.fileType || null,
          language: item.language || null,
          symbolName: item.symbolName || null,
          symbolKind: item.symbolKind || null,
          parentSymbol: item.parentSymbol || null,
          startLine: item.startLine ?? null,
          endLine: item.endLine ?? null,
          fileStem: item.fileStem || null
        });
      }
    });
    transaction(chunks);
  }

  public deleteBySource(sourceFile: string): void {
    const stmt = prepareCached(this.db, 'DELETE FROM chunks WHERE source_file = ?');
    stmt.run(sourceFile);
  }

  /** Chunk IDs for a file, collected before deletion so embedding vectors can be garbage-collected. */
  public getIdsBySource(sourceFile: string): string[] {
    const stmt = prepareCached(this.db, 'SELECT id FROM chunks WHERE source_file = ?');
    return (stmt.all(sourceFile) as { id: string }[]).map((row) => row.id);
  }

  public findByLayer(layer: Layer, limit: number = 100): Chunk[] {
    const stmt = prepareCached(this.db, 'SELECT * FROM chunks WHERE layer = ? LIMIT ?');
    return (stmt.all(layer, limit) as ChunkRow[]).map((row) => this.mapRow(row));
  }

  public searchFTS(query: string, opts?: SearchOpts): ScoredChunk[] {
    let sql = `
      SELECT c.*, bm25(chunks_fts, 10.0, 6.0, 20.0, 8.0) AS score
      FROM chunks_fts
      JOIN chunks c ON chunks_fts.rowid = c.rowid
      WHERE chunks_fts MATCH ?
    `;
    // Preserve caller-built OR/AND/NOT; sanitize only inside quoted terms
    const sanitizedQuery = sanitizeFTSQuery(query, { preserveOperators: true });
    const params: unknown[] = [sanitizedQuery];

    if (opts?.layer) {
      sql += ` AND c.layer = ?`;
      params.push(opts.layer);
    } else if (opts?.layers && opts.layers.length > 0) {
      sql += ` AND c.layer IN (${opts.layers.map(() => '?').join(',')})`;
      params.push(...opts.layers);
    }

    sql += ` ORDER BY score LIMIT ?`;
    params.push(opts?.limit ?? 30);

    const stmt = prepareCached(this.db, sql);
    const rows = stmt.all(...params) as ChunkRow[];
    return rows.map((row) => this.mapRow(row) as ScoredChunk);
  }

  public findByKeyword(keyword: string, opts?: QueryFilterOpts): Chunk[] {
    let sql = `
      SELECT c.*, bm25(chunks_fts, 10.0, 6.0, 20.0, 8.0) AS score
      FROM chunks_fts
      JOIN chunks c ON chunks_fts.rowid = c.rowid
      WHERE chunks_fts MATCH 'keywords:' || ?
    `;
    const sanitizedKeyword = sanitizeFTSTerm(keyword);
    const params: unknown[] = [`"${sanitizedKeyword.replace(/"/g, '""')}"`];

    if (opts?.layers && opts.layers.length > 0) {
      sql += ` AND c.layer IN (${opts.layers.map(() => '?').join(',')})`;
      params.push(...opts.layers);
    }

    sql += ` ORDER BY score LIMIT ?`;
    params.push(opts?.limit ?? 20);

    const stmt = prepareCached(this.db, sql);
    const rows = stmt.all(...params) as ChunkRow[];
    return rows.map((row) => this.mapRow(row));
  }

  public findByTitleMatch(concept: string, opts?: QueryFilterOpts): Chunk[] {
    let sql = `SELECT * FROM chunks WHERE section_title LIKE ?`;
    const params: unknown[] = [`%${concept}%`];
    if (opts?.layers && opts.layers.length > 0) {
      sql += ` AND layer IN (${opts.layers.map(() => '?').join(',')})`;
      params.push(...opts.layers);
    }
    sql += ` LIMIT ?`;
    params.push(opts?.limit ?? 20);
    return (prepareCached(this.db, sql).all(...params) as ChunkRow[]).map((row) =>
      this.mapRow(row)
    );
  }

  public findBySymbolName(name: string, opts?: QueryFilterOpts): Chunk[] {
    // Exact or prefix match only — avoid '%Session%' hitting createSession via substring
    let sql = `
      SELECT * FROM chunks
      WHERE (symbol_name = ? COLLATE NOCASE
         OR symbol_name LIKE ? ESCAPE '\\')
    `;
    const prefix = name.replace(/[%_\\]/g, '\\$&') + '%';
    const params: unknown[] = [name, prefix];
    if (opts?.layers && opts.layers.length > 0) {
      sql += ` AND layer IN (${opts.layers.map(() => '?').join(',')})`;
      params.push(...opts.layers);
    }
    sql += ` LIMIT ?`;
    params.push(opts?.limit ?? 20);
    return (prepareCached(this.db, sql).all(...params) as ChunkRow[]).map((row) =>
      this.mapRow(row)
    );
  }

  public findBySymbolFuzzy(name: string, opts?: QueryFilterOpts): Chunk[] {
    if (!name || name.length < 5) return [];
    let sql = `
      SELECT c.*
      FROM chunks_symbol_fts fts
      JOIN chunks c ON fts.rowid = c.rowid
      WHERE fts.symbol_name LIKE ?
    `;
    const params: unknown[] = [`%${name}%`];
    if (opts?.layers && opts.layers.length > 0) {
      sql += ` AND c.layer IN (${opts.layers.map(() => '?').join(',')})`;
      params.push(...opts.layers);
    }
    sql += ` LIMIT ?`;
    params.push(opts?.limit ?? 15);
    return (prepareCached(this.db, sql).all(...params) as ChunkRow[]).map((row) =>
      this.mapRow(row)
    );
  }

  public findByParentSymbol(name: string, opts?: QueryFilterOpts): Chunk[] {
    let sql = `
      SELECT * FROM chunks
      WHERE parent_symbol = ? COLLATE NOCASE
    `;
    const params: unknown[] = [name];
    if (opts?.layers && opts.layers.length > 0) {
      sql += ` AND layer IN (${opts.layers.map(() => '?').join(',')})`;
      params.push(...opts.layers);
    }
    sql += ` LIMIT ?`;
    params.push(opts?.limit ?? 30);
    return (prepareCached(this.db, sql).all(...params) as ChunkRow[]).map((row) =>
      this.mapRow(row)
    );
  }

  public findByFileStem(stem: string, limit: number = 20, opts?: QueryFilterOpts): Chunk[] {
    if (!stem || stem.length < 3) return [];
    const stemLower = stem.toLowerCase();
    const prefix = stemLower.replace(/[%_\\]/g, '\\$&') + '%';
    const contains = '%' + stemLower.replace(/[%_\\]/g, '\\$&') + '%';
    const dirUnix = '%/' + stemLower.replace(/[%_\\]/g, '\\$&') + '/%';
    const dirWin = '%\\' + stemLower.replace(/[%_\\]/g, '\\$&') + '\\%';
    const ftsContains = `%${stemLower}%`;
    const ftsDirUnix = `%/${stemLower}/%`;
    const ftsDirWin = `%\\${stemLower}\\%`;

    let sql = `
      SELECT c.*,
        CASE
          WHEN c.file_stem = ? COLLATE NOCASE THEN 3
          WHEN c.file_stem LIKE ? ESCAPE '\\' THEN 2
          WHEN c.file_stem LIKE ? ESCAPE '\\' THEN 1
          WHEN c.source_file LIKE ? ESCAPE '\\' OR c.source_file LIKE ? ESCAPE '\\' THEN 1
          ELSE 0
        END AS stem_rank,
        CASE
          WHEN c.source_file LIKE '%.test.%' OR c.source_file LIKE '%.spec.%' OR c.source_file LIKE '%/tests/%' THEN 0
          WHEN c.symbol_kind IN ('function', 'method', 'class', 'struct') THEN 2
          WHEN c.symbol_kind = 'file' THEN 1
          ELSE 1
        END AS kind_rank
      FROM chunks_file_fts fts
      JOIN chunks c ON fts.rowid = c.rowid
      WHERE (
        fts.file_stem LIKE ?
        OR fts.source_file LIKE ?
        OR fts.source_file LIKE ?
      )
    `;
    const params: unknown[] = [
      stemLower,
      prefix,
      contains,
      dirUnix,
      dirWin,
      ftsContains,
      ftsDirUnix,
      ftsDirWin
    ];

    const layers = opts?.layers;
    if (layers && layers.length > 0) {
      sql += ` AND c.layer IN (${layers.map(() => '?').join(',')})`;
      params.push(...layers);
    }

    sql += ` ORDER BY stem_rank DESC, kind_rank DESC LIMIT ?`;
    params.push(opts?.limit ?? limit);

    return (prepareCached(this.db, sql).all(...params) as ChunkRow[]).map((row) =>
      this.mapRow(row)
    );
  }

  public getByIds(ids: string[]): Chunk[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    const stmt = prepareCached(this.db, `SELECT * FROM chunks WHERE id IN (${placeholders})`);
    return (stmt.all(...ids) as ChunkRow[]).map((row) => this.mapRow(row));
  }

  public getFeedbackAdjustments(chunkIds: string[]): Record<string, number> {
    if (!chunkIds || chunkIds.length === 0) return {};

    // Check if table exists (in case running on older db)
    try {
      const placeholders = chunkIds.map(() => '?').join(',');
      const results = this.db
        .prepare(
          `
        SELECT chunk_id, SUM(score_adjustment) as total_adjustment
        FROM feedback_signals
        WHERE chunk_id IN (${placeholders})
        GROUP BY chunk_id
      `
        )
        .all(...chunkIds) as FeedbackAdjustmentRow[];

      const adjustments: Record<string, number> = {};
      for (const r of results) {
        adjustments[r.chunk_id] = r.total_adjustment;
      }
      return adjustments;
    } catch {
      // Table might not exist yet
      return {};
    }
  }

  public getStats(): ChunkStats {
    const totalRow = this.db
      .prepare('SELECT COUNT(*) as c, SUM(token_count) as t FROM chunks')
      .get() as ChunkTotalsRow;
    const layersRow = this.db
      .prepare('SELECT layer, COUNT(*) as c FROM chunks GROUP BY layer')
      .all() as LayerCountRow[];

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

  private mapRow(row: ChunkRow): Chunk & { score?: number } {
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
      startLine: row.start_line ?? null,
      endLine: row.end_line ?? null,
      fileStem: row.file_stem ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      score: row.score !== undefined ? Math.abs(row.score) : undefined
    };
  }
}
