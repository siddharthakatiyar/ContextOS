import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getContextOSHome } from '../storage/database.js';
import type { RepositorySource } from '../workspace/registry.js';
import { parseRef } from '../workspace/identity.js';
import { hashContent } from '../../utils/hash.js';
import { resolveWithinWorkspace } from '../../utils/fs-guard.js';
import { preparePrivateStateFile, tightenPrivateStateFile } from '../../utils/secure-state.js';

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
export interface VerifiedLink {
  id: string;
  source: string;
  target: string;
  type: LinkType;
  rationale: string;
  evidence: Evidence[];
  createdAt: number;
  updatedAt: number;
}
export interface VerifiedFact {
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
export interface LinkInput {
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
export interface FactInput {
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

/** Only established knowledge is stored. Freshness checks remove unsupported records on reads. */
export class GraphStore {
  private db: Database.Database;
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
      let commit: string | null = null;
      try {
        commit = execFileSync('git', ['-C', source.rootPath, 'rev-parse', '--verify', 'HEAD'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 5000,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
        }).trim();
      } catch {
        /* unborn branch */
      }
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
    const fileHash = hashContent(fs.readFileSync(file, 'utf8'));
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
    return (
      this.db.prepare(`SELECT id,payload FROM ${table} ORDER BY id`).all() as StoredRow[]
    ).map((row) => JSON.parse(row.payload) as T);
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
    if (!LINK_TYPES.includes(input.type)) throw new Error('Unsupported relationship type.');
    if (!input.rationale.trim()) throw new Error('A verified connection requires a rationale.');
    const refs = [...new Set([input.source, input.target, ...(input.evidenceRefs ?? [])])];
    const evidence = refs.map((ref) => {
      const viewId = this.assertScope(ref, permittedViewIds);
      const generation = input.expectedGenerations[viewId];
      if (!Number.isInteger(generation))
        throw new Error('expected_generations must include every evidence view.');
      return this.captureEvidence(ref, generation);
    });
    const identity = JSON.stringify([input.source, input.target, input.type]);
    const old = this.db
      .prepare('SELECT payload FROM verified_links WHERE identity=?')
      .get(identity) as { payload: string } | undefined;
    const previous = old ? (JSON.parse(old.payload) as VerifiedLink) : undefined;
    const now = Date.now();
    const result: VerifiedLink = {
      id: previous?.id ?? crypto.randomUUID(),
      source: input.source,
      target: input.target,
      type: input.type,
      rationale: input.rationale.trim(),
      evidence,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO verified_links VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload'
        )
        .run(result.id, identity, JSON.stringify(result));
      this.touch();
    })();
    return result;
  }
  listLinks(options: { viewIds?: string[]; refs?: string[] } = {}): VerifiedLink[] {
    return this.records<VerifiedLink>('verified_links')
      .filter(
        (link) =>
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
    limit = 12
  ): { links: VerifiedLink[]; refs: string[] } {
    const links = this.listLinks({ viewIds: permittedViewIds, refs }).slice(
      0,
      Math.max(0, Math.min(limit, 100))
    );
    return {
      links,
      refs: [...new Set(links.flatMap((link) => [link.source, link.target]))].filter(
        (ref) => !refs.includes(ref)
      )
    };
  }
  unlink(id: string, permittedViewIds: string[]): boolean {
    const link = this.records<VerifiedLink>('verified_links').find((item) => item.id === id);
    if (!link) return false;
    link.evidence.forEach((item) => this.assertScope(item.ref, permittedViewIds));
    return this.remove('verified_links', id);
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
    const old = this.db
      .prepare('SELECT payload FROM verified_facts WHERE identity=?')
      .get(identity) as { payload: string } | undefined;
    const previous = old ? (JSON.parse(old.payload) as VerifiedFact) : undefined;
    const now = Date.now();
    const result: VerifiedFact = {
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
          'INSERT INTO verified_facts VALUES (?,?,?) ON CONFLICT(identity) DO UPDATE SET payload=excluded.payload'
        )
        .run(result.id, identity, JSON.stringify(result));
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
      .sort((a, b) => b.score - a.score || a.fact.id.localeCompare(b.fact.id))
      .slice(0, options.limit ?? 5)
      .map((item) => item.fact);
  }
  forget(id: string, permittedViewIds: string[], access: FactAccess = {}): boolean {
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
    return this.remove('verified_facts', id);
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
