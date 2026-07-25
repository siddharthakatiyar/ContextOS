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
  start_line INTEGER,
  end_line INTEGER,
  file_stem TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(source_file) REFERENCES files(path) ON DELETE CASCADE
);

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
  UNIQUE(source, target, relationship_type, source_chunk_id)
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

CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id TEXT PRIMARY KEY,
  embedding BLOB NOT NULL,
  dims INTEGER NOT NULL,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
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

CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_file);
CREATE INDEX IF NOT EXISTS idx_chunks_layer ON chunks(layer);
CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(hash);
CREATE INDEX IF NOT EXISTS idx_chunks_file_stem ON chunks(file_stem COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON chunks(symbol_name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_chunks_parent_symbol ON chunks(parent_symbol COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source);
CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
CREATE INDEX IF NOT EXISTS idx_knowledge_facts_category ON knowledge_facts(category);
CREATE INDEX IF NOT EXISTS idx_feedback_chunk ON feedback_signals(chunk_id);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_symbol_fts USING fts5(
  symbol_name,
  content=chunks,
  content_rowid=rowid,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_symbol_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_symbol_fts(rowid, symbol_name)
  VALUES (new.rowid, new.symbol_name);
END;

CREATE TRIGGER IF NOT EXISTS chunks_symbol_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_symbol_fts(chunks_symbol_fts, rowid, symbol_name)
  VALUES ('delete', old.rowid, old.symbol_name);
END;

CREATE TRIGGER IF NOT EXISTS chunks_symbol_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_symbol_fts(chunks_symbol_fts, rowid, symbol_name)
  VALUES ('delete', old.rowid, old.symbol_name);
  INSERT INTO chunks_symbol_fts(rowid, symbol_name)
  VALUES (new.rowid, new.symbol_name);
END;

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_file_fts USING fts5(
  file_stem,
  source_file,
  content=chunks,
  content_rowid=rowid,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS chunks_file_fts_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_file_fts(rowid, file_stem, source_file)
  VALUES (new.rowid, new.file_stem, new.source_file);
END;

CREATE TRIGGER IF NOT EXISTS chunks_file_fts_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_file_fts(chunks_file_fts, rowid, file_stem, source_file)
  VALUES ('delete', old.rowid, old.file_stem, old.source_file);
END;

CREATE TRIGGER IF NOT EXISTS chunks_file_fts_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_file_fts(chunks_file_fts, rowid, file_stem, source_file)
  VALUES ('delete', old.rowid, old.file_stem, old.source_file);
  INSERT INTO chunks_file_fts(rowid, file_stem, source_file)
  VALUES (new.rowid, new.file_stem, new.source_file);
END;
`;

function getSchemaVersion(db: Database.Database): number {
  const versionRow = db
    .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
    .get() as { version: number } | undefined;
  return versionRow ? versionRow.version : 0;
}

function setSchemaVersion(db: Database.Database, version: number): void {
  const updateStmt = db.prepare('UPDATE schema_version SET version = ?');
  if (updateStmt.run(version).changes === 0) {
    db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (?)').run(version);
  }
}

/** Triggers for chunks_fts — kept as a function so the SQL is not indexed as a top-level const. */
function chunksFtsTriggersSql(): string {
  return `
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
`;
}

/** Create or recreate chunks_fts with porter+prefix, falling back to unicode61+prefix. */
function ensureChunksFts(db: Database.Database, rebuild: boolean): void {
  const hasFts = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chunks_fts'")
    .get();

  if (hasFts && !rebuild) {
    // Ensure triggers exist for existing FTS table
    db.exec(chunksFtsTriggersSql());
    return;
  }

  db.exec(`
    DROP TRIGGER IF EXISTS chunks_ai;
    DROP TRIGGER IF EXISTS chunks_ad;
    DROP TRIGGER IF EXISTS chunks_au;
    DROP TABLE IF EXISTS chunks_fts;
  `);

  const createWithPorter = `
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content,
      summary,
      keywords,
      section_title,
      content=chunks,
      content_rowid=rowid,
      tokenize='porter unicode61',
      prefix='2 3'
    );
  `;
  const createUnicode61 = `
    CREATE VIRTUAL TABLE chunks_fts USING fts5(
      content,
      summary,
      keywords,
      section_title,
      content=chunks,
      content_rowid=rowid,
      tokenize='unicode61',
      prefix='2 3'
    );
  `;

  try {
    db.exec(createWithPorter);
  } catch {
    console.error('FTS porter tokenizer unavailable; falling back to unicode61 with prefix');
    db.exec(createUnicode61);
  }

  db.exec(chunksFtsTriggersSql());

  if (rebuild) {
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`);
  }
}

/** Migrate relationships UNIQUE to include source_chunk_id (B9). */
function migrateRelationshipsUnique(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships_v5 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      target TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      weight REAL DEFAULT 1.0,
      source_chunk_id TEXT NOT NULL,
      layer TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY(source_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
      UNIQUE(source, target, relationship_type, source_chunk_id)
    );
  `);

  db.exec(`
    INSERT OR IGNORE INTO relationships_v5
      (id, source, target, relationship_type, weight, source_chunk_id, layer, created_at)
    SELECT id, source, target, relationship_type, weight, source_chunk_id, layer, created_at
    FROM relationships;
  `);

  db.exec(`DROP TABLE relationships;`);
  db.exec(`ALTER TABLE relationships_v5 RENAME TO relationships;`);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target);
  `);
}

function migrateToV5(db: Database.Database): void {
  console.error('Migrating ContextOS database to v0.6.0 (schema v5)...');

  // Chunk columns
  for (const col of [
    'ALTER TABLE chunks ADD COLUMN start_line INTEGER',
    'ALTER TABLE chunks ADD COLUMN end_line INTEGER',
    'ALTER TABLE chunks ADD COLUMN file_stem TEXT'
  ]) {
    try {
      db.exec(col);
    } catch {
      // column may already exist
    }
  }

  // Backfill file_stem from source_file basename
  try {
    const rows = db
      .prepare(`SELECT id, source_file FROM chunks WHERE file_stem IS NULL OR file_stem = ''`)
      .all() as { id: string; source_file: string }[];
    const update = db.prepare('UPDATE chunks SET file_stem = ? WHERE id = ?');
    for (const row of rows) {
      const base = row.source_file.replace(/\\/g, '/').split('/').pop() || row.source_file;
      const stem = base.includes('.') ? base.replace(/\.[^.]+$/, '') : base;
      update.run(stem, row.id);
    }
  } catch {
    // Best-effort; indexer will set file_stem on reindex
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_file_stem ON chunks(file_stem);
    CREATE INDEX IF NOT EXISTS idx_chunks_symbol_name ON chunks(symbol_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_chunks_parent_symbol ON chunks(parent_symbol);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunk_embeddings (
      chunk_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      dims INTEGER NOT NULL,
      model TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
    );
  `);

  try {
    migrateRelationshipsUnique(db);
  } catch (e: any) {
    console.error(`Relationship UNIQUE migration failed: ${e.message}`);
  }

  try {
    ensureChunksFts(db, true);
  } catch (e: any) {
    console.error(`FTS rebuild failed: ${e.message}`);
  }

  setSchemaVersion(db, 5);
}

function migrateToV6(db: Database.Database): void {
  console.error('Migrating ContextOS database to v0.7.0 (schema v6)...');

  db.exec(`
    DROP INDEX IF EXISTS idx_chunks_parent_symbol;
    DROP INDEX IF EXISTS idx_chunks_file_stem;
    CREATE INDEX idx_chunks_parent_symbol ON chunks(parent_symbol COLLATE NOCASE);
    CREATE INDEX idx_chunks_file_stem ON chunks(file_stem COLLATE NOCASE);
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_symbol_fts USING fts5(
      symbol_name, content=chunks, content_rowid=rowid, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_symbol_fts_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_symbol_fts(rowid, symbol_name) VALUES (new.rowid, new.symbol_name);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_symbol_fts_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_symbol_fts(chunks_symbol_fts, rowid, symbol_name) VALUES ('delete', old.rowid, old.symbol_name);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_symbol_fts_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_symbol_fts(chunks_symbol_fts, rowid, symbol_name) VALUES ('delete', old.rowid, old.symbol_name);
      INSERT INTO chunks_symbol_fts(rowid, symbol_name) VALUES (new.rowid, new.symbol_name);
    END;
    INSERT INTO chunks_symbol_fts(chunks_symbol_fts) VALUES ('rebuild');
  `);

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_file_fts USING fts5(
      file_stem, source_file, content=chunks, content_rowid=rowid, tokenize='trigram'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_file_fts_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_file_fts(rowid, file_stem, source_file) VALUES (new.rowid, new.file_stem, new.source_file);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_file_fts_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_file_fts(chunks_file_fts, rowid, file_stem, source_file) VALUES ('delete', old.rowid, old.file_stem, old.source_file);
    END;
    CREATE TRIGGER IF NOT EXISTS chunks_file_fts_au AFTER UPDATE ON chunks BEGIN
      INSERT INTO chunks_file_fts(chunks_file_fts, rowid, file_stem, source_file) VALUES ('delete', old.rowid, old.file_stem, old.source_file);
      INSERT INTO chunks_file_fts(rowid, file_stem, source_file) VALUES (new.rowid, new.file_stem, new.source_file);
    END;
    INSERT INTO chunks_file_fts(chunks_file_fts) VALUES ('rebuild');
  `);

  setSchemaVersion(db, 6);
}

export function applyMigrations(db: Database.Database) {
  // First ensure schema_version table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
  `);

  const runMigrations = db.transaction(() => {
    const currentVersion = getSchemaVersion(db);

    if (currentVersion === 0) {
      // We are either a new database or upgrading from 0.1.0 where schema_version didn't exist
      // If files table exists, it's an upgrade
      const hasFiles = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files'")
        .get();

      if (hasFiles) {
        console.error('Migrating ContextOS database to v0.2.0...');
        try {
          db.exec(`
            ALTER TABLE chunks ADD COLUMN file_type TEXT;
            ALTER TABLE chunks ADD COLUMN language TEXT;
            ALTER TABLE chunks ADD COLUMN symbol_name TEXT;
            ALTER TABLE chunks ADD COLUMN symbol_kind TEXT;
          `);
        } catch {
          // columns might already exist if migration partially failed
        }
      }

      // Run the full schema SQL to ensure all tables (like sessions) exist
      db.exec(SCHEMA_SQL);
      ensureChunksFts(db, !!hasFiles);

      if (hasFiles) {
        setSchemaVersion(db, 3);
      } else {
        // Fresh DB: SCHEMA_SQL already has v5 shape; stamp as 5
        db.prepare('INSERT OR IGNORE INTO schema_version (version) VALUES (5)').run();
      }
    } else if (currentVersion === 1) {
      console.error('Migrating ContextOS database to v0.3.0 (Cross-Session Memory)...');
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
      console.error('Migrating ContextOS database to v0.4.0 (Adaptive Scoring)...');
      try {
        // Version 3 adds feedback_signals
        db.exec(SCHEMA_SQL);
        db.prepare('UPDATE schema_version SET version = 3').run();
      } catch (e: any) {
        console.error(`Migration to v3 failed: ${e.message}`);
      }
    }

    // Refresh version after possible upgrades above
    let afterVersion = getSchemaVersion(db);

    if (afterVersion === 3) {
      console.error('Migrating ContextOS database to v0.5.0 (parent_symbol)...');
      try {
        db.exec(`ALTER TABLE chunks ADD COLUMN parent_symbol TEXT;`);
      } catch {
        // column may already exist
      }
      try {
        db.exec(SCHEMA_SQL);
        setSchemaVersion(db, 4);
      } catch (e: any) {
        console.error(`Migration to v4 failed: ${e.message}`);
      }
    }

    afterVersion = getSchemaVersion(db);

    if (afterVersion === 4) {
      try {
        migrateToV5(db);
      } catch (e: any) {
        console.error(`Migration to v5 failed: ${e.message}`);
      }
    }

    // Legacy path: upgraded from pre-schema_version with hasFiles stamped to 3,
    // then v4, then need v5. Also handle DBs that somehow sit at 3 after fresh SCHEMA_SQL
    // that already includes v5 tables — still run column/FTS migration if needed.
    afterVersion = getSchemaVersion(db);
    if (afterVersion < 5 && afterVersion > 0) {
      // Catch-up: if we're at 3 and SCHEMA_SQL created v5-shaped tables on a partial upgrade
      if (afterVersion === 3) {
        try {
          db.exec(`ALTER TABLE chunks ADD COLUMN parent_symbol TEXT;`);
        } catch {
          /* exists */
        }
        setSchemaVersion(db, 4);
      }
      if (getSchemaVersion(db) === 4) {
        try {
          migrateToV5(db);
        } catch (e: any) {
          console.error(`Migration to v5 failed: ${e.message}`);
        }
      }
    }

    afterVersion = getSchemaVersion(db);
    if (afterVersion === 5) {
      try {
        migrateToV6(db);
      } catch (e: any) {
        console.error(`Migration to v6 failed: ${e.message}`);
      }
    }
  });

  runMigrations();
}
