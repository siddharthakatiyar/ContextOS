import { recordKnowledgeOperation } from './audit.js';
import Database from 'better-sqlite3';
import {
  migrateKnowledgeColumns,
  knowledgeColumns,
  type KnowledgeMetadata,
  type KnowledgeWriteContext,
  type KnowledgeColumns
} from './write-context.js';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getContextOSHome } from '../storage/database.js';
import type { RepositorySource } from '../workspace/registry.js';
import { entityRef, parseRef } from '../workspace/identity.js';
import { hashContent } from '../../utils/hash.js';
import { resolveWithinWorkspace } from '../../utils/fs-guard.js';
import { preparePrivateStateFile, tightenPrivateStateFile } from '../../utils/secure-state.js';
import { traceVerifiedGraph, type TraceOptions, type TraceResult } from './trace.js';
import { readGitCommit } from '../../utils/git-head.js';

export const LINK_TYPES = [
  'imports',
  'implements_contract',
  'calls_api',
  'publishes_event',
  'consumes_event',
  'reads_resource',
  'writes_resource'
] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export interface Evidence {
  ref: string;
  viewId: string;
  projectId?: string;
  file: string;
  fileHash: string;
  chunkHash: string;
  generation: number;
}
export interface VerifiedLink extends KnowledgeMetadata {
  id: string;
  source: string;
  target: string;
  type: LinkType;
  rationale: string;
  evidence: Evidence[];
  /** Missing on historical records, which were agent verified. */
  provenance?: { kind: 'agent' | 'deterministic'; resolver?: string };
  createdAt: number;
  updatedAt: number;
}
export interface VerifiedFact extends KnowledgeMetadata {
  id: string;
  content: string;
  scope: 'view' | 'project' | 'group';
  scopeId: string;
  viewIds: string[];
  provenance: 'code' | 'user';
  category?: string;
  evidence: Evidence[];
  createdAt: number;
  updatedAt: number;
}
export interface GraphSource {
  source: RepositorySource;
  db: Database.Database;
}
export interface GraphOptions {
  home?: string;
  resolve: (viewId: string) => GraphSource;
}
export interface LinkInput extends KnowledgeMetadata {
  source: string;
  target: string;
  type: LinkType;
  rationale: string;
  evidenceRefs?: string[];
  expectedGenerations: Record<string, number>;
}
export interface FactAccess {
  projectIds?: string[];
  groupId?: string;
}
export interface FactInput extends KnowledgeMetadata {
  content: string;
  scope: VerifiedFact['scope'];
  scopeId: string;
  viewIds: string[];
  provenance: VerifiedFact['provenance'];
  category?: string;
  evidenceRefs?: string[];
  expectedGenerations?: Record<string, number>;
}
type StoredRow = { id: string; payload: string };

/** Persistent knowledge metadata; existing evidence freshness checks still govern reads. */
export class GraphStore {
  private db: Database.Database;
  private fileHashes = new Map<string, { stamp: string; hash: string }>();
  constructor(private options: GraphOptions) {
    const file = preparePrivateStateFile(path.join(options.home ?? getContextOSHome(), 'graph.db'));
    this.db = new Database(file);
    tightenPrivateStateFile(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS verified_links (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS verified_facts (id TEXT PRIMARY KEY, identity TEXT NOT NULL UNIQUE, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS graph_metadata (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      INSERT OR IGNORE INTO graph_metadata VALUES ('revision', 0);`);
    this.db.transaction(() => {
      const version = this.db
        .prepare("SELECT value FROM graph_metadata WHERE key='schema_version'")
        .get() as { value: number } | undefined;
      if (!version || version.value < 1) {
        migrateKnowledgeColumns(this.db, ['verified_links', 'verified_facts']);
        this.db.prepare("INSERT OR REPLACE INTO graph_metadata VALUES ('schema_version', 1)").run();
      }
    })();
    this.db
      .exec(`CREATE INDEX IF NOT EXISTS verified_links_source ON verified_links(json_extract(payload,'$.source'));
      CREATE INDEX IF NOT EXISTS verified_links_target ON verified_links(json_extract(payload,'$.target'));`);
  }
  close(): void {
    this.db.close();
  }
  revision(): number {
    return (
      this.db.prepare("SELECT value FROM graph_metadata WHERE key='revision'").get() as {
        value: number;
      }
    ).value;
  }
  private touch(): void {
    this.db.prepare("UPDATE graph_metadata SET value=value+1 WHERE key='revision'").run();
  }
  private assertScope(ref: string, allowed: string[]): string {
    const parsed = parseRef(ref);
    if (!parsed || parsed.kind !== 'chunk')
      throw new Error('Evidence must use a qualified chunk reference.');
    if (!allowed.includes(parsed.repoId))
      throw new Error('Knowledge endpoint is outside the selected views.');
    return parsed.repoId;
  }
  private fileHash(file: string): string {
    // Request/store-local memoization. ctime catches edits that preserve mtime/size;
    // inode catches atomic replacement. Freshness is checked again on every access.
    const stat = fs.statSync(file, { bigint: true });
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = this.fileHashes.get(file);
    if (cached?.stamp === stamp) return cached.hash;
    const hash = hashContent(fs.readFileSync(file, 'utf8'));
    if (this.fileHashes.size >= 512) this.fileHashes.clear();
    this.fileHashes.set(file, { stamp, hash });
    return hash;
  }
  captureEvidence(ref: string, expectedGeneration?: number): Evidence {
    const parsed = parseRef(ref);
    if (!parsed || parsed.kind !== 'chunk')
      throw new Error('Expected a qualified chunk reference.');
    const { source, db } = this.options.resolve(parsed.repoId);
    if (
      source.repoId !== parsed.repoId ||
      source.active === false ||
      ['unavailable', 'removed', 'inactive', 'deleting'].includes(source.state)
    )
      throw new Error('Evidence view is unavailable.');
    if (source.state !== 'ready')
      throw new Error('Evidence view is not ready; complete indexing before saving knowledge.');
    const metadata = new Map(
      (
        db.prepare('SELECT key,value FROM repository_metadata').all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value])
    );
    if (metadata.has('needs_reindex'))
      throw new Error('Evidence index requires reindexing before knowledge writes.');
    if (
      source.viewId &&
      (metadata.get('view_id') !== source.viewId ||
        metadata.get('checkout_generation') !== String(source.checkoutGeneration))
    )
      throw new Error('Evidence checkout generation changed; refresh the view and reindex.');
    if (source.gitDir) {
      if (fs.existsSync(path.join(source.gitDir, 'index.lock')))
        throw new Error('Evidence checkout is in progress; retry after Git completes.');
      const head = fs.readFileSync(path.join(source.gitDir, 'HEAD'), 'utf8').trim();
      const expectedHead = source.branch ? `ref: refs/heads/${source.branch}` : source.head;
      if (!expectedHead || head !== expectedHead)
        throw new Error('Evidence checkout changed; refresh the view and reindex.');
      const commit = readGitCommit(source.gitDir, source.commonDir ?? source.gitDir, head);
      if (commit !== source.head || metadata.get('head') !== (source.head ?? ''))
        throw new Error('Evidence checkout commit changed; refresh the view and reindex.');
    }
    if (expectedGeneration !== undefined && source.generation !== expectedGeneration)
      throw new Error('Evidence generation changed; inspect current evidence and retry.');
    const chunk = db
      .prepare('SELECT source_file, hash FROM chunks WHERE id=?')
      .get(parsed.localId) as { source_file: string; hash: string } | undefined;
    if (!chunk) throw new Error('Evidence chunk does not exist.');
    const file = resolveWithinWorkspace(source.rootPath, chunk.source_file);
    if (!file) throw new Error('Evidence escapes its registered project root.');
    const indexed = db.prepare('SELECT hash FROM files WHERE path=?').get(chunk.source_file) as
      { hash: string } | undefined;
    const fileHash = this.fileHash(file);
    if (!indexed || indexed.hash !== fileHash)
      throw new Error('Evidence file changed since indexing; reindex and inspect it first.');
    return {
      ref,
      viewId: source.repoId,
      projectId: (source as RepositorySource & { projectId?: string }).projectId,
      file,
      fileHash,
      chunkHash: chunk.hash,
      generation: source.generation
    };
  }
  private evidenceStatus(evidence: Evidence[]): 'valid' | 'invalid' | 'unavailable' {
    let unavailable = false;
    for (const item of evidence) {
      try {
        const { source } = this.options.resolve(item.viewId);
        if (
          source.active === false ||
          ['unavailable', 'removed', 'inactive', 'deleting'].includes(source.state) ||
          !fs.existsSync(source.rootPath)
        ) {
          unavailable = true;
          continue;
        }
        const current = this.captureEvidence(item.ref);
        if (
          current.fileHash !== item.fileHash ||
          current.chunkHash !== item.chunkHash ||
          current.file !== item.file
        )
          return 'invalid';
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (
          message.includes('chunk does not exist') ||
          message.includes('changed since indexing') ||
          message.includes('escapes its registered')
        )
          return 'invalid';
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          try {
            if (fs.existsSync(this.options.resolve(item.viewId).source.rootPath)) return 'invalid';
          } catch {
            /* temporarily unavailable source */
          }
        }
        unavailable = true;
      }
    }
    return unavailable ? 'unavailable' : 'valid';
  }
  private visible(
    table: 'verified_links' | 'verified_facts',
    record: VerifiedLink | VerifiedFact
  ): boolean {
    const status = this.evidenceStatus(record.evidence);
    if (status === 'invalid') this.remove(table, record.id);
    return status === 'valid';
  }
  private records<T>(table: 'verified_links' | 'verified_facts'): T[] {
    return (this.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all() as StoredRow[]).map((row) =>
      this.decode<T>(row)
    );
  }
  private decode<T>(row: { payload: string } & Partial<KnowledgeColumns>): T {
    return {
      ...JSON.parse(row.payload),
      author: row.author ?? undefined,
      taskId: row.task_id ?? undefined,
      model: row.model ?? undefined,
      status: row.status ?? 'verified',
      namespace: row.namespace ?? 'project',
      expiresAt: row.expires_at ?? null,
      verifiedAt: row.verified_at ?? null,
      staleReason: row.stale_reason ?? null
    } as T;
  }
  private metadata(input: KnowledgeMetadata): KnowledgeMetadata {
    const c = knowledgeColumns(input);
    return {
      author: c.author ?? undefined,
      taskId: c.task_id ?? undefined,
      model: c.model ?? undefined,
      status: c.status,
      namespace: c.namespace,
      expiresAt: c.expires_at,
      verifiedAt: c.verified_at,
      staleReason: c.stale_reason
    };
  }
  private saveMetadata(
    table: 'verified_links' | 'verified_facts',
    id: string,
    input: KnowledgeMetadata
  ): void {
    const columns = knowledgeColumns(input);
    this.db
      .prepare(
        `UPDATE ${table} SET ${Object.keys(columns)
          .map((key) => `${key}=@${key}`)
          .join(',')} WHERE id=@id`
      )
      .run({ id, ...columns });
  }
  private remove(table: 'verified_links' | 'verified_facts', id: string): boolean {
    const changed = this.db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id).changes > 0;
    if (changed) this.touch();
    return changed;
  }
  pruneInvalid(options: { viewIds?: string[]; affectedViewIds?: string[] } = {}): number {
    let count = 0;
    for (const table of ['verified_links', 'verified_facts'] as const) {
      for (const record of this.records<VerifiedLink | VerifiedFact>(table)) {
        const views =
          'viewIds' in record ? record.viewIds : record.evidence.map((item) => item.viewId);
        if (options.viewIds && views.some((id) => !options.viewIds!.includes(id))) continue;
        const evidence = options.affectedViewIds
          ? record.evidence.filter((item) => options.affectedViewIds!.includes(item.viewId))
          : record.evidence;
        if (options.affectedViewIds && !evidence.length) continue;
        if (this.evidenceStatus(evidence) === 'invalid' && this.remove(table, record.id)) count++;
      }
    }
    return count;
  }
  link(input: LinkInput, permittedViewIds: string[]): VerifiedLink {
    return this.saveLink(input, permittedViewIds, { kind: 'agent' }).link;
  }
  /** Internal resolver entrypoint: never overwrite a live verified agent-authored connection. */
  linkResolvedImport(
    input: LinkInput,
    permittedViewIds: string[]
  ): { link: VerifiedLink; created: boolean } {
    if (input.type !== 'imports') throw new Error('The import resolver can only save imports.');
    return this.saveLink(
      { ...input, author: 'contextos:deterministic', status: 'verified' },
      permittedViewIds,
      {
        kind: 'deterministic',
        resolver: 'literal-local-import-v1'
      },
      true
    );
  }
  private saveLink(
    input: LinkInput,
    permittedViewIds: string[],
    provenance: NonNullable<VerifiedLink['provenance']>,
    insertOnly = false
  ): { link: VerifiedLink; created: boolean } {
    if (!LINK_TYPES.includes(input.type)) throw new Error('Unsupported relationship type.');
    if (!input.rationale.trim()) throw new Error('A verified connection requires a rationale.');
    const identity = JSON.stringify([input.source, input.target, input.type]);
    const old = this.db.prepare('SELECT * FROM verified_links WHERE identity=?').get(identity) as
      { payload: string } | undefined;
    const previous = old ? this.decode<VerifiedLink>(old) : undefined;
    const refs = [...new Set([input.source, input.target, ...(input.evidenceRefs ?? [])])];
    for (const ref of refs) {
      const viewId = this.assertScope(ref, permittedViewIds);
      const generation = input.expectedGenerations[viewId];
      if (!Number.isInteger(generation))
        throw new Error('expected_generations must include every evidence view.');
    }
    if (
      insertOnly &&
      previous &&
      previous.evidence.every((item) => permittedViewIds.includes(item.viewId)) &&
      previous.status === 'verified' &&
      this.visible('verified_links', previous)
    )
      return { link: previous, created: false };
    const evidence = refs.map((ref) =>
      this.captureEvidence(ref, input.expectedGenerations[parseRef(ref)!.repoId])
    );
    const now = Date.now();
    const result: VerifiedLink = {
      ...this.metadata(input),
      id: previous?.id ?? crypto.randomUUID(),
      source: input.source,
      target: input.target,
      type: input.type,
      rationale: input.rationale.trim(),
      evidence,
      provenance,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    return this.db.transaction(() => {
      const change = this.db
        .prepare(
          insertOnly
            ? "INSERT INTO verified_links (id,identity,payload) VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload WHERE verified_links.status='proposed'"
            : 'INSERT INTO verified_links (id,identity,payload) VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload'
        )
        .run(result.id, identity, JSON.stringify(result));
      if (!change.changes) {
        const winner = this.db
          .prepare('SELECT * FROM verified_links WHERE identity=?')
          .get(identity) as { payload: string };
        return { link: this.decode<VerifiedLink>(winner), created: false };
      }
      this.saveMetadata('verified_links', result.id, result);
      this.touch();
      return { link: result, created: true };
    })();
  }
  listLinks(
    options: { viewIds?: string[]; refs?: string[]; excludeIds?: Set<string> } = {}
  ): VerifiedLink[] {
    return this.records<VerifiedLink>('verified_links')
      .filter(
        (link) =>
          !options.excludeIds?.has(link.id) &&
          (!options.viewIds || link.evidence.every((e) => options.viewIds!.includes(e.viewId))) &&
          (!options.refs ||
            options.refs.includes(link.source) ||
            options.refs.includes(link.target))
      )
      .filter((link) => this.visible('verified_links', link));
  }
  expand(
    refs: string[],
    permittedViewIds: string[],
    limit = 12,
    excludeIds?: Set<string>,
    includeProposed = false
  ): { links: VerifiedLink[]; refs: string[] } {
    const links = this.listLinks({ viewIds: permittedViewIds, refs, excludeIds })
      .filter(
        (link) => link.status === 'verified' || (includeProposed && link.status === 'proposed')
      )
      .sort((a, b) => Number(a.status !== 'verified') - Number(b.status !== 'verified'))
      .slice(0, Math.max(0, Math.min(limit, 100)));
    return {
      links,
      refs: [...new Set(links.flatMap((link) => [link.source, link.target]))].filter(
        (ref) => !refs.includes(ref)
      )
    };
  }
  getLink(id: string, permittedViewIds: string[]): VerifiedLink | undefined {
    const link = this.records<VerifiedLink>('verified_links').find((item) => item.id === id);
    link?.evidence.forEach((item) => this.assertScope(item.ref, permittedViewIds));
    return link;
  }
  unlink(id: string, permittedViewIds: string[], context: KnowledgeWriteContext = {}): boolean {
    if (!this.getLink(id, permittedViewIds)) return false;
    recordKnowledgeOperation('unlink', id, context, this.options.home);
    return this.remove('verified_links', id);
  }
  trace(options: TraceOptions, permittedViewIds: string[]): TraceResult {
    if (options.relationships?.some((type) => !LINK_TYPES.includes(type)))
      throw new Error('Unsupported relationship type.');
    return traceVerifiedGraph(options, {
      inspect: (ref) => {
        const view = this.assertScope(ref, permittedViewIds);
        const evidence = this.captureEvidence(ref);
        const { source, db } = this.options.resolve(view);
        const chunk = db
          .prepare('SELECT symbol_name,start_line,end_line FROM chunks WHERE id=?')
          .get(parseRef(ref)!.localId) as {
          symbol_name: string | null;
          start_line: number | null;
          end_line: number | null;
        };
        return {
          ref,
          viewId: view,
          projectId: source.projectId,
          project: source.name,
          worktreeId: source.worktreeId,
          branch: source.branch ?? null,
          head: source.head ?? null,
          relativePath: path.relative(source.rootPath, evidence.file).split(path.sep).join('/'),
          symbol: chunk.symbol_name ?? undefined,
          startLine: chunk.start_line ?? undefined,
          endLine: chunk.end_line ?? undefined,
          evidence
        };
      },
      adjacent: (ref, direction, limit) => {
        const clause =
          direction === 'outgoing'
            ? "json_extract(payload,'$.source')=@ref"
            : direction === 'incoming'
              ? "json_extract(payload,'$.target')=@ref"
              : "(json_extract(payload,'$.source')=@ref OR json_extract(payload,'$.target')=@ref)";
        const rows = this.db
          .prepare(`SELECT * FROM verified_links WHERE ${clause} ORDER BY id`)
          .iterate({ ref });
        const links: VerifiedLink[] = [];
        for (const row of rows) {
          const link = this.decode<VerifiedLink>(row as StoredRow);
          if (!link.evidence.every((item) => permittedViewIds.includes(item.viewId))) continue;
          if (
            link.status !== 'verified' &&
            !(options.includeProposed && link.status === 'proposed')
          )
            continue;
          if (options.relationships && !options.relationships.includes(link.type)) continue;
          links.push(link);
          if (links.length > limit) break;
        }
        return { links: links.slice(0, limit), truncated: links.length > limit };
      },
      sameFile: (ref, limit) => {
        const parsed = parseRef(ref)!;
        const evidence = this.captureEvidence(ref);
        const { db } = this.options.resolve(parsed.repoId);
        const rows = db
          .prepare('SELECT id FROM chunks WHERE source_file=? AND id<>? ORDER BY start_line,id')
          .iterate(evidence.file, parsed.localId);
        const refs: string[] = [];
        for (const row of rows) {
          const candidate = entityRef(parsed.repoId, 'chunk', (row as { id: string }).id);
          // Bridge to connection-bearing chunks only; no exhaustive discovery or writes.
          const connections = this.listLinks({ refs: [candidate], viewIds: permittedViewIds });
          if (
            !connections.some(
              (link) =>
                (link.status === 'verified' ||
                  (options.includeProposed && link.status === 'proposed')) &&
                (!options.relationships || options.relationships.includes(link.type)) &&
                (options.direction === 'incoming'
                  ? link.target === candidate
                  : options.direction === 'outgoing'
                    ? link.source === candidate
                    : true)
            )
          )
            continue;
          refs.push(candidate);
          if (refs.length > limit) break;
        }
        return { refs: refs.slice(0, limit), truncated: refs.length > limit };
      },
      status: (link) => {
        const status = this.evidenceStatus(link.evidence);
        if (status === 'invalid') this.remove('verified_links', link.id);
        return status;
      }
    });
  }
  remember(input: FactInput, permittedViewIds: string[], access: FactAccess = {}): VerifiedFact {
    if (!input.content.trim() || !input.scopeId)
      throw new Error('A fact requires content and explicit scope.');
    if (!input.viewIds.length || input.viewIds.some((id) => !permittedViewIds.includes(id)))
      throw new Error('Fact scope is outside the selected views.');
    if (
      input.scope === 'view' &&
      (input.viewIds.length !== 1 || input.scopeId !== input.viewIds[0])
    )
      throw new Error('View facts belong to exactly one view.');
    if (input.scope === 'group' && access.groupId !== input.scopeId)
      throw new Error('Fact group is outside the selected group scope.');
    if (input.provenance === 'code' && !input.evidenceRefs?.length)
      throw new Error('Code-derived facts require source evidence.');
    const evidence = [...new Set(input.evidenceRefs ?? [])].map((ref) => {
      const view = this.assertScope(ref, input.viewIds);
      const generation = input.expectedGenerations?.[view];
      if (!Number.isInteger(generation))
        throw new Error('expected_generations must include every evidence view.');
      return this.captureEvidence(ref, generation);
    });
    if (input.scope === 'project') {
      for (const viewId of input.viewIds) {
        const source = this.options.resolve(viewId).source as RepositorySource & {
          projectId?: string;
        };
        if ((source.projectId ?? source.repoId) !== input.scopeId)
          throw new Error('Fact views do not belong to the selected project.');
      }
    }
    const identity = JSON.stringify([
      input.scope,
      input.scopeId,
      input.content.trim().toLocaleLowerCase()
    ]);
    const old = this.db.prepare('SELECT * FROM verified_facts WHERE identity=?').get(identity) as
      { payload: string } | undefined;
    const previous = old ? this.decode<VerifiedFact>(old) : undefined;
    const now = Date.now();
    const result: VerifiedFact = {
      ...this.metadata(input.provenance === 'user' ? { ...input, status: 'verified' } : input),
      id: previous?.id ?? crypto.randomUUID(),
      content: input.content.trim(),
      scope: input.scope,
      scopeId: input.scopeId,
      viewIds: [...new Set(input.viewIds)],
      provenance: input.provenance,
      category: input.category,
      evidence,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO verified_facts (id,identity,payload) VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload'
        )
        .run(result.id, identity, JSON.stringify(result));
      this.saveMetadata('verified_facts', result.id, result);
      this.touch();
    })();
    return result;
  }
  searchFacts(
    prompt: string,
    options: { viewIds: string[]; projectIds?: string[]; groupId?: string; limit?: number }
  ): VerifiedFact[] {
    const terms = prompt.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [];
    return this.records<VerifiedFact>('verified_facts')
      .filter((fact) => {
        if (
          (fact.provenance === 'code' || fact.scope === 'view') &&
          fact.viewIds.some((id) => !options.viewIds.includes(id))
        )
          return false;
        return fact.scope === 'view'
          ? options.viewIds.includes(fact.scopeId)
          : fact.scope === 'project'
            ? options.projectIds?.includes(fact.scopeId)
            : options.groupId === fact.scopeId;
      })
      .filter((fact) => this.visible('verified_facts', fact))
      .map((fact) => ({
        fact,
        score: terms.reduce(
          (score, term) => score + Number(fact.content.toLowerCase().includes(term)),
          0
        )
      }))
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          Number(a.fact.status !== 'verified') - Number(b.fact.status !== 'verified') ||
          b.score - a.score ||
          a.fact.id.localeCompare(b.fact.id)
      )
      .slice(0, options.limit ?? 5)
      .map((item) => item.fact);
  }
  forget(
    id: string,
    permittedViewIds: string[],
    access: FactAccess = {},
    context: KnowledgeWriteContext = {}
  ): boolean {
    const fact = this.records<VerifiedFact>('verified_facts').find((item) => item.id === id);
    if (!fact) return false;
    if (fact.provenance === 'user' && fact.scope === 'project') {
      const projectIds =
        access.projectIds ??
        permittedViewIds.map((viewId) => this.options.resolve(viewId).source.projectId);
      if (!projectIds.includes(fact.scopeId))
        throw new Error('Fact belongs to a project outside the selected scope.');
    } else if (fact.provenance === 'user' && fact.scope === 'group') {
      if (access.groupId !== fact.scopeId)
        throw new Error('Fact belongs to a group outside the selected scope.');
    } else if (fact.viewIds.some((view) => !permittedViewIds.includes(view)))
      throw new Error('Fact belongs to views outside the selected scope.');
    recordKnowledgeOperation('forget', id, context, this.options.home);
    return this.remove('verified_facts', id);
  }
  /** Export only knowledge wholly owned by the selected views, preserving provenance. */
  exportKnowledge(viewIds: string[]): { links: VerifiedLink[]; facts: VerifiedFact[] } {
    return {
      links: this.listLinks({ viewIds }),
      facts: this.records<VerifiedFact>('verified_facts')
        .filter((fact) => fact.viewIds.every((id) => viewIds.includes(id)))
        .filter((fact) => this.visible('verified_facts', fact))
    };
  }
  private restoreImportedIdentity(
    table: 'verified_links' | 'verified_facts',
    imported: VerifiedLink | VerifiedFact,
    saved: VerifiedLink | VerifiedFact
  ): void {
    if (
      typeof imported.id !== 'string' ||
      !imported.id ||
      !Number.isSafeInteger(imported.createdAt) ||
      !Number.isSafeInteger(imported.updatedAt)
    )
      throw new Error('Invalid imported knowledge identity or timestamps.');
    const record = {
      ...saved,
      id: imported.id,
      createdAt: imported.createdAt,
      updatedAt: imported.updatedAt
    };
    this.db
      .prepare(`UPDATE ${table} SET id=?, payload=? WHERE id=?`)
      .run(record.id, JSON.stringify(record), saved.id);
  }
  /** Import through normal scope/freshness validation; never trust archived evidence blindly. */
  importKnowledge(
    data: { links?: VerifiedLink[]; facts?: VerifiedFact[] },
    viewIds: string[],
    access: FactAccess = {}
  ): void {
    this.db.transaction(() => {
      const validate = (record: VerifiedLink | VerifiedFact) => {
        const expected: Record<string, number> = {};
        for (const evidence of record.evidence) {
          this.assertScope(evidence.ref, viewIds);
          const current = this.captureEvidence(evidence.ref);
          if (
            current.fileHash !== evidence.fileHash ||
            current.chunkHash !== evidence.chunkHash ||
            current.file !== evidence.file
          )
            throw new Error('Imported evidence changed; inspect it before saving knowledge.');
          expected[current.viewId] = current.generation;
        }
        return expected;
      };
      for (const link of data.links ?? []) {
        const expectedGenerations = validate(link);
        // Keep deterministic provenance only for the exact supported resolver.
        const provenance =
          link.provenance?.kind === 'deterministic' &&
          link.provenance.resolver === 'literal-local-import-v1' &&
          link.type === 'imports'
            ? link.provenance
            : { kind: 'agent' as const };
        const saved = this.saveLink(
          { ...link, evidenceRefs: link.evidence.map((e) => e.ref), expectedGenerations },
          viewIds,
          provenance
        ).link;
        this.restoreImportedIdentity('verified_links', link, saved);
      }
      for (const fact of data.facts ?? []) {
        const saved = this.remember(
          {
            ...fact,
            evidenceRefs: fact.evidence.map((e) => e.ref),
            expectedGenerations: validate(fact)
          },
          viewIds,
          access
        );
        this.restoreImportedIdentity('verified_facts', fact, saved);
      }
    })();
  }
  invalidateView(viewId: string): number {
    return this.invalidate(
      (item) =>
        item.evidence.some((e) => e.viewId === viewId) ||
        ('viewIds' in item &&
          !(item.provenance === 'user' && item.scope !== 'view') &&
          item.viewIds.includes(viewId))
    );
  }
  invalidateProject(projectId: string): number {
    return this.invalidate(
      (item) =>
        ('scope' in item && item.scope === 'project' && item.scopeId === projectId) ||
        item.evidence.some((e) => e.projectId === projectId)
    );
  }
  invalidateGroup(groupId: string): number {
    return this.invalidate(
      (item) => 'scope' in item && item.scope === 'group' && item.scopeId === groupId
    );
  }
  invalidateFile(viewId: string, file: string): number {
    return this.invalidate((item) =>
      item.evidence.some((e) => e.viewId === viewId && path.resolve(e.file) === path.resolve(file))
    );
  }
  private invalidate(matches: (item: VerifiedLink | VerifiedFact) => boolean): number {
    let count = 0;
    for (const table of ['verified_links', 'verified_facts'] as const)
      for (const item of this.records<VerifiedLink | VerifiedFact>(table))
        if (matches(item) && this.remove(table, item.id)) count++;
    return count;
  }
}
