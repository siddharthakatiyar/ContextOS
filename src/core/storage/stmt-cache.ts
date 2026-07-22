import type Database from 'better-sqlite3';

// Prepared statements cached per DB connection. better-sqlite3 recompiles SQL to
// bytecode on every `.prepare()`; on a long-lived daemon connection the same
// fixed queries are prepared thousands of times. Keying on the Database object
// (1-2 per process) means it doesn't matter how many short-lived repo wrappers
// are constructed around the same connection.
const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/**
 * Return a prepared statement for `sql`, cached per connection. ONLY use for
 * FIXED SQL text — never for SQL whose structure varies per call (e.g. a
 * variable-length `IN (?, ?, …)` placeholder list), since each distinct string
 * would create a new cache entry and defeat the purpose. Reusing a compiled
 * statement sequentially is safe (better-sqlite3 is synchronous).
 */
export function prepareCached(db: Database.Database, sql: string): Database.Statement {
  let m = cache.get(db);
  if (!m) {
    m = new Map();
    cache.set(db, m);
  }
  let stmt = m.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    m.set(sql, stmt);
  }
  return stmt;
}
