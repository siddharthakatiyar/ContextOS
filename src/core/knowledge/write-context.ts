import type Database from 'better-sqlite3';

export const KNOWLEDGE_STATUSES = ['proposed', 'verified', 'stale'] as const;
export type KnowledgeStatus = (typeof KNOWLEDGE_STATUSES)[number];
export interface KnowledgeWriteContext {
  author?: string;
  taskId?: string;
  model?: string;
  status?: KnowledgeStatus;
  namespace?: string;
  expiresAt?: number | null;
}
export interface KnowledgeMetadata extends KnowledgeWriteContext {
  verifiedAt?: number | null;
  staleReason?: string | null;
}
export interface KnowledgeColumns {
  author: string | null;
  task_id: string | null;
  model: string | null;
  status: KnowledgeStatus;
  namespace: string;
  expires_at: number | null;
  verified_at: number | null;
  stale_reason: string | null;
}

/** Explicit parameters override environment; missing values retain historical behavior. */
export function resolveKnowledgeWriteContext(
  params: KnowledgeWriteContext & { task_id?: string; expires_at?: number | null } = {},
  env: NodeJS.ProcessEnv = process.env
): KnowledgeWriteContext {
  const result = {
    author: params.author ?? env.CONTEXTOS_AUTHOR,
    taskId: params.taskId ?? params.task_id ?? env.CONTEXTOS_TASK_ID,
    model: params.model ?? env.CONTEXTOS_MODEL,
    status: params.status ?? 'verified',
    namespace: params.namespace ?? 'project',
    expiresAt: params.expiresAt !== undefined ? params.expiresAt : params.expires_at
  };
  if (!KNOWLEDGE_STATUSES.includes(result.status)) throw new Error('Invalid knowledge status.');
  if (result.expiresAt != null && !Number.isSafeInteger(result.expiresAt))
    throw new Error('expiresAt must be an integer timestamp in milliseconds.');
  return result;
}

/** Validate a lifecycle transition without imposing visibility or review policy. */
export function transitionStatus(from: KnowledgeStatus, to: KnowledgeStatus): KnowledgeStatus {
  if (
    !['proposed:verified', 'verified:stale', 'stale:verified', 'proposed:stale'].includes(
      `${from}:${to}`
    )
  )
    throw new Error(`Invalid knowledge status transition: ${from} -> ${to}`);
  return to;
}

export function knowledgeColumns(input: KnowledgeMetadata = {}): KnowledgeColumns {
  const context = resolveKnowledgeWriteContext(input);
  return {
    author: context.author ?? null,
    task_id: context.taskId ?? null,
    model: context.model ?? null,
    status: context.status!,
    namespace: context.namespace!,
    expires_at: context.expiresAt ?? null,
    verified_at: input.verifiedAt ?? null,
    stale_reason: input.staleReason ?? null
  };
}

/** One additive migration shared by per-view and home-level knowledge stores.
 * Inspect each column so interrupted/partially applied upgrades can safely resume.
 * The caller owns the transaction and schema-version stamp.
 */
export function migrateKnowledgeColumns(db: Database.Database, tables: readonly string[]): void {
  const columns = {
    author: 'TEXT',
    task_id: 'TEXT',
    model: 'TEXT',
    status: "TEXT NOT NULL DEFAULT 'verified' CHECK(status IN ('proposed','verified','stale'))",
    namespace: "TEXT NOT NULL DEFAULT 'project'",
    expires_at: 'INTEGER',
    verified_at: 'INTEGER',
    stale_reason: 'TEXT'
  };
  for (const table of tables) {
    if (!['knowledge_facts', 'verified_links', 'verified_facts'].includes(table))
      throw new Error('Unsupported knowledge table.');
    const existing = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)
    );
    for (const [name, definition] of Object.entries(columns))
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    for (const name of ['task_id', 'status'])
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_${name} ON ${table}(${name})`);
  }
}
