import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { Evidence, VerifiedFact } from '../knowledge/graph-store.js';
import { parseRef } from '../workspace/identity.js';
import type { ImpactOptions, ImpactResult } from './index.js';

export interface DeploymentItem {
  id: string;
  content: string;
  category: string;
  status: string;
  match: 'evidence-owner' | 'repository-mention' | 'saved-link';
  evidenceRefs: string[];
  evidence?: Evidence[];
}

/** Snapshot reads deliberately do not prune facts when the impacted source is edited. */
export function deploymentImpact(home: string, options: ImpactOptions, result: ImpactResult) {
  const items: DeploymentItem[] = [];
  for (const item of result.impacted) {
    const view = options.scope.views.find((v) => v.source.repoId === item.viewId);
    const ref = parseRef(item.ref);
    const chunk =
      ref &&
      (view?.db.prepare('SELECT language FROM chunks WHERE id=?').get(ref.localId) as
        { language: string } | undefined);
    if (
      item.linkId &&
      chunk &&
      ['compose-service', 'k8s-resource', 'dockerfile', 'helm-values', 'terraform-block'].includes(
        chunk.language
      )
    )
      items.push({
        id: item.linkId,
        content: `${item.repo}/${item.file}${item.symbol ? ':' + item.symbol : ''}`,
        category: 'infra',
        status: item.status,
        match: 'saved-link',
        evidenceRefs: item.evidenceRefs,
        ...(options.verbose ? { evidence: item.evidence } : {})
      });
  }
  const file = path.join(home, 'graph.db');
  if (fs.existsSync(file)) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare('SELECT payload,status,expires_at FROM verified_facts ORDER BY id')
        .all() as {
        payload: string;
        status: string;
        expires_at: number | null;
      }[];
      const affected = new Set([...result.changes, ...result.impacted].map((item) => item.viewId));
      for (const row of rows) {
        const fact = JSON.parse(row.payload) as VerifiedFact;
        if (
          !['infra', 'service'].includes(fact.category ?? '') ||
          (row.status === 'proposed' && !options.includeProposed) ||
          (row.status === 'stale' && !options.includeStale) ||
          (row.expires_at !== null && row.expires_at <= Date.now())
        )
          continue;
        const selectedViews = options.scope.views;
        const inScope =
          fact.provenance === 'user' && fact.scope === 'group'
            ? fact.scopeId === options.scope.group
            : fact.provenance === 'user' && fact.scope === 'project'
              ? selectedViews.some((v) => v.source.projectId === fact.scopeId)
              : fact.viewIds.length > 0 &&
                fact.viewIds.every((id) => selectedViews.some((v) => v.source.repoId === id));
        if (!inScope) continue;
        // Code facts need exact evidence in the selected indexed snapshot.
        const valid = fact.evidence.every((e) => {
          const view = options.scope.views.find((v) => v.source.repoId === e.viewId);
          const ref = parseRef(e.ref);
          if (!view || ref?.repoId !== e.viewId) return false;
          const chunk = view.db
            .prepare('SELECT source_file,hash FROM chunks WHERE id=?')
            .get(ref.localId) as { source_file: string; hash: string } | undefined;
          const file = view.db.prepare('SELECT hash FROM files WHERE path=?').get(e.file) as
            { hash: string } | undefined;
          return (
            chunk?.source_file === e.file && chunk.hash === e.chunkHash && file?.hash === e.fileHash
          );
        });
        if (!valid || (fact.provenance !== 'user' && !fact.evidence.length)) continue;
        const owners = options.scope.views.filter((v) => affected.has(v.source.repoId));
        const evidenceOwner = owners.some((v) =>
          fact.evidence.some(
            (e) =>
              e.viewId === v.source.repoId &&
              path.isAbsolute(e.file) &&
              !path.relative(v.source.rootPath, e.file).startsWith('..')
          )
        );
        const mention = owners.some((v) =>
          [v.source.name, v.source.repoId, v.source.rootPath].some((name) => {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`(^|[^\\w-])${escaped}($|[^\\w-])`).test(fact.content);
          })
        );
        if (!evidenceOwner && !mention) continue;
        items.push({
          id: fact.id,
          content: fact.content,
          category: fact.category!,
          status: row.status,
          match: evidenceOwner ? 'evidence-owner' : 'repository-mention',
          evidenceRefs: fact.evidence.map((e) => e.ref),
          ...(options.verbose ? { evidence: fact.evidence } : {})
        });
      }
    } finally {
      db.close();
    }
  }
  return {
    items,
    coverage: {
      complete: false as const,
      note: items.length
        ? 'Recorded infra/service facts associated with affected repositories; association does not prove a deployment will break.'
        : 'No matching recorded infra/service facts; deployed component coverage is unknown.'
    }
  };
}
