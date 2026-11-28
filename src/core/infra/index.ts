import Database from 'better-sqlite3';
import { loadConfig } from '../../config/index.js';
import { GraphStore } from '../knowledge/graph-store.js';
import { listKnowledge } from '../knowledge/review.js';
import { getContextOSHome } from '../storage/database.js';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { entityRef } from '../workspace/identity.js';
import { verifyKnowledge, type VerifyScope } from '../verify/index.js';
import { INFRA_AUTHOR, IMPORT_KINDS, planInfra, type InfraChunk, type InfraPlan } from './plan.js';

export { planInfra, INFRA_AUTHOR } from './plan.js';
export interface InfraOptions {
  scope?: VerifyScope;
  dryRun?: boolean;
}
function session(scope: VerifyScope = { cwd: process.cwd() }) {
  const config = typeof scope === 'string' ? {} : scope;
  const home = config.home ?? getContextOSHome();
  const registry = new WorkspaceRegistry(home);
  registry.deferReconciliation = true;
  const indexes = new Map<string, Database.Database>();
  const close = () => {
    for (const db of indexes.values()) db.close();
    registry.close();
  };
  try {
    const all = registry.listAll();
    const ids =
      typeof scope === 'string'
        ? scope === 'all'
          ? all.map((s) => s.repoId)
          : scope.startsWith('group:')
            ? registry.list(scope.slice(6), true).map((s) => s.repoId)
            : scope.startsWith('project:')
              ? registry.views(scope.slice(8)).map((s) => s.repoId)
              : [registry.resolve(scope.startsWith('view:') ? scope.slice(5) : scope).repoId]
        : (config.viewIds ??
          (config.group
            ? registry.list(config.group, true).map((s) => s.repoId)
            : config.cwd
              ? [registry.resolve(config.cwd).repoId]
              : all.map((s) => s.repoId)));
    const sources = [...new Set(ids)].map((id) => registry.resolve(id));
    const resolve = (id: string) => {
      const source = registry.resolve(id);
      let db = indexes.get(id);
      if (!db) {
        db = new Database(source.dbPath, { readonly: true, fileMustExist: true });
        db.pragma('busy_timeout = 0');
        indexes.set(id, db);
      }
      return { source, db };
    };
    return { home, registry, sources, resolve, close };
  } catch (error) {
    close();
    throw error;
  }
}
export interface InfraImportReport {
  dryRun: boolean;
  views: { viewId: string; generation: number; facts: number; links: number }[];
  skipped: { ref: string; reason: string }[];
  plans: { viewId: string; plan: InfraPlan }[];
}

/** Only reads indexed chunks; graph writes validate current generations and source hashes. */
export async function importInfra(options: InfraOptions = {}): Promise<InfraImportReport> {
  const state = session(options.scope);
  let graph: GraphStore | undefined;
  const report: InfraImportReport = { dryRun: !!options.dryRun, views: [], skipped: [], plans: [] };
  try {
    if (!options.dryRun) {
      await verifyKnowledge({
        scope: { home: state.home, viewIds: state.sources.map((s) => s.repoId) }
      });
      graph = new GraphStore({ home: state.home, resolve: state.resolve });
    }
    for (const selected of state.sources) {
      const source = state.registry.resolve(selected.repoId);
      if (
        !source.active ||
        source.state !== 'ready' ||
        loadConfig({ cwd: source.rootPath, forceReload: true }).indexing?.infra === false
      ) {
        report.skipped.push({
          ref: source.repoId,
          reason: 'view not ready or infrastructure indexing disabled'
        });
        continue;
      }
      const { db } = state.resolve(source.repoId);
      const rows = db
        .prepare(
          `SELECT id, source_file, language, symbol_name, section_title, content FROM chunks WHERE language IN (${IMPORT_KINDS.map(() => '?').join(',')}) ORDER BY source_file, start_line, id`
        )
        .all(...IMPORT_KINDS) as {
        id: string;
        source_file: string;
        language: string;
        symbol_name: string | null;
        section_title: string;
        content: string;
      }[];
      const chunks: InfraChunk[] = rows.map((row) => ({
        ref: entityRef(source.repoId, 'chunk', row.id),
        file: row.source_file,
        kind: row.language,
        name: row.symbol_name ?? row.section_title,
        content: row.content
      }));
      const plan = planInfra(chunks);
      const expectedGenerations = { [source.repoId]: source.generation };
      // Preflight every reference before mutating; the graph API also fences each write.
      if (graph)
        for (const ref of new Set([
          ...plan.facts.flatMap((f) => f.refs),
          ...plan.links.flatMap((l) => l.refs)
        ]))
          graph.captureEvidence(ref, source.generation);
      for (const fact of plan.facts)
        graph?.remember(
          {
            identityKey: fact.key,
            content: fact.content,
            category: fact.category,
            scope: 'view',
            scopeId: source.repoId,
            viewIds: [source.repoId],
            provenance: 'code',
            author: INFRA_AUTHOR,
            status: 'verified',
            verifiedAt: Date.now(),
            staleReason: null,
            evidenceRefs: fact.refs,
            expectedGenerations
          },
          [source.repoId]
        );
      for (const link of plan.links)
        graph?.link(
          {
            identityKey: link.key,
            source: link.source,
            target: link.target,
            type: link.type,
            provenance: { kind: 'code' },
            rationale: link.rationale,
            author: INFRA_AUTHOR,
            status: 'verified',
            verifiedAt: Date.now(),
            staleReason: null,
            evidenceRefs: link.refs,
            expectedGenerations
          },
          [source.repoId]
        );
      report.views.push({
        viewId: source.repoId,
        generation: source.generation,
        facts: plan.facts.length,
        links: plan.links.length
      });
      report.skipped.push(...plan.skipped);
      report.plans.push({ viewId: source.repoId, plan });
    }
    return report;
  } finally {
    graph?.close();
    state.close();
  }
}

export function listInfra(scope?: VerifyScope) {
  const state = session(scope);
  try {
    return listKnowledge({
      home: state.home,
      scope: { sources: state.sources, repoIds: state.sources.map((s) => s.repoId) }
    }).filter((record) => record.author === INFRA_AUTHOR);
  } finally {
    state.close();
  }
}
