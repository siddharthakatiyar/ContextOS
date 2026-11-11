import type Database from 'better-sqlite3';

export const OWNED_TABLES = [
  'files',
  'chunks',
  'relationships',
  'knowledge_facts',
  'sessions',
  'session_events',
  'prompts'
] as const;

/** Local IDs remain unchanged on disk. References crossing database boundaries are qualified. */
export function entityRef(repoId: string, kind: string, localId: string | number): string {
  return `contextos:${repoId}:${kind}:${encodeURIComponent(String(localId))}`;
}

export function parseRef(ref: string): { repoId: string; kind: string; localId: string } | null {
  const match = /^contextos:([^:]+):([^:]+):(.+)$/.exec(ref);
  return match ? { repoId: match[1], kind: match[2], localId: decodeURIComponent(match[3]) } : null;
}

export function bindRepository(db: Database.Database, repoId: string, root: string): void {
  const identity = db.prepare("SELECT value FROM repository_metadata WHERE key='repo_id'").get() as
    { value: string } | undefined;
  const previousRoot = db
    .prepare("SELECT value FROM repository_metadata WHERE key='root_path'")
    .get() as { value: string } | undefined;
  if (identity?.value === repoId && previousRoot?.value === root) return;
  db.transaction(() => {
    if (identity && previousRoot?.value !== root)
      db.prepare("INSERT OR REPLACE INTO repository_metadata VALUES ('needs_reindex', '1')").run();
    db.prepare(
      `INSERT INTO repository_metadata (key, value) VALUES ('repo_id', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(repoId);
    db.prepare(
      `INSERT INTO repository_metadata (key, value) VALUES ('root_path', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(root);
    for (const table of OWNED_TABLES) {
      db.prepare(`UPDATE ${table} SET repo_id = ? WHERE repo_id IS NULL OR repo_id != ?`).run(
        repoId,
        repoId
      );
    }
  })();
}
