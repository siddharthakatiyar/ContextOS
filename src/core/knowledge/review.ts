import { GraphStore, type Evidence } from './graph-store.js';
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
import { recordKnowledgeOperation, sessionKnowledgeMetadata } from './audit.js';

export interface KnowledgeReviewOptions {
  /** Defaults to the active view in cwd. A resolved scope avoids reconciliation. */
  scope?: ScopeSelectors | RetrievalScope;
  cwd?: string;
  home?: string;
  reviewer?: string;
}
export interface KnowledgeRecord extends KnowledgeMetadata {
  id: string;
  kind: 'fact' | 'link' | 'legacy_fact' | 'session_note';
  author?: string;
  taskId?: string;
  model?: string;
  status: KnowledgeStatus;
  scope: 'view' | 'project' | 'group';
  scopeId: string;
  viewIds: string[];
  createdAt?: number;
  updatedAt?: number;
  evidence?: unknown[];
  payload?: Record<string, unknown>;
  content?: string;
  source?: string;
  target?: string;
}
interface LocatedRecord {
  record: KnowledgeRecord;
  db: Database.Database;
  table: 'verified_facts' | 'verified_links' | 'knowledge_facts' | 'session_events';
  eventId?: number;
}

function resolveScope(
  options: KnowledgeReviewOptions,
  registry: WorkspaceRegistry
): RetrievalScope & { reviewGroupIds?: string[] } {
  if (options.scope && 'sources' in options.scope) return options.scope;
  if (
    options.scope?.allRepos &&
    options.scope?.allWorktrees &&
    !options.scope.group &&
    !options.scope.workspace
  ) {
    const sources = registry.listAll();
    return {
      sources,
      repoIds: sources.map((s) => s.repoId),
      reviewGroupIds: registry.groups().map((g) => g.id)
    };
  }
  return registry.select(options.scope ?? {}, options.cwd ?? process.cwd());
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
            return resolveScope(options, registry);
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
                ? (scope.groupId ?? scope.workspaceId) === payload.scopeId ||
                  ('reviewGroupIds' in scope &&
                    (scope.reviewGroupIds as string[]).includes(payload.scopeId))
                : viewIds.length > 0 && viewIds.every((id) => scope.repoIds.includes(id));
          if (!inScope) continue;
          rows.push({
            db: graph,
            table,
            record: {
              payload,
              evidence: payload.evidence,
              createdAt: payload.createdAt,
              updatedAt: payload.updatedAt,
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
    const notes = sessionKnowledgeMetadata(options.home);
    for (const source of scope.sources) {
      const db = open(source.dbPath);
      if (!db || !db.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_facts'").get())
        continue;
      for (const event of db
        .prepare("SELECT * FROM session_events WHERE event_type='system_response'")
        .all() as Array<Record<string, unknown>>) {
        const id = `session:note:${event.session_id}:${event.id}`;
        const metadata = notes.get(id);
        if (!metadata) continue;
        rows.push({
          db,
          table: 'session_events',
          eventId: event.id as number,
          record: {
            ...metadata,
            id,
            kind: 'session_note',
            status: metadata.status ?? 'verified',
            content: event.content as string,
            createdAt: event.created_at as number,
            scope: 'view',
            scopeId: source.repoId,
            viewIds: [source.repoId]
          }
        });
      }
      for (const row of db.prepare('SELECT * FROM knowledge_facts ORDER BY id').all() as Array<
        Record<string, unknown>
      >) {
        rows.push({
          db,
          table: 'knowledge_facts',
          record: {
            id: row.id as string,
            kind: 'legacy_fact',
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
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
    /** Administrative sweeps and rollback previews only. */
    includeExpired?: boolean;
    taskId?: string;
    author?: string;
  } = {}
): KnowledgeRecord[] {
  return withRecords(options, (rows) =>
    rows
      .map((r) => r.record)
      .filter(
        (r) =>
          (options.includeExpired || r.expiresAt == null || r.expiresAt > Date.now()) &&
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
    for (const { record } of selected) {
      if (record.kind === 'session_note' && status !== 'verified')
        throw new Error(
          'Session notes cannot change review status; save an evidence-backed fact first.'
        );
      transitionStatus(record.status, status);
    }
    const verifiedAt = Date.now();
    for (const db of new Set(selected.map((r) => r.db)))
      db.transaction(() => {
        for (const row of selected.filter((r) => r.db === db)) {
          if (status === 'verified')
            recordKnowledgeOperation(
              'accept',
              row.record.id,
              { author: options.reviewer ?? process.env.USER ?? 'cli' },
              options.home
            );
          if (row.table === 'session_events') continue;
          const result = db
            .prepare(
              `UPDATE ${row.table} SET status=?, verified_at=CASE WHEN ?='verified' THEN ? ELSE verified_at END, stale_reason=NULL WHERE id=? AND status=?`
            )
            .run(status, status, verifiedAt, row.record.id, row.record.status);
          if (result.changes !== 1)
            throw new Error('Knowledge changed during review; refresh and retry.');
        }
        if (selected.some((r) => r.db === db && r.table.startsWith('verified_')))
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

export function deleteKnowledge(
  ids: string[],
  options: KnowledgeReviewOptions & {
    dryRun?: boolean;
    operation?: 'reject' | 'expire' | 'rollback';
  } = {}
) {
  return withRecords(options, (rows) => {
    const wanted = new Set(ids);
    const selected = rows.filter((r) => wanted.has(r.record.id));
    for (const id of wanted)
      if (!selected.some((r) => r.record.id === id))
        throw new Error(`Knowledge not found in selected scope: ${id}`);
    if (!options.dryRun)
      for (const db of new Set(selected.map((r) => r.db)))
        db.transaction(() => {
          for (const row of selected.filter((r) => r.db === db)) {
            recordKnowledgeOperation(
              options.operation ?? (row.record.kind === 'link' ? 'unlink' : 'forget'),
              row.record.id,
              { author: options.reviewer ?? process.env.USER ?? 'cli', taskId: row.record.taskId },
              options.home
            );
            const deleted =
              row.table === 'session_events'
                ? db
                    .prepare(
                      "DELETE FROM session_events WHERE id=? AND session_id=? AND event_type='system_response'"
                    )
                    .run(row.eventId, row.record.id.split(':')[2])
                : db
                    .prepare(
                      `DELETE FROM ${row.table} WHERE id=? AND status=? AND task_id IS ? AND namespace=? AND expires_at IS ?`
                    )
                    .run(
                      row.record.id,
                      row.record.status,
                      row.record.taskId ?? null,
                      row.record.namespace ?? 'project',
                      row.record.expiresAt ?? null
                    );
            if (deleted.changes !== 1)
              throw new Error('Knowledge changed during deletion; refresh and retry.');
          }
          if (selected.some((r) => r.db === db && r.table.startsWith('verified_')))
            db.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
        })();
    return {
      dryRun: Boolean(options.dryRun),
      count: selected.length,
      records: selected.map((r) => r.record)
    };
  });
}

export function deleteByTask(
  taskId: string,
  options: KnowledgeReviewOptions & { dryRun?: boolean; expectedIds?: string[] } = {}
) {
  if (!taskId.trim()) throw new Error('A non-empty task ID is required.');
  const ids = listKnowledge({ ...options, taskId, includeExpired: true }).map((r) => r.id);
  if (
    options.expectedIds &&
    JSON.stringify([...ids].sort()) !== JSON.stringify([...options.expectedIds].sort())
  )
    throw new Error('Task writes changed after preview; rerun rollback.');
  return deleteKnowledge(ids, { ...options, operation: 'rollback' });
}

export function listTasks(options: KnowledgeReviewOptions = {}) {
  const tasks = new Map<
    string,
    {
      taskId: string;
      count: number;
      authors: string[];
      models: string[];
      firstAt: number;
      lastAt: number;
      statuses: Record<string, number>;
    }
  >();
  for (const r of listKnowledge(options)) {
    if (!r.taskId) continue;
    const task = tasks.get(r.taskId) ?? {
      taskId: r.taskId,
      count: 0,
      authors: [],
      models: [],
      firstAt: Infinity,
      lastAt: 0,
      statuses: {}
    };
    task.count++;
    if (r.author && !task.authors.includes(r.author)) task.authors.push(r.author);
    if (r.model && !task.models.includes(r.model)) task.models.push(r.model);
    task.firstAt = Math.min(task.firstAt, r.createdAt ?? 0);
    task.lastAt = Math.max(task.lastAt, r.updatedAt ?? r.createdAt ?? 0);
    task.statuses[r.status] = (task.statuses[r.status] ?? 0) + 1;
    tasks.set(r.taskId, task);
  }
  return [...tasks.values()].sort((a, b) => a.taskId.localeCompare(b.taskId));
}

export function sweepExpiredKnowledge(options: KnowledgeReviewOptions = {}, now = Date.now()) {
  return deleteKnowledge(
    listKnowledge({ ...options, includeExpired: true })
      .filter((r) => r.expiresAt != null && r.expiresAt <= now)
      .map((r) => r.id),
    { ...options, reviewer: options.reviewer ?? 'contextos:expiry', operation: 'expire' }
  );
}

/** CLI selector syntax shared by review and task commands. */
export function reviewScope(selector?: string): ScopeSelectors {
  if (!selector) return {};
  if (selector === 'all') return { allRepos: true, allWorktrees: true };
  const colon = selector.indexOf(':');
  const kind = selector.slice(0, colon),
    value = selector.slice(colon + 1);
  if (colon > 0 && kind === 'group') return { group: value, allWorktrees: true };
  if (colon > 0 && kind === 'project') return { project: [value], allWorktrees: true };
  if (colon > 0 && kind === 'view') return { repo: [value] };
  return { repo: [selector] };
}

/** Promotion retains evidence ownership; broad scope never widens code evidence access. */
export function promoteKnowledge(
  ids: string[],
  to: 'project' | 'group',
  options: KnowledgeReviewOptions & { accept?: boolean } = {}
) {
  if (!['project', 'group'].includes(to))
    throw new Error('Promotion target must be project or group.');
  const registry = new WorkspaceRegistry(options.home ?? getContextOSHome());
  const opened: Database.Database[] = [];
  const graph = new GraphStore({
    home: options.home,
    resolve: (id) => {
      const source = registry.resolve(id);
      const db = new Database(source.dbPath, { readonly: true, fileMustExist: true });
      opened.push(db);
      return { source, db };
    }
  });
  try {
    const scope =
      options.scope && 'sources' in options.scope ? options.scope : resolveScope(options, registry);
    return withRecords({ ...options, scope }, (rows) => {
      const selected = rows.filter((r) => ids.includes(r.record.id));
      for (const id of new Set(ids))
        if (!selected.some((r) => r.record.id === id))
          throw new Error(`Knowledge not found in selected scope: ${id}`);
      const plans = selected.map((row) => {
        const r = row.record;
        if (r.expiresAt != null && r.expiresAt <= Date.now())
          throw new Error('Expired knowledge cannot be promoted.');
        if (r.status !== 'verified' && !(r.status === 'proposed' && options.accept))
          throw new Error('Promotion requires verified status or proposed status with --accept.');
        if (!row.table.startsWith('verified_'))
          throw new Error(
            'Promotion requires a graph fact or link with explicit provenance and evidence.'
          );
        const payload = { ...r.payload! };
        const evidence = (payload.evidence ?? []) as Evidence[];
        if (payload.provenance !== 'user' && !evidence.length)
          throw new Error('Code knowledge promotion requires evidence.');
        for (const saved of evidence) {
          const source = scope.sources.find((s) => s.repoId === saved.viewId);
          if (!source) throw new Error('Evidence outside selected scope.');
          const current = graph.captureEvidence(saved.ref, source.generation);
          if (current.chunkHash !== saved.chunkHash || current.fileHash !== saved.fileHash)
            throw new Error('Evidence changed; reverify before promotion.');
        }
        const projects = [
          ...new Set(
            r.viewIds
              .map((id) => scope.sources.find((s) => s.repoId === id)?.projectId)
              .filter(Boolean)
          )
        ];
        const destination =
          to === 'group'
            ? (scope.groupId ?? scope.workspaceId)
            : r.scope === 'project'
              ? r.scopeId
              : projects.length === 1
                ? projects[0]
                : undefined;
        if (!destination)
          throw new Error('Promotion requires one project or an explicitly selected group.');
        if (to === 'project' && r.scope === 'group')
          throw new Error('Group knowledge cannot be narrowed to a project by promotion.');
        if (r.kind === 'fact') {
          payload.scope = to;
          payload.scopeId = destination;
        }
        const identity =
          r.kind === 'fact'
            ? JSON.stringify([
                payload.scope,
                payload.scopeId,
                (payload.content as string).trim().toLocaleLowerCase(),
                ...(to === 'project' ? [] : [to])
              ])
            : JSON.stringify([
                payload.source,
                payload.target,
                payload.type,
                ...(to === 'project' ? [] : [to])
              ]);
        if (
          row.db
            .prepare(`SELECT id FROM ${row.table} WHERE identity=? AND id<>?`)
            .get(identity, r.id)
        )
          throw new Error('Promotion conflicts with existing knowledge.');
        return { row, payload, identity, at: Date.now() };
      });
      for (const db of new Set(plans.map((p) => p.row.db)))
        db.transaction(() => {
          for (const { row, payload, identity, at } of plans.filter((p) => p.row.db === db)) {
            recordKnowledgeOperation(
              'promote',
              row.record.id,
              {
                author: options.reviewer ?? process.env.USER ?? 'cli',
                namespace: to,
                taskId: row.record.taskId
              },
              options.home
            );
            if (row.record.status === 'proposed')
              recordKnowledgeOperation(
                'accept',
                row.record.id,
                { author: options.reviewer ?? process.env.USER ?? 'cli' },
                options.home
              );
            const changed = db
              .prepare(
                `UPDATE ${row.table} SET identity=?, namespace=?, expires_at=NULL, status='verified', verified_at=?, stale_reason=NULL, payload=? WHERE id=? AND status=? AND expires_at IS ?`
              )
              .run(
                identity,
                to,
                at,
                JSON.stringify(payload),
                row.record.id,
                row.record.status,
                row.record.expiresAt ?? null
              );
            if (changed.changes !== 1)
              throw new Error('Knowledge changed during promotion; refresh and retry.');
          }
          db.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
        })();
      return plans.map(({ row, payload, at }) => ({
        ...row.record,
        payload,
        scope: (payload.scope ?? row.record.scope) as KnowledgeRecord['scope'],
        scopeId: (payload.scopeId ?? row.record.scopeId) as string,
        namespace: to,
        expiresAt: null,
        status: 'verified' as const,
        verifiedAt: at
      }));
    });
  } finally {
    graph.close();
    for (const db of opened) db.close();
    registry.close();
  }
}
