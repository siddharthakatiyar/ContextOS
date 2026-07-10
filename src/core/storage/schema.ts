import Database from 'better-sqlite3';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  workspace_name TEXT,
  hash TEXT NOT NULL,
  last_indexed INTEGER NOT NULL,
  importance INTEGER DEFAULT 5,
  chunk_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  layer TEXT NOT NULL,
  workspace_name TEXT,
  section_title TEXT,
  section_depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  hash TEXT NOT NULL,
  importance INTEGER DEFAULT 5,
  token_count INTEGER NOT NULL,
  file_type TEXT,
  language TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,
  parent_symbol TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(source_file) REFERENCES files(path) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  content,
  summary,
  keywords,
  section_title,
  content=chunks,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, content, summary, keywords, section_title)
  VALUES (new.rowid, new.content, new.summary, new.keywords, new.section_title);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, summary, keywords, section_title)
  VALUES ('delete', old.rowid, old.content, old.summary, old.keywords, old.section_title);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, content, summary, keywords, section_title)
  VALUES ('delete', old.rowid, old.content, old.summary, old.keywords, old.section_title);
  INSERT INTO chunks_fts(rowid, content, summary, keywords, section_title)
  VALUES (new.rowid, new.content, new.summary, new.keywords, new.section_title);
END;

CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  source_chunk_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(source_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  UNIQUE(source, target, relationship_type)
);

CREATE TABLE IF NOT EXISTS prompts (
  id TEXT PRIMARY KEY,
  prompt TEXT NOT NULL,
  extracted_concepts TEXT,
  retrieved_chunk_ids TEXT,
  compiled_token_count INTEGER,
  latency_ms INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  repo_root TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS session_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  content TEXT NOT NULL,
  related_files TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS session_events_fts USING fts5(
  content,
  content=session_events,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS session_events_ai AFTER INSERT ON session_events BEGIN
  INSERT INTO session_events_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;

CREATE TRIGGER IF NOT EXISTS session_events_ad AFTER DELETE ON session_events BEGIN
  INSERT INTO session_events_fts(session_events_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER IF NOT EXISTS session_events_au AFTER UPDATE ON session_events BEGIN
  INSERT INTO session_events_fts(session_events_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO session_events_fts(rowid, content)
  VALUES (new.rowid, new.content);
END;

CREATE TABLE IF NOT EXISTS knowledge_facts (
  id TEXT PRIMARY KEY,
  fact TEXT NOT NULL,
  confidence REAL DEFAULT 1.0,
  category TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed INTEGER NOT NULL,
  access_count INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_facts_fts USING fts5(
  fact,
  category,
  content=knowledge_facts,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS knowledge_facts_ai AFTER INSERT ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(rowid, fact, category)
  VALUES (new.rowid, new.fact, new.category);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_facts_ad AFTER DELETE ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(knowledge_facts_fts, rowid, fact, category)
  VALUES ('delete', old.rowid, old.fact, old.category);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_facts_au AFTER UPDATE ON knowledge_facts BEGIN
  INSERT INTO knowledge_facts_fts(knowledge_facts_fts, rowid, fact, category)
  VALUES ('delete', old.rowid, old.fact, old.category);
  INSERT INTO knowledge_facts_fts(rowid, fact, category)
  VALUES (new.rowid, new.fact, new.category);
END;

CREATE TABLE IF NOT EXISTS feedback_signals (
  id TEXT PRIMARY KEY,
  chunk_id TEXT NOT NULL,
  score_adjustment REAL NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_file);
CREATE INDEX IF NOT EXISTS idx_chunks_layer ON chunks(layer);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_category ON knowledge_facts(category);
CREATE INDEX IF NOT EXISTS idx_feedback_chunk ON feedback_signals(chunk_id);
`;

export function applyMigrations(db: Database.Database) {
  // First ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `);
  
  const runMigrations = db.transaction(() => {
    const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    const currentVersion = versionRow ? versionRow.version : 0;

    if (currentVersion === 0) {
      // We are either a new database or upgrading from 0.1.0 where schema_version didn't exist
      // If files table exists, it's an upgrade
      const hasFiles = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'").get();
      
      if (hasFiles) {
        console.log('Migrating ContextOS database to v0.2.0...');
        try {
          db.exec(`
            ALTER TABLE chunks ADD COLUMN file_type TEXT;
            ALTER TABLE chunks ADD COLUMN language TEXT;
            ALTER TABLE chunks ADD COLUMN symbol_name TEXT;
            ALTER TABLE chunks ADD COLUMN symbol_kind TEXT;
          `);
        } catch (e: any) {
          // columns might already exist if migration partially failed
        }
      }
      
      // Run the full schema SQL to ensure all tables (like sessions) exist
      db.exec(SCHEMA_SQL);
      
      if (hasFiles) {
        const updateStmt = db.prepare('UPDATE schema_version SET version = 3');
        if (updateStmt.run().changes === 0) {
          db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (3)').run();
        }
      } else {
        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (3)').run();
      }
    } else if (currentVersion === 1) {
      console.log('Migrating ContextOS database to v0.3.0 (Cross-Session Memory)...');
      try {
        // Version 2 adds knowledge_facts
        db.exec(SCHEMA_SQL);
        db.prepare('UPDATE schema_version SET version = 2').run();
        
        // Upgrade straight to version 3
        db.prepare('UPDATE schema_version SET version = 3').run();
      } catch (e: any) {
        console.error(`Migration from v1 failed: ${e.message}`);
      }
    } else if (currentVersion === 2) {
      console.log('Migrating ContextOS database to v0.4.0 (Adaptive Scoring)...');
      try {
        // Version 3 adds feedback_signals
        db.exec(SCHEMA_SQL);
        db.prepare('UPDATE schema_version SET version = 3').run();
      } catch (e: any) {
        console.error(`Migration to v3 failed: ${e.message}`);
      }
    }

    // Refresh version after possible upgrades above
    const afterRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
    const afterVersion = afterRow ? afterRow.version : 0;

    if (afterVersion === 3) {
      console.log('Migrating ContextOS database to v0.5.0 (parent_symbol)...');
      try {
        db.exec(`ALTER TABLE chunks ADD COLUMN parent_symbol TEXT;`);
      } catch (e: any) {
        // column may already exist
      }
      try {
        db.exec(SCHEMA_SQL);
        const updateStmt = db.prepare('UPDATE schema_version SET version = 4');
        if (updateStmt.run().changes === 0) {
          db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (4)').run();
        }
      } catch (e: any) {
        console.error(`Migration to v4 failed: ${e.message}`);
      }
    }
  });

  runMigrations();
}
