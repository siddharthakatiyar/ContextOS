import type Database from 'better-sqlite3';
import { knowledgeColumns } from './write-context.js';
import type { KnowledgeFact } from '../memory/knowledge-store.js';

export function exportKnowledgeFacts(db: Database.Database): KnowledgeFact[] {
  return db
    .prepare('SELECT * FROM knowledge_facts WHERE expires_at IS NULL OR expires_at > ? ORDER BY id')
    .all(Date.now()) as KnowledgeFact[];
}
/** Old exports omitted facts entirely. Missing metadata retains verified/project defaults. */
export function importKnowledgeFacts(
  db: Database.Database,
  rows: Partial<KnowledgeFact>[] = []
): void {
  db.transaction(() => {
    for (const row of rows) {
      if (typeof row.id !== 'string' || typeof row.fact !== 'string')
        throw new Error('Invalid exported knowledge fact.');
      const metadata = knowledgeColumns({
        author: row.author ?? undefined,
        taskId: row.task_id ?? undefined,
        model: row.model ?? undefined,
        status: row.status,
        namespace: row.namespace,
        expiresAt: row.expires_at,
        verifiedAt: row.verified_at,
        staleReason: row.stale_reason
      });
      const fact = {
        id: row.id,
        fact: row.fact,
        confidence: row.confidence ?? 1,
        category: row.category ?? 'general',
        created_at: row.created_at ?? Date.now(),
        updated_at: row.updated_at ?? Date.now(),
        last_accessed: row.last_accessed ?? Date.now(),
        access_count: row.access_count ?? 0,
        ...metadata
      };
      const keys = Object.keys(fact);
      db.prepare(
        `INSERT INTO knowledge_facts (repo_id,${keys.join(',')})
        VALUES ((SELECT value FROM repository_metadata WHERE key='repo_id'),${keys.map((key) => '@' + key).join(',')})
        ON CONFLICT(id) DO UPDATE SET ${keys
          .filter((key) => key !== 'id')
          .map((key) => `${key}=excluded.${key}`)
          .join(',')}`
      ).run(fact);
    }
  })();
}
