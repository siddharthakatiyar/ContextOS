import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  GraphStore,
  type Evidence,
  type VerifiedFact,
  type VerifiedLink
} from '../knowledge/graph-store.js';
import { transitionStatus, type KnowledgeStatus } from '../knowledge/write-context.js';
import { getContextOSHome } from '../storage/database.js';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { entityRef, parseRef } from '../workspace/identity.js';

export interface VerificationScope {
  /** Explicit view IDs also select records whose views have since disappeared. */
  viewIds?: string[];
  home?: string;
  cwd?: string;
  group?: string;
}
export type VerifyScope = VerificationScope | string;
export type StaleReason = 'file deleted' | 'chunk removed' | 'content changed' | 'view missing';
export type VerificationOutcome =
  'still-valid' | 'evidence moved' | 'stale' | 'unverifiable' | 'deferred';
export interface VerificationItem {
  id: string;
  kind: 'fact' | 'link' | 'legacy-fact';
  outcome: VerificationOutcome;
  status: KnowledgeStatus;
  reason?: StaleReason;
  refs?: { from: string; to: string }[];
  applied: boolean;
}
export interface VerificationReport {
  dryRun: boolean;
  checked: number;
  counts: Record<VerificationOutcome, number>;
  items: VerificationItem[];
}
export interface VerifyOptions {
  scope?: VerifyScope;
  dryRun?: boolean;
  limit?: number;
  /** Only records updated or last verified at/after this epoch millisecond. */
  since?: number;
}
interface Row {
  id: string;
  payload: string;
  status: KnowledgeStatus;
  verified_at: number | null;
  stale_reason: string | null;
}
type RecordData = VerifiedFact | VerifiedLink;

/** Own only short-lived read handles; never acquire, steal or wait on an indexing lease. */
class VerificationSession {
  readonly registry: WorkspaceRegistry;
  readonly graph: GraphStore;
  readonly home: string;
  readonly viewIds?: string[];
  private indexes = new Map<string, Database.Database>();
  constructor(scope: VerifyScope = {}) {
    const config = typeof scope === 'string' ? {} : scope;
    this.home = config.home ?? getContextOSHome();
    this.registry = new WorkspaceRegistry(this.home);
    this.registry.deferReconciliation = true;
    try {
      this.viewIds =
        typeof scope === 'string'
          ? scope === 'all'
            ? undefined
            : scope.startsWith('group:')
              ? this.registry.list(scope.slice(6), true).map((s) => s.repoId)
              : scope.startsWith('project:')
                ? this.registry.views(scope.slice(8)).map((s) => s.repoId)
                : [scope.startsWith('view:') ? scope.slice(5) : this.registry.resolve(scope).repoId]
          : (config.viewIds ??
            (config.group
              ? this.registry.list(config.group, true).map((s) => s.repoId)
              : config.cwd
                ? [this.registry.resolve(config.cwd).repoId]
                : undefined));
      this.graph = new GraphStore({ home: this.home, resolve: (id) => this.resolve(id) });
    } catch (error) {
      this.registry.close();
      throw error;
    }
  }
  resolve(id: string) {
    const source = this.registry.resolve(id);
    let db = this.indexes.get(id);
    if (!db) {
      db = new Database(source.dbPath, { readonly: true, fileMustExist: true });
      db.pragma('busy_timeout = 0');
      this.indexes.set(id, db);
    }
    return { source, db };
  }
  selected(record: RecordData): boolean {
    const ids = 'viewIds' in record ? record.viewIds : record.evidence.map((e) => e.viewId);
    // A sweep for one affected view must also inspect cross-view links in full.
    return !this.viewIds || ids.some((id) => this.viewIds!.includes(id));
  }
  inspect(e: Evidence): { evidence?: Evidence; reason?: StaleReason; deferred?: boolean } {
    let resolved;
    try {
      resolved = this.resolve(e.viewId);
    } catch {
      return { reason: 'view missing' };
    }
    const { source, db } = resolved;
    if (
      !source.active ||
      ['unavailable', 'removed', 'inactive', 'deleting'].includes(source.state) ||
      !fs.existsSync(source.rootPath)
    )
      return { reason: 'view missing' };
    // A live owner can be watching an idle ready index. Read only; the validator
    // and optimistic generation checks fence concurrent index writes.
    if (source.state !== 'ready') return { deferred: true };
    if (!fs.existsSync(e.file)) return { reason: 'file deleted' };
    const parsed = parseRef(e.ref);
    if (!parsed || parsed.repoId !== e.viewId || parsed.kind !== 'chunk')
      return { reason: 'chunk removed' };
    const old = db.prepare('SELECT hash FROM chunks WHERE id=?').get(parsed.localId) as
      { hash: string } | undefined;
    const candidates = db
      .prepare('SELECT id FROM chunks WHERE source_file IN (?,?) AND hash=? ORDER BY id')
      .all(e.file, path.relative(source.rootPath, e.file), e.chunkHash) as { id: string }[];
    // An unchanged hash is required even when a symbol name matches: changed code
    // cannot automatically establish the original claim. Ambiguous anchors stay stale.
    const ref =
      old?.hash === e.chunkHash
        ? e.ref
        : candidates.length === 1
          ? entityRef(e.viewId, 'chunk', candidates[0].id)
          : undefined;
    if (!ref) return { reason: old || candidates.length > 1 ? 'content changed' : 'chunk removed' };
    try {
      const current = this.graph.captureEvidence(ref, source.generation);
      if (current.file !== e.file || current.chunkHash !== e.chunkHash)
        return { reason: 'content changed' };
      return { evidence: current };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('changed since indexing') || message.includes('escapes'))
        return { reason: 'content changed' };
      if (message.includes('chunk does not exist')) return { reason: 'chunk removed' };
      return { deferred: true };
    }
  }
  close() {
    this.graph.close();
    for (const db of this.indexes.values()) db.close();
    this.registry.close();
  }
}

function emptyReport(dryRun: boolean): VerificationReport {
  return {
    dryRun,
    checked: 0,
    counts: { 'still-valid': 0, 'evidence moved': 0, stale: 0, unverifiable: 0, deferred: 0 },
    items: []
  };
}

/** Revalidate durable evidence through the same validator used by ctx_link/ctx_remember.
 * dryRun defaults to false for programmatic sweeps; CLI requires explicit --fix.
 * Proposed claims retain proposed status: source freshness is not a review decision.
 */
export async function verifyKnowledge(options: VerifyOptions = {}): Promise<VerificationReport> {
  const { dryRun = false, limit = Number.MAX_SAFE_INTEGER, since } = options;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error('limit must be a non-negative integer');
  if (since !== undefined && (!Number.isSafeInteger(since) || since < 0))
    throw new Error('since must be an epoch millisecond timestamp');
  const report = emptyReport(dryRun);
  const session = new VerificationSession(options.scope);
  const db = new Database(path.join(session.home, 'graph.db'));
  db.pragma('busy_timeout = 0');
  const add = (item: VerificationItem) => {
    report.items.push(item);
    report.counts[item.outcome]++;
    report.checked++;
  };
  try {
    for (const table of ['verified_facts', 'verified_links'] as const) {
      const rows = db
        .prepare(`SELECT id,payload,status,verified_at,stale_reason FROM ${table} ORDER BY id`)
        .all() as Row[];
      for (const row of rows) {
        if (report.checked >= limit) break;
        const record = JSON.parse(row.payload) as RecordData;
        if (
          !session.selected(record) ||
          (since !== undefined && Math.max(record.updatedAt, row.verified_at ?? 0) < since)
        )
          continue;
        const item: VerificationItem = {
          id: row.id,
          kind: table === 'verified_facts' ? 'fact' : 'link',
          outcome: 'unverifiable',
          status: row.status,
          applied: false
        };
        if (!record.evidence.length) {
          add(item);
          continue;
        }
        const generations = new Map(
          record.evidence.map((e) => {
            try {
              const source = session.registry.resolve(e.viewId);
              return [
                e.viewId,
                `${source.generation}:${source.checkoutGeneration}:${source.state}`
              ] as const;
            } catch {
              return [e.viewId, 'missing'] as const;
            }
          })
        );
        const checks = record.evidence.map((e) => session.inspect(e));
        const changedDuringCheck = [...generations].some(([id, stamp]) => {
          try {
            const source = session.registry.resolve(id);
            return stamp !== `${source.generation}:${source.checkoutGeneration}:${source.state}`;
          } catch {
            return stamp !== 'missing';
          }
        });
        // Never apply a partial cross-view validation while another view is indexing.
        if (changedDuringCheck || checks.some((c) => c.deferred)) {
          item.outcome = 'deferred';
          add(item);
          continue;
        }
        const reason = checks.find((c) => c.reason)?.reason;
        const evidence = checks.map((c) => c.evidence!);
        const moved =
          !reason &&
          evidence.some(
            (e, i) => e.ref !== record.evidence[i].ref || e.fileHash !== record.evidence[i].fileHash
          );
        item.outcome = reason ? 'stale' : moved ? 'evidence moved' : 'still-valid';
        item.reason = reason;
        const target = reason ? 'stale' : row.status === 'stale' ? 'verified' : row.status;
        if (target !== row.status) transitionStatus(row.status, target);
        item.status = target;
        if (moved)
          item.refs = evidence.map((e, i) => ({ from: record.evidence[i].ref, to: e.ref }));
        if (!dryRun) {
          const now = Date.now();
          const updated: RecordData = {
            ...record,
            status: target,
            staleReason: reason ?? null,
            verifiedAt: reason ? row.verified_at : now
          };
          if (!reason) {
            updated.evidence = evidence;
            if ('source' in updated) {
              const refs = new Map(record.evidence.map((e, i) => [e.ref, evidence[i].ref]));
              updated.source = refs.get(updated.source) ?? updated.source;
              updated.target = refs.get(updated.target) ?? updated.target;
            }
          }
          db.transaction(() => {
            const identity =
              'source' in updated
                ? JSON.stringify([updated.source, updated.target, updated.type])
                : undefined;
            if (
              identity &&
              db.prepare(`SELECT id FROM ${table} WHERE identity=? AND id<>?`).get(identity, row.id)
            ) {
              item.outcome = 'deferred';
              item.status = row.status;
              return;
            }
            // Fence another verifier or agent replacing the claim while this pass yields.
            const change = db
              .prepare(
                `UPDATE ${table} SET identity=COALESCE(?,identity),payload=?,status=?,verified_at=?,stale_reason=? WHERE id=? AND payload=? AND status=? AND verified_at IS ? AND stale_reason IS ?`
              )
              .run(
                identity ?? null,
                JSON.stringify(updated),
                target,
                updated.verifiedAt,
                reason ?? null,
                row.id,
                row.payload,
                row.status,
                row.verified_at,
                row.stale_reason
              );
            if (change.changes) {
              db.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
              item.applied = true;
            } else {
              item.outcome = 'deferred';
              item.status = row.status;
            }
          })();
        }
        add(item);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    // Legacy facts have no source-evidence fields in the current schema.
    for (const source of session.registry.listAll()) {
      if (session.viewIds && !session.viewIds.includes(source.repoId)) continue;
      if (report.checked >= limit) break;
      try {
        const index = session.resolve(source.repoId).db;
        const rows = index
          .prepare('SELECT id,status,updated_at,verified_at FROM knowledge_facts ORDER BY id')
          .all() as {
          id: string;
          status: KnowledgeStatus;
          updated_at: number;
          verified_at: number | null;
        }[];
        for (const row of rows) {
          if (report.checked >= limit) break;
          if (since !== undefined && Math.max(row.updated_at, row.verified_at ?? 0) < since)
            continue;
          add({
            id: row.id,
            kind: 'legacy-fact',
            outcome: 'unverifiable',
            status: row.status,
            applied: false
          });
        }
      } catch {
        /* Missing views cannot expose legacy records. */
      }
    }
    return report;
  } finally {
    db.close();
    session.close();
  }
}

export interface StalenessSummary {
  total: number;
  byStatus: Record<KnowledgeStatus, number>;
  byReason: Record<string, number>;
}
/** Stored lifecycle counts only; does not trigger validation or visibility pruning. */
export function getStalenessSummary(scope?: VerifyScope): StalenessSummary {
  const session = new VerificationSession(scope);
  const db = new Database(path.join(session.home, 'graph.db'), { readonly: true });
  const summary: StalenessSummary = {
    total: 0,
    byStatus: { proposed: 0, verified: 0, stale: 0 },
    byReason: {}
  };
  const add = (status: KnowledgeStatus, reason: string | null) => {
    summary.total++;
    summary.byStatus[status]++;
    if (reason) summary.byReason[reason] = (summary.byReason[reason] ?? 0) + 1;
  };
  try {
    for (const table of ['verified_facts', 'verified_links']) {
      for (const row of db.prepare(`SELECT * FROM ${table}`).all() as Row[]) {
        if (session.selected(JSON.parse(row.payload))) add(row.status, row.stale_reason);
      }
    }
    for (const source of session.registry.listAll()) {
      if (session.viewIds && !session.viewIds.includes(source.repoId)) continue;
      try {
        for (const row of session
          .resolve(source.repoId)
          .db.prepare('SELECT status,stale_reason FROM knowledge_facts')
          .all() as { status: KnowledgeStatus; stale_reason: string | null }[])
          add(row.status, row.stale_reason);
      } catch {
        /* unavailable legacy index */
      }
    }
    return summary;
  } finally {
    db.close();
    session.close();
  }
}
