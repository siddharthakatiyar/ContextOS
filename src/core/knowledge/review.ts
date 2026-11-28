import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { getContextOSHome } from '../storage/database.js';
import {
  WorkspaceRegistry,
  type ScopeSelectors,
  type RetrievalScope
} from '../workspace/registry.js';
import { transitionStatus, type KnowledgeStatus, type KnowledgeMetadata } from './write-context.js';
import { recordKnowledgeOperation } from './audit.js';

export interface KnowledgeReviewOptions {
  /** Defaults to the active view in cwd. A resolved scope avoids reconciliation. */
  scope?: ScopeSelectors | RetrievalScope;
  cwd?: string;
  home?: string;
}
export interface KnowledgeRecord extends KnowledgeMetadata {
  id: string;
  kind: 'fact' | 'link' | 'legacy_fact';
  author?: string;
  taskId?: string;
  model?: string;
  status: KnowledgeStatus;
  scope: 'view' | 'project' | 'group';
  scopeId: string;
  viewIds: string[];
  content?: string;
  source?: string;
  target?: string;
}
interface LocatedRecord {
  record: KnowledgeRecord;
  db: Database.Database;
  table: 'verified_facts' | 'verified_links' | 'knowledge_facts';
}

/** Open only existing databases: review never initializes or migrates a project. */
function withRecords<T>(options: KnowledgeReviewOptions, action: (rows: LocatedRecord[]) => T): T {
  const connections: Database.Database[] = [];
  let registry: WorkspaceRegistry | undefined;
  try {
    const scope =
      options.scope && 'sources' in options.scope
        ? options.scope
        : (() => {
            registry = new WorkspaceRegistry(options.home ?? getContextOSHome());
            return registry.select(options.scope ?? {}, options.cwd ?? process.cwd());
          })();
    const rows: LocatedRecord[] = [];
    const open = (file: string) => {
      if (!fs.existsSync(file)) return undefined;
      const db = new Database(file, { fileMustExist: true });
      db.pragma('busy_timeout = 5000');
      connections.push(db);
      return db;
    };
    const graph = open(path.join(options.home ?? getContextOSHome(), 'graph.db'));
    if (graph)
      for (const table of ['verified_facts', 'verified_links'] as const) {
        for (const row of graph.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as Array<
          Record<string, unknown>
        >) {
          const payload = JSON.parse(row.payload as string);
          const viewIds: string[] = payload.viewIds ?? [
            ...new Set(payload.evidence.map((e: { viewId: string }) => e.viewId))
          ];
          const userScope = payload.provenance === 'user';
          const inScope =
            userScope && payload.scope === 'project'
              ? scope.sources.some((s) => s.projectId === payload.scopeId)
              : userScope && payload.scope === 'group'
                ? (scope.groupId ?? scope.workspaceId) === payload.scopeId
                : viewIds.length > 0 && viewIds.every((id) => scope.repoIds.includes(id));
          if (!inScope) continue;
          rows.push({
            db: graph,
            table,
            record: {
              id: row.id as string,
              kind: table === 'verified_links' ? 'link' : 'fact',
              author: (row.author as string | undefined) ?? undefined,
              taskId: (row.task_id as string | undefined) ?? undefined,
              model: (row.model as string | undefined) ?? undefined,
              status: row.status as KnowledgeStatus,
              namespace: row.namespace as string,
              expiresAt: row.expires_at as number | null,
              verifiedAt: row.verified_at as number | null,
              staleReason: row.stale_reason as string | null,
              scope: payload.scope ?? 'view',
              scopeId: payload.scopeId ?? viewIds[0],
              viewIds,
              ...(table === 'verified_links'
                ? { source: payload.source, target: payload.target }
                : { content: payload.content })
            }
          });
        }
      }
    for (const source of scope.sources) {
      const db = open(source.dbPath);
      if (!db || !db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_facts'").get())
        continue;
      for (const row of db.prepare('SELECT * FROM knowledge_facts ORDER BY id').all() as Array<
        Record<string, unknown>
      >) {
        rows.push({
          db,
          table: 'knowledge_facts',
          record: {
            id: row.id as string,
            kind: 'legacy_fact',
            content: row.fact as string,
            author: (row.author as string | undefined) ?? undefined,
            taskId: (row.task_id as string | undefined) ?? undefined,
            model: (row.model as string | undefined) ?? undefined,
            status: row.status as KnowledgeStatus,
            namespace: row.namespace as string,
            expiresAt: row.expires_at as number | null,
            verifiedAt: row.verified_at as number | null,
            staleReason: row.stale_reason as string | null,
            scope: 'view',
            scopeId: source.repoId,
            viewIds: [source.repoId]
          }
        });
      }
    }
    return action(rows);
  } finally {
    for (const db of connections) db.close();
    registry?.close();
  }
}

export function listKnowledge(
  options: KnowledgeReviewOptions & {
    status?: KnowledgeStatus;
    taskId?: string;
    author?: string;
  } = {}
): KnowledgeRecord[] {
  return withRecords(options, (rows) =>
    rows
      .map((r) => r.record)
      .filter(
        (r) =>
          (options.status === undefined || r.status === options.status) &&
          (options.taskId === undefined || r.taskId === options.taskId) &&
          (options.author === undefined || r.author === options.author)
      )
  );
}

/** Validate the whole selection before any writes. Each database commits atomically;
 * multiple databases are intentionally not claimed to be one atomic transaction.
 */
export function setKnowledgeStatus(
  ids: string[],
  status: KnowledgeStatus,
  options: KnowledgeReviewOptions = {}
): KnowledgeRecord[] {
  return withRecords(options, (rows) => {
    const wanted = new Set(ids);
    const selected = rows.filter((r) => wanted.has(r.record.id));
    for (const id of wanted)
      if (!selected.some((r) => r.record.id === id))
        throw new Error(`Knowledge not found in selected scope: ${id}`);
    for (const { record } of selected) transitionStatus(record.status, status);
    const verifiedAt = Date.now();
    for (const db of new Set(selected.map((r) => r.db)))
      db.transaction(() => {
        for (const row of selected.filter((r) => r.db === db)) {
          const result = db
            .prepare(
              `UPDATE ${row.table} SET status=?, verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END, stale_reason=NULL WHERE id=? AND status=?`
            )
            .run(status, status, verifiedAt, row.record.id, row.record.status);
          if (result.changes !== 1)
            throw new Error('Knowledge changed during review; refresh and retry.');
        }
        if (selected.some((r) => r.db === db && r.table !== 'knowledge_facts'))
          db.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
      })();
    return selected.map(({ record }) => ({
      ...record,
      status,
      verifiedAt: status === 'verified' ? verifiedAt : record.verifiedAt,
      staleReason: null
    }));
  });
}

export function deleteByTask(
  taskId: string,
  options: KnowledgeReviewOptions & { dryRun?: boolean } = {}
): { dryRun: boolean; count: number; records: KnowledgeRecord[] } {
  if (!taskId.trim()) throw new Error('A non-empty task ID is required.');
  return withRecords(options, (rows) => {
    const selected = rows.filter((r) => r.record.taskId === taskId);
    if (!options.dryRun)
      for (const db of new Set(selected.map((r) => r.db)))
        db.transaction(() => {
          for (const row of selected.filter((r) => r.db === db)) {
            recordKnowledgeOperation(
              row.record.kind === 'link' ? 'unlink' : 'forget',
              row.record.id,
              undefined,
              options.home
            );
            const deleted = db
              .prepare(`DELETE FROM ${row.table} WHERE id=? AND task_id=?`)
              .run(row.record.id, taskId);
            if (deleted.changes !== 1)
              throw new Error('Knowledge changed during deletion; refresh and retry.');
          }
          if (selected.some((r) => r.db === db && r.table !== 'knowledge_facts'))
            db.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
        })();
    return {
      dryRun: Boolean(options.dryRun),
      count: selected.length,
      records: selected.map((r) => r.record)
    };
  });
}
