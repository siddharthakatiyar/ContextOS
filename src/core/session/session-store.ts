import crypto from 'crypto';
import { Database } from 'better-sqlite3';
import { DB } from '../storage/database.js';
import { sanitizeFTSQuery } from '../storage/fts-sanitizer.js';

export interface Session {
  id: string;
  startedAt: number;
  repoRoot: string | null;
  metadata: string | null;
}

export interface SessionEvent {
  id?: number;
  sessionId: string;
  eventType: 'user_prompt' | 'system_response' | 'error' | 'context_retrieved';
  content: string;
  relatedFiles: string | null;
  createdAt: number;
}

/** Default session max age before rotation (B22). */
export const SESSION_ROTATION_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  /** Delete rows older than this many days. */
  maxAgeDays?: number;
  /** Keep at most this many newest rows (by created_at). */
  maxCount?: number;
}

/**
 * Whether the latest session should be rotated (older than 24h or missing).
 * SessionManager (Agent C) can call this before reusing a session.
 */
export function shouldRotateSession(
  session: Session | null,
  maxAgeMs: number = SESSION_ROTATION_MS
): boolean {
  if (!session) return true;
  return Date.now() - session.startedAt > maxAgeMs;
}

export class SessionStore {
  private db: Database;

  constructor(dbInstance: DB) {
    this.db = dbInstance.getInstance();
  }

  public createSession(repoRoot?: string, metadata?: any): Session {
    const id = crypto.randomUUID();
    const startedAt = Date.now();
    const session: Session = {
      id,
      startedAt,
      repoRoot: repoRoot || null,
      metadata: metadata ? JSON.stringify(metadata) : null
    };

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, started_at, repo_root, metadata)
      VALUES (@id, @startedAt, @repoRoot, @metadata)
    `);
    stmt.run(session);
    return session;
  }

  public getSession(id: string): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      repoRoot: row.repo_root,
      metadata: row.metadata
    };
  }

  public getLatestSession(): Session | null {
    const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT 1');
    const row = stmt.get() as any;
    if (!row) return null;
    return {
      id: row.id,
      startedAt: row.started_at,
      repoRoot: row.repo_root,
      metadata: row.metadata
    };
  }

  public addEvent(event: Omit<SessionEvent, 'id' | 'createdAt'>): SessionEvent {
    const createdAt = Date.now();
    const newEvent = { ...event, createdAt };

    const stmt = this.db.prepare(`
      INSERT INTO session_events (session_id, event_type, content, related_files, created_at)
      VALUES (@sessionId, @eventType, @content, @relatedFiles, @createdAt)
    `);
    const info = stmt.run(newEvent);
    return { ...newEvent, id: info.lastInsertRowid as number };
  }

  public getRecentEvents(sessionId: string, limit: number = 10): SessionEvent[] {
    const stmt = this.db.prepare(`
      SELECT * FROM session_events 
      WHERE session_id = ? 
      ORDER BY created_at DESC 
      LIMIT ?
    `);
    const rows = stmt.all(sessionId, limit) as any[];
    return rows.reverse().map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      content: row.content,
      relatedFiles: row.related_files,
      createdAt: row.created_at
    }));
  }

  public searchSessionEvents(
    query: string,
    sessionId?: string,
    limit: number = 10
  ): SessionEvent[] {
    let sql = `
      SELECT e.*, bm25(session_events_fts) AS score
      FROM session_events_fts fts
      JOIN session_events e ON fts.rowid = e.id
      WHERE session_events_fts MATCH ?
    `;
    const sanitizedQuery = sanitizeFTSQuery(query);
    const params: any[] = [sanitizedQuery];

    if (sessionId) {
      sql += ' AND e.session_id = ?';
      params.push(sessionId);
    }

    sql += ' ORDER BY score LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      content: row.content,
      relatedFiles: row.related_files,
      createdAt: row.created_at
    }));
  }

  /**
   * Delete prompts older than maxAgeDays and/or over maxCount (B22).
   * Returns number of rows deleted.
   */
  public prunePrompts(opts: PruneOptions = { maxAgeDays: 30, maxCount: 5000 }): number {
    let deleted = 0;
    if (opts.maxAgeDays != null && opts.maxAgeDays > 0) {
      const cutoff = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
      deleted += this.db.prepare('DELETE FROM prompts WHERE created_at < ?').run(cutoff).changes;
    }
    if (opts.maxCount != null && opts.maxCount > 0) {
      const countRow = this.db.prepare('SELECT COUNT(*) as c FROM prompts').get() as { c: number };
      if (countRow.c > opts.maxCount) {
        const excess = countRow.c - opts.maxCount;
        deleted += this.db
          .prepare(
            `
          DELETE FROM prompts WHERE id IN (
            SELECT id FROM prompts ORDER BY created_at ASC LIMIT ?
          )
        `
          )
          .run(excess).changes;
      }
    }
    return deleted;
  }

  /**
   * Delete session_events older than maxAgeDays and/or over maxCount (B22).
   * Returns number of rows deleted.
   */
  public pruneSessionEvents(opts: PruneOptions = { maxAgeDays: 30, maxCount: 20000 }): number {
    let deleted = 0;
    if (opts.maxAgeDays != null && opts.maxAgeDays > 0) {
      const cutoff = Date.now() - opts.maxAgeDays * 24 * 60 * 60 * 1000;
      deleted += this.db
        .prepare('DELETE FROM session_events WHERE created_at < ?')
        .run(cutoff).changes;
    }
    if (opts.maxCount != null && opts.maxCount > 0) {
      const countRow = this.db.prepare('SELECT COUNT(*) as c FROM session_events').get() as {
        c: number;
      };
      if (countRow.c > opts.maxCount) {
        const excess = countRow.c - opts.maxCount;
        deleted += this.db
          .prepare(
            `
          DELETE FROM session_events WHERE id IN (
            SELECT id FROM session_events ORDER BY created_at ASC LIMIT ?
          )
        `
          )
          .run(excess).changes;
      }
    }
    return deleted;
  }

  /** Run both prompt and session_event retention prunes. */
  public pruneRetention(opts?: { prompts?: PruneOptions; events?: PruneOptions }): {
    promptsDeleted: number;
    eventsDeleted: number;
  } {
    return {
      promptsDeleted: this.prunePrompts(opts?.prompts),
      eventsDeleted: this.pruneSessionEvents(opts?.events)
    };
  }
}
