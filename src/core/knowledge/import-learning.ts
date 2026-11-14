import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import type { GraphSource, GraphStore, VerifiedLink } from './graph-store.js';
import { KnowledgeInspector } from './inspector.js';
import type { RepositorySource } from '../workspace/registry.js';
import type { ScoredChunk } from '../retrieval/types.js';
import { entityRef, parseRef } from '../workspace/identity.js';

export interface LinkSuggestion {
  source: string;
  relationship: 'imports';
  specifier: string;
  verification: 'needs_agent_verification';
  reason: 'unresolved_local_dependency';
  inspect: {
    tool: 'ctx_resolve_import';
    arguments: { source: string; specifier: string; mode: 'import' | 'types' };
  };
}
export interface ImportLearningResult {
  learnedLinks: VerifiedLink[];
  linkSuggestions: LinkSuggestion[];
  sourceRefs: string[];
}

/** Bounded, deterministic learning from retrieved files. No model calls or workspace crawl.
 * The index supplies file anchors; syntax + explicit local mappings supply the proof.
 * Only whole-file module dependencies are saved, never guessed symbol consumption.
 */
export async function learnRetrievedImports(
  graph: GraphStore,
  views: RepositorySource[],
  resolve: (id: string) => GraphSource,
  chunks: ScoredChunk[],
  signal?: AbortSignal
): Promise<ImportLearningResult> {
  const result: ImportLearningResult = { learnedLinks: [], linkSuggestions: [], sourceRefs: [] };
  if (views.length < 2) return result;
  const inspector = new KnowledgeInspector(graph, views, resolve);
  const visited = new Set<string>();
  let attempts = 0;
  for (const chunk of chunks
    .slice()
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))) {
    signal?.throwIfAborted();
    const parsed = parseRef(chunk.id);
    const view = views.find((item) => item.repoId === parsed?.repoId);
    if (!view || parsed?.kind !== 'chunk' || !/\.[jt]sx?$/i.test(chunk.sourceFile)) continue;
    const key = view.repoId + ':' + chunk.sourceFile;
    if (visited.has(key)) continue;
    if (visited.size >= 3 || attempts >= 6) break;
    visited.add(key);
    const { db } = resolve(view.repoId);
    const anchor = db
      .prepare(
        "SELECT id FROM chunks WHERE source_file=? AND section_title='File Structure' ORDER BY id LIMIT 1"
      )
      .get(chunk.sourceFile) as { id: string } | undefined;
    // A function chunk is not a safe endpoint for a whole-file import claim.
    if (!anchor) continue;
    const source = entityRef(view.repoId, 'chunk', anchor.id);
    result.sourceRefs.push(source);
    let imports: Awaited<ReturnType<KnowledgeInspector['literalImports']>>;
    try {
      imports = await inspector.literalImports(source);
    } catch {
      continue;
    }
    const seen = new Set<string>();
    for (const imported of imports) {
      signal?.throwIfAborted();
      if (attempts >= 6) break;
      const { specifier, mode } = imported;
      if (isBuiltin(specifier) || seen.has(mode + ':' + specifier)) continue;
      seen.add(mode + ':' + specifier);
      // A nested registered project or symlink can own an apparently local path.
      // Resolve ownership before deciding whether a dependency is intra-view.
      attempts++;
      try {
        const inspected = await inspector.resolveImport({ source, specifier, mode });
        const target = parseRef(inspected.target);
        if (!target || target.repoId === view.repoId) continue;
        const saved = graph.linkResolvedImport(
          {
            source,
            target: inspected.target,
            type: 'imports',
            rationale: `Literal ${mode === 'types' ? 'type ' : ''}import ${JSON.stringify(specifier)} resolves through an exact local module mapping. This proves a file dependency, not symbol consumption.`,
            evidenceRefs: inspected.evidence.map((item) => item.ref),
            expectedGenerations: Object.fromEntries(
              inspected.evidence.map((item) => [item.viewId, item.generation])
            )
          },
          views.map((item) => item.repoId)
        );
        if (saved.created) result.learnedLinks.push(saved.link);
      } catch {
        // Surface only local-looking references. Never manufacture a target from name similarity.
        const local =
          specifier.startsWith('.') || hasLocalMapping(view.rootPath, chunk.sourceFile, specifier);
        if (local)
          result.linkSuggestions.push({
            source,
            relationship: 'imports',
            specifier,
            verification: 'needs_agent_verification',
            reason: 'unresolved_local_dependency',
            inspect: { tool: 'ctx_resolve_import', arguments: { source, specifier, mode } }
          });
      }
    }
  }
  return result;
}

function hasLocalMapping(root: string, sourceFile: string, specifier: string): boolean {
  const name = specifier.startsWith('@')
    ? specifier.split('/').slice(0, 2).join('/')
    : specifier.split('/')[0];
  let directory = path.dirname(sourceFile);
  while (directory === root || directory.startsWith(root + path.sep)) {
    const file = path.join(directory, 'package.json');
    if (fs.existsSync(file)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        return ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].some(
          (key) => /^(?:file:|link:|workspace:)/.test(manifest[key]?.[name] ?? '')
        );
      } catch {
        return false;
      }
    }
    if (directory === root) break;
    directory = path.dirname(directory);
  }
  return false;
}
