import crypto from 'crypto';
import { Database } from 'better-sqlite3';
import { DB } from '../storage/database.js';

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
    return rows.reverse().map(row => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      content: row.content,
      relatedFiles: row.related_files,
      createdAt: row.created_at
    }));
  }

  public searchSessionEvents(query: string, sessionId?: string, limit: number = 10): SessionEvent[] {
    let sql = `
      SELECT e.*, bm25(session_events_fts) AS score
      FROM session_events_fts fts
      JOIN session_events e ON fts.rowid = e.id
      WHERE session_events_fts MATCH ?
    `;
    const params: any[] = [query];
    
    if (sessionId) {
      sql += ' AND e.session_id = ?';
      params.push(sessionId);
    }
    
    sql += ' ORDER BY score LIMIT ?';
    params.push(limit);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];
    return rows.map(row => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      content: row.content,
      relatedFiles: row.related_files,
      createdAt: row.created_at
    }));
  }
}
