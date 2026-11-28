import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { type GraphSource, type VerifiedLink, type Evidence } from '../knowledge/graph-store.js';
import { traceVerifiedGraph, type TraceNode } from '../knowledge/trace.js';
import { entityRef, parseRef } from '../workspace/identity.js';
import { parseCode } from '../parser/code-parser.js';
import { hashContent } from '../../utils/hash.js';
import { contractVersions, diffContracts, type ContractChange } from './contracts.js';
import { gitText, parseUnifiedDiff, type ChangedFile, type LineRange } from './diff.js';

export { parseUnifiedDiff } from './diff.js';
export { diffContracts } from './contracts.js';
export type { ChangedFile, LineRange } from './diff.js';
export type { ContractChange } from './contracts.js';

/** Explicit indexed views: callers resolve their group/selectors and readiness before analysis.
 * links is an optional read-only snapshot (use readImpactLinks for a home-level graph.db).
 */
export interface ImpactScope {
  views: GraphSource[];
  links?: VerifiedLink[];
  group?: string;
}
export interface ImpactOptions {
  diff?: string;
  files?: { path: string; ranges?: LineRange[]; viewId?: string }[];
  base?: string;
  head?: string;
  scope: ImpactScope;
  /** Restrict relative input paths/git diff to one view. Defaults to the sole view only. */
  viewId?: string;
  depth?: number;
  includeProposed?: boolean;
  includeStale?: boolean;
  verbose?: boolean;
  maxResults?: number;
}
export interface ImpactItem {
  ref: string;
  repo: string;
  viewId: string;
  projectId: string;
  file: string;
  symbol?: string;
  relation: string;
  direction: 'incoming';
  confidence: 'deterministic' | 'saved-link' | 'file-level';
  depth: number;
  evidenceRefs: string[];
  status: 'proposed' | 'verified' | 'stale';
  linkId?: string;
  via: string;
  evidence?: Evidence[];
}
export interface ImpactChange {
  viewId: string;
  file: string;
  oldFile?: string;
  status: ChangedFile['status'];
  ranges: LineRange[];
  oldRanges: LineRange[];
  refs: string[];
  symbols: string[];
  changedExports: string[];
  contracts?: ContractChange[];
}
export interface ImpactResult {
  changes: ImpactChange[];
  impacted: ImpactItem[];
  coverage: {
    basis: 'indexed-imports-and-recorded-links';
    repos: {
      repo: string;
      viewId: string;
      projectId: string;
      imports: number;
      links: number;
      eligibleLinks: number;
      hasData: boolean;
      generation: number;
    }[];
    unknownRepos: string[];
    complete: false;
  };
  warnings: string[];
  truncated: boolean;
  truncation: { resultLimit: boolean; depthLimit: boolean };
  summary: string;
}
interface Chunk {
  id: string;
  source_file: string;
  symbol_name: string | null;
  symbol_kind: string | null;
  language: string | null;
  start_line: number | null;
  end_line: number | null;
  content: string;
  hash: string;
}
interface ImportRow {
  id: number;
  target: string;
  source_chunk_id: string;
}

/** Unlike GraphStore.listLinks this does not prune evidence for an edited/deleted file.
 * Freshness is checked against the selected index snapshot by analyzeImpact.
 */
export function readImpactLinks(home: string, viewIds: string[]): VerifiedLink[] {
  const file = path.join(home, 'graph.db');
  if (!fs.existsSync(file)) return [];
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare('SELECT payload,status,expires_at,stale_reason FROM verified_links ORDER BY id')
      .all() as {
      payload: string;
      status: VerifiedLink['status'];
      expires_at: number | null;
      stale_reason: string | null;
    }[];
    return rows
      .map((row) => ({
        ...(JSON.parse(row.payload) as VerifiedLink),
        status: row.status,
        expiresAt: row.expires_at,
        staleReason: row.stale_reason
      }))
      .filter((link) =>
        [link.source, link.target, ...link.evidence.map((item) => item.ref)].every((ref) =>
          viewIds.includes(parseRef(ref)?.repoId ?? '')
        )
      );
  } finally {
    db.close();
  }
}
function limit(value: number | undefined, fallback: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1 || result > max)
    throw new Error(`Impact limit must be an integer between 1 and ${max}.`);
  return result;
}
const intersects = (chunk: Chunk, ranges: LineRange[]) =>
  !ranges.length ||
  ranges.some(
    (range) =>
      chunk.start_line !== null &&
      chunk.end_line !== null &&
      chunk.start_line <= range.end &&
      chunk.end_line >= range.start
  );
const relative = (root: string, file: string) =>
  path.relative(root, file).split(path.sep).join('/');

/** Analyze an index snapshot; no indexing, graph writes, network access or deployed entities. */
export async function analyzeImpact(options: ImpactOptions): Promise<ImpactResult> {
  const depth = limit(options.depth, 2, 12),
    cap = limit(options.maxResults, 100, 500);
  const views = options.scope.views;
  if (!views.length || new Set(views.map((view) => view.source.repoId)).size !== views.length)
    throw new Error('Impact scope requires unique indexed views.');
  for (const { source, db } of views) {
    if (!source.active || source.state !== 'ready')
      throw new Error(`Impact view is not ready: ${source.name}`);
    const metadata = Object.fromEntries(
      (
        db.prepare('SELECT key,value FROM repository_metadata').all() as {
          key: string;
          value: string;
        }[]
      ).map((row) => [row.key, row.value])
    );
    if (
      metadata.needs_reindex ||
      metadata.repo_id !== source.repoId ||
      metadata.view_id !== source.viewId ||
      metadata.root_path !== source.rootPath ||
      metadata.checkout_generation !== String(source.checkoutGeneration) ||
      metadata.head !== (source.head ?? '')
    )
      throw new Error(`Impact index identity changed: ${source.name}; refresh and reindex.`);
  }
  const selected = options.viewId
    ? views.find((view) => view.source.repoId === options.viewId)
    : views.length === 1
      ? views[0]
      : undefined;
  if (options.viewId && !selected) throw new Error('Impact input view is outside scope.');
  if (options.diff !== undefined && (options.base || options.head))
    throw new Error('Provide diff or base/head, not both.');
  if ((options.base && !options.head) || (!options.base && options.head))
    throw new Error('Both base and head are required.');
  if (options.files && (options.diff !== undefined || options.base))
    throw new Error('Provide files or a diff, not both.');
  if (!options.files && options.diff === undefined && !options.base)
    throw new Error('Provide files, diff, or base/head.');
  if ((options.diff !== undefined || options.base) && !selected)
    throw new Error('Select viewId for a diff in a multi-view scope.');
  const warnings = new Set<string>();
  const chunks = new Map<string, { chunk: Chunk; view: GraphSource }>();
  const byFile = new Map<string, string[]>();
  const imports = new Map<string, ImportRow[]>();
  for (const view of views) {
    for (const chunk of view.db
      .prepare(
        'SELECT id,source_file,symbol_name,symbol_kind,language,start_line,end_line,content,hash FROM chunks ORDER BY source_file,start_line,id'
      )
      .all() as Chunk[]) {
      const ref = entityRef(view.source.repoId, 'chunk', chunk.id);
      chunks.set(ref, { chunk, view });
      const key = view.source.repoId + ':' + chunk.source_file;
      byFile.set(key, [...(byFile.get(key) ?? []), ref]);
    }
    imports.set(
      view.source.repoId,
      view.db
        .prepare(
          "SELECT id,target,source_chunk_id FROM relationships WHERE relationship_type='imports' ORDER BY id"
        )
        .all() as ImportRow[]
    );
  }
  const node = (ref: string): TraceNode => {
    const found = chunks.get(ref);
    if (!found) throw new Error('Chunk unavailable in selected index.');
    const {
      chunk,
      view: { source, db }
    } = found;
    const file = db.prepare('SELECT hash FROM files WHERE path=?').get(chunk.source_file) as
      { hash: string } | undefined;
    if (!file) throw new Error('Indexed file unavailable.');
    return {
      ref,
      viewId: source.repoId,
      projectId: source.projectId,
      project: source.name,
      branch: source.branch,
      head: source.head,
      relativePath: relative(source.rootPath, chunk.source_file),
      symbol: chunk.symbol_name ?? undefined,
      evidence: {
        ref,
        viewId: source.repoId,
        projectId: source.projectId,
        file: chunk.source_file,
        fileHash: file.hash,
        chunkHash: chunk.hash,
        generation: source.generation
      }
    };
  };
  let excluded = 0;
  const scopedLinks = (options.scope.links ?? []).filter((link) =>
    [link.source, link.target, ...link.evidence.map((item) => item.ref)].every((ref) =>
      views.some((view) => view.source.repoId === parseRef(ref)?.repoId)
    )
  );
  const recorded = scopedLinks.filter((link) => {
    if (link.type === 'writes_resource') return false;
    if (!chunks.has(link.source) || !chunks.has(link.target)) {
      warnings.add('Some saved-link endpoints are unavailable in the selected index.');
      return false;
    }
    if (
      (link.status === 'proposed' && !options.includeProposed) ||
      (link.status === 'stale' && !options.includeStale) ||
      (link.expiresAt != null && link.expiresAt <= Date.now())
    ) {
      excluded++;
      return false;
    }
    const valid =
      [link.source, link.target].every((ref) => link.evidence.some((item) => item.ref === ref)) &&
      link.evidence.every((item) => {
        try {
          const current = node(item.ref).evidence;
          return (
            current.viewId === item.viewId &&
            current.fileHash === item.fileHash &&
            current.chunkHash === item.chunkHash &&
            current.file === item.file
          );
        } catch {
          return false;
        }
      });
    if (!valid)
      warnings.add(
        'Some saved links have stale or unavailable indexed evidence and were excluded.'
      );
    return valid;
  });
  if (excluded) warnings.add(`${excluded} proposed, stale or expired saved link(s) excluded.`);
  if (options.scope.links === undefined)
    warnings.add('No saved-link snapshot supplied; cross-repository coverage is unknown.');
  const repos = views.map(({ source }) => {
    const count = scopedLinks.filter((link) =>
      [link.source, link.target].some((ref) => parseRef(ref)?.repoId === source.repoId)
    ).length;
    const countImports = imports.get(source.repoId)!.length;
    return {
      repo: source.name,
      viewId: source.repoId,
      projectId: source.projectId,
      imports: countImports,
      links: count,
      eligibleLinks: recorded.filter((link) =>
        [link.source, link.target].some((ref) => parseRef(ref)?.repoId === source.repoId)
      ).length,
      hasData: count + countImports > 0,
      generation: source.generation
    };
  });
  const unknownRepos = repos.filter((repo) => !repo.hasData).map((repo) => repo.viewId);
  const changes: ImpactChange[] = [];
  const seeds = new Set<string>();
  const raw: { change: ChangedFile; view: GraphSource }[] = [];
  let contractBase = options.base;
  if (options.base && options.head) {
    if ([options.base, options.head].some((ref) => ref.startsWith('-') || /[\r\n\0]/.test(ref)))
      throw new Error('Invalid Git revision.');
    contractBase = gitText(selected!.source.rootPath, [
      'merge-base',
      options.base,
      options.head
    ]).trim();
  }
  if (options.files) {
    if (options.files.length > 1000) throw new Error('Impact exceeds 1000 input files.');
    for (const file of options.files) {
      const owner = file.viewId
        ? views.find((view) => view.source.repoId === file.viewId)
        : path.isAbsolute(file.path)
          ? views.find((view) => !relative(view.source.rootPath, file.path).startsWith('../'))
          : selected;
      if (!owner) throw new Error('Select an in-scope viewId for each relative file.');
      for (const range of file.ranges ?? [])
        if (
          !Number.isInteger(range.start) ||
          !Number.isInteger(range.end) ||
          range.start < 1 ||
          range.end < range.start
        )
          throw new Error('Invalid changed line range.');
      raw.push({
        view: owner,
        change: { path: file.path, status: 'modified', ranges: file.ranges ?? [], oldRanges: [] }
      });
    }
  } else {
    const diff =
      options.diff ??
      gitText(selected!.source.rootPath, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames',
        `${options.base}...${options.head}`,
        '--'
      ]);
    for (const change of parseUnifiedDiff(diff)) raw.push({ change, view: selected! });
  }
  for (const { change, view } of raw) {
    const root = view.source.rootPath;
    const file = path.resolve(root, change.path),
      oldFile = change.oldPath ? path.resolve(root, change.oldPath) : file;
    if (
      [file, oldFile].some(
        (name) => relative(root, name).startsWith('../') || relative(root, name) === '..'
      )
    )
      throw new Error('Changed path escapes selected view.');
    const refs = [
      ...new Set([
        ...(byFile.get(view.source.repoId + ':' + file) ?? []),
        ...(byFile.get(view.source.repoId + ':' + oldFile) ?? [])
      ])
    ];
    const hit = refs.filter((ref) => {
      const chunk = chunks.get(ref)!.chunk;
      return intersects(chunk, [...change.ranges, ...change.oldRanges]);
    });
    if (!refs.length)
      warnings.add(
        `No indexed chunks for ${view.source.name}:${change.path}; impact is unknown for this file.`
      );
    const item: ImpactChange = {
      viewId: view.source.repoId,
      file: relative(root, file),
      oldFile: change.oldPath ? relative(root, oldFile) : undefined,
      status: change.status,
      ranges: change.ranges,
      oldRanges: change.oldRanges,
      refs: hit,
      symbols: [...new Set(hit.flatMap((ref) => chunks.get(ref)!.chunk.symbol_name ?? []))],
      changedExports: [
        ...new Set(
          hit
            .filter((ref) =>
              /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\b/.test(
                chunks.get(ref)!.chunk.content
              )
            )
            .flatMap((ref) => chunks.get(ref)!.chunk.symbol_name ?? [])
        )
      ]
    };
    if (
      /\.proto$/i.test(file) ||
      refs.some((ref) => ['openapi', 'protobuf'].includes(chunks.get(ref)!.chunk.language ?? '')) ||
      /(?:openapi|swagger)[^/]*\.(?:ya?ml|json)$/i.test(file)
    ) {
      const versions = contractVersions(root, change, contractBase, options.head);
      if (!versions)
        warnings.add(
          `Contract baseline unavailable for ${change.path}; contract operation impact is unknown.`
        );
      else
        try {
          item.contracts = diffContracts(file, ...versions) ?? undefined;
          if (!item.contracts)
            warnings.add(
              `Contract inspection failed for ${change.path}; contract impact is unknown.`
            );
        } catch {
          warnings.add(
            `Contract inspection failed for ${change.path}; contract impact is unknown.`
          );
        }
    }
    changes.push(item);
    // Message/schema changes can affect RPCs outside the changed line ranges.
    const contractWide = item.contracts?.some((entry) => entry.kind !== 'operation');
    (contractWide ? refs : hit).forEach((ref) => {
      const symbol = chunks.get(ref)!.chunk.symbol_name;
      // HTTP chunks cite the entire contract, so line overlap alone cannot identify operations.
      if (
        item.contracts &&
        symbol &&
        !item.contracts.some(
          (entry) =>
            entry.kind !== 'operation' ||
            symbol.startsWith(entry.name + ' (') ||
            symbol === entry.name.split(' ').slice(1).join(' ')
        )
      )
        return;
      seeds.add(ref);
    });
  }
  // Relationships establish candidate source files. Resolve only exact indexed relative modules;
  // secondary entity-name edges are not module dependencies and are never guessed.
  const local = new Map<string, { source: string; proof: boolean; evidence: string[] }[]>();
  const syntax = new Map<string, Awaited<ReturnType<typeof parseCode>>>();
  for (const view of views)
    for (const row of imports.get(view.source.repoId)!) {
      if (!row.target.startsWith('.')) continue;
      const sourceRef = entityRef(view.source.repoId, 'chunk', row.source_chunk_id);
      const origin = chunks.get(sourceRef)?.chunk;
      if (!origin) continue;
      const stem = path.resolve(path.dirname(origin.source_file), row.target);
      const candidates = [
        stem,
        ...['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'].map((ext) => stem + ext),
        ...['.ts', '.tsx', '.js'].map((ext) => path.join(stem, 'index' + ext)),
        ...(/\.[cm]?js$/.test(stem)
          ? [stem.replace(/\.[cm]?js$/, '.ts'), stem.replace(/\.js$/, '.tsx')]
          : [])
      ];
      const matches = [...new Set(candidates)].filter((candidate) =>
        byFile.has(view.source.repoId + ':' + candidate)
      );
      if (matches.length !== 1) {
        warnings.add(
          `Unresolved indexed import ${row.target} in ${view.source.name}; local coverage is partial.`
        );
        continue;
      }
      let document: Awaited<ReturnType<typeof parseCode>> | undefined;
      try {
        document = syntax.get(origin.source_file);
        if (!document) {
          const content = fs.readFileSync(origin.source_file, 'utf8');
          if (hashContent(content) !== node(sourceRef).evidence.fileHash)
            throw new Error('Changed importer');
          document = await parseCode(origin.source_file, content);
          syntax.set(origin.source_file, document);
        }
      } catch {
        warnings.add(
          'Some importer syntax is unavailable or changed; dependencies use file-level evidence.'
        );
      }
      const targetRefs = byFile.get(view.source.repoId + ':' + matches[0])!;
      const statements = document?.symbols.filter(
        (symbol) => symbol.kind === 'import' && symbol.name === row.target
      );
      const named = statements?.map((symbol) =>
        /^\s*import\s+(?:type\s+)?\{([^}]+)\}\s+from\s+(['"])([^'"]+)\2/.exec(symbol.body)
      );
      const bindings = named?.flatMap((statement) =>
        statement
          ? statement[1].split(',').map(
              (part) =>
                part
                  .trim()
                  .replace(/^type\s+/, '')
                  .split(/\s+as\s+/)[0]
            )
          : []
      );
      // Narrow only when every import of this module has understood named bindings
      // and each binding has an indexed declaration. Default/namespace imports and
      // missing declarations must retain conservative file-level propagation.
      const canNarrow = Boolean(
        named?.length &&
        named.every(Boolean) &&
        bindings?.length &&
        bindings.every((binding) =>
          targetRefs.some((ref) => chunks.get(ref)!.chunk.symbol_name === binding)
        )
      );
      for (const targetRef of targetRefs) {
        const target = chunks.get(targetRef)!.chunk;
        const binding =
          canNarrow && target.symbol_name !== null && bindings?.includes(target.symbol_name);
        // Exact named bindings narrow symbol impact; missing syntax stays file-level.
        if (canNarrow && !binding) continue;
        const edges = local.get(targetRef) ?? [];
        if (!edges.some((edge) => edge.source === sourceRef))
          edges.push({
            source: sourceRef,
            proof: Boolean(binding),
            evidence: [sourceRef, targetRef]
          });
        local.set(targetRef, edges);
      }
    }
  const impacted: ImpactItem[] = [],
    emitted = new Set(seeds),
    visited = new Set(seeds);
  const queue = [...seeds]
    .sort(
      (a, b) =>
        Number(Boolean(chunks.get(b)!.chunk.symbol_name)) -
        Number(Boolean(chunks.get(a)!.chunk.symbol_name))
    )
    .map((ref) => ({
      ref,
      depth: 0,
      status: 'verified' as ImpactItem['status'],
      fileLevel: false
    }));
  let resultLimit = false,
    depthLimit = false;
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor];
    const graph = traceVerifiedGraph(
      { start: current.ref, direction: 'incoming', maxDepth: 1, maxNodes: 500, maxEdges: 1000 },
      {
        inspect: node,
        adjacent: (ref, _direction, bound) => {
          const links = recorded.filter((link) => link.target === ref);
          return { links: links.slice(0, bound), truncated: links.length > bound };
        },
        status: () => 'valid'
      }
    );
    if (
      graph.truncated &&
      graph.stops.some((stop) => ['node_limit', 'edge_limit'].includes(stop.reason))
    )
      resultLimit = true;
    const neighbors = [
      ...(local.get(current.ref) ?? []).map((edge) => ({
        ref: edge.source,
        relation: 'imports',
        confidence: edge.proof ? ('deterministic' as const) : ('file-level' as const),
        evidenceRefs: edge.evidence,
        status: 'verified' as const,
        linkId: undefined as string | undefined
      })),
      ...graph.links
        .filter((link) => link.target === current.ref)
        .map((link) => ({
          ref: link.source,
          relation: link.type,
          confidence:
            link.provenance?.kind === 'deterministic' || !node(link.target).symbol
              ? ('file-level' as const)
              : ('saved-link' as const),
          evidenceRefs: link.evidence.map((item) => item.ref),
          status: link.status ?? 'verified',
          linkId: link.id
        }))
    ];
    for (const neighbor of neighbors) {
      if (emitted.has(neighbor.ref)) continue;
      if (current.depth >= depth) {
        depthLimit = true;
        continue;
      }
      if (impacted.length >= cap) {
        resultLimit = true;
        continue;
      }
      emitted.add(neighbor.ref);
      const target = node(neighbor.ref);
      impacted.push({
        ...neighbor,
        confidence: current.fileLevel ? 'file-level' : neighbor.confidence,
        status:
          current.status === 'stale' || neighbor.status === 'stale'
            ? 'stale'
            : current.status === 'proposed' || neighbor.status === 'proposed'
              ? 'proposed'
              : 'verified',
        repo: target.project,
        viewId: target.viewId,
        projectId: target.projectId!,
        file: target.relativePath,
        symbol: target.symbol,
        direction: 'incoming',
        depth: current.depth + 1,
        via: current.ref,
        ...(options.verbose
          ? { evidence: neighbor.evidenceRefs.map((ref) => node(ref).evidence) }
          : {})
      });
      if (!visited.has(neighbor.ref)) {
        visited.add(neighbor.ref);
        queue.push({
          ref: neighbor.ref,
          depth: current.depth + 1,
          status: impacted.at(-1)!.status,
          fileLevel: impacted.at(-1)!.confidence === 'file-level'
        });
      }
      // Imported modules are the unit of file-level transitive propagation.
      const entry = chunks.get(neighbor.ref)!;
      for (const sibling of byFile.get(entry.view.source.repoId + ':' + entry.chunk.source_file) ??
        [])
        if (!visited.has(sibling)) {
          visited.add(sibling);
          queue.push({
            ref: sibling,
            depth: current.depth + 1,
            status: impacted.at(-1)!.status,
            fileLevel: true
          });
        }
    }
  }
  if (unknownRepos.length)
    warnings.add(
      `${unknownRepos.length} repository view(s) have no recorded imports or links; their impact is unknown.`
    );
  const truncated = resultLimit || depthLimit;
  return {
    changes,
    impacted,
    coverage: { basis: 'indexed-imports-and-recorded-links', repos, unknownRepos, complete: false },
    warnings: [...warnings],
    truncated,
    truncation: { resultLimit, depthLimit },
    summary: `${impacted.length} recorded impacted item(s) across ${new Set(impacted.map((item) => item.viewId)).size} view(s). ${truncated ? 'Results are truncated. ' : ''}Coverage is partial: absence of recorded impact does not establish no impact.${unknownRepos.length ? ` ${unknownRepos.length} view(s) have no dependency data.` : ''}`
  };
}
