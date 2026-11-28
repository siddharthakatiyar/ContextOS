import type { Evidence, LinkType, VerifiedLink } from './graph-store.js';

export interface TraceNode {
  status?: 'stale';
  ref: string;
  viewId: string;
  projectId?: string;
  project: string;
  worktreeId?: string;
  branch: string | null;
  head: string | null;
  relativePath: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  evidence: Evidence;
}
export interface TraceOptions {
  includeProposed?: boolean;
  /** Surface stale edges as diagnostics only; never use them as path witnesses. */
  includeStale?: boolean;
  start: string;
  target?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  relationships?: LinkType[];
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxPaths?: number;
  bridgeSameFile?: boolean;
}
export interface TraceStep {
  linkId?: string;
  inference?: 'same_file_adjacency';
  from: string;
  to: string;
  traversal: 'forward' | 'reverse' | 'inferred_same_file';
}
export interface TraceStop {
  ref: string;
  note?: string;
  reason:
    | 'no_recorded_connection'
    | 'depth_limit'
    | 'node_limit'
    | 'edge_limit'
    | 'path_limit'
    | 'stale_evidence'
    | 'unavailable_evidence';
}
export interface TraceResult {
  start: string;
  target?: string;
  direction: NonNullable<TraceOptions['direction']>;
  coverage:
    | 'recorded_links_including_stale'
    | 'recorded_verified_links_only'
    | 'recorded_links_including_proposed'
    | 'recorded_links_and_inferred_same_file_adjacency';
  found: boolean | null;
  nodes: TraceNode[];
  links: VerifiedLink[];
  paths: { refs: string[]; steps: TraceStep[] }[];
  stops: TraceStop[];
  partial: boolean;
  truncated: boolean;
}
export interface TraceAccess {
  inspect: (ref: string) => TraceNode;
  adjacent: (
    ref: string,
    direction: NonNullable<TraceOptions['direction']>,
    limit: number
  ) => { links: VerifiedLink[]; truncated: boolean };
  sameFile?: (ref: string, limit: number) => { refs: string[]; truncated: boolean };
  status: (link: VerifiedLink) => 'valid' | 'invalid' | 'unavailable';
}

function bound(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`Trace limits must be integers between 1 and ${maximum}.`);
  return value;
}

/** Deterministic breadth-first witness paths; never manufactures missing connections. */
export function traceVerifiedGraph(options: TraceOptions, access: TraceAccess): TraceResult {
  const maxDepth = bound(options.maxDepth, 6, 12);
  const maxNodes = bound(options.maxNodes, 50, 500);
  const maxEdges = bound(options.maxEdges, 100, 1000);
  const maxPaths = bound(options.maxPaths, 20, 100);
  const direction = options.direction ?? 'both';
  if (!['outgoing', 'incoming', 'both'].includes(direction))
    throw new Error('Unknown trace direction.');
  const root = access.inspect(options.start);
  if (options.target) access.inspect(options.target);
  const nodes = new Map([[root.ref, root]]);
  const links = new Map<string, VerifiedLink>();
  const staleLinks = new Map<string, VerifiedLink>();
  const result: TraceResult = {
    start: root.ref,
    target: options.target,
    direction,
    coverage: options.bridgeSameFile
      ? 'recorded_links_and_inferred_same_file_adjacency'
      : options.includeStale
        ? 'recorded_links_including_stale'
        : options.includeProposed
          ? 'recorded_links_including_proposed'
          : 'recorded_verified_links_only',
    found: options.target ? false : null,
    nodes: [],
    links: [],
    paths: [],
    stops: [],
    partial: false,
    truncated: false
  };
  let inferredEdges = 0;
  const queue = [{ refs: [root.ref], steps: [] as TraceStep[] }];
  const stop = (ref: string, reason: TraceStop['reason']) => {
    if (!result.stops.some((item) => item.ref === ref && item.reason === reason))
      result.stops.push({ ref, reason });
    if (reason !== 'no_recorded_connection') result.partial = true;
    if (reason.endsWith('_limit')) result.truncated = true;
  };
  const emit = (witness: (typeof queue)[number]) => {
    if (result.paths.length < maxPaths) result.paths.push(witness);
    else stop(witness.refs.at(-1)!, 'path_limit');
  };
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const witness = queue[cursor];
    const ref = witness.refs.at(-1)!;
    if (ref === options.target) {
      result.found = true;
      emit(witness);
      break;
    }
    const adjacent = access.adjacent(ref, direction, maxEdges + 1);
    if (adjacent.truncated) stop(ref, 'edge_limit');
    let extended = false;
    let eligible = 0;
    for (const link of adjacent.links) {
      if (options.relationships && !options.relationships.includes(link.type)) continue;
      const status = access.status(link);
      if (status !== 'valid') {
        if (options.includeStale && link.status === 'stale') {
          // Reserve the edge budget for live witness paths. Historical edges
          // are appended only after traversal, so diagnostics cannot block them.
          staleLinks.set(link.id, link);
        }
        stop(ref, status === 'invalid' ? 'stale_evidence' : 'unavailable_evidence');
        continue;
      }
      eligible++;
      const next = link.source === ref ? link.target : link.source;
      if (witness.steps.length >= maxDepth && !nodes.has(next)) {
        stop(ref, 'depth_limit');
        continue;
      }
      if (!links.has(link.id) && links.size + inferredEdges >= maxEdges) {
        stop(ref, 'edge_limit');
        continue;
      }
      if (!nodes.has(next) && nodes.size >= maxNodes) {
        stop(ref, 'node_limit');
        continue;
      }
      if (!nodes.has(next)) {
        try {
          nodes.set(next, access.inspect(next));
        } catch {
          stop(ref, 'unavailable_evidence');
          continue;
        }
        const step: TraceStep = {
          linkId: link.id,
          from: ref,
          to: next,
          traversal: link.source === ref ? 'forward' : 'reverse'
        };
        queue.push({ refs: [...witness.refs, next], steps: [...witness.steps, step] });
        extended = true;
      }
      links.set(link.id, link);
    }
    const neighbors = access.sameFile?.(ref, maxNodes + 1);
    const unseen = neighbors?.refs.filter((next) => !nodes.has(next)) ?? [];
    if (options.bridgeSameFile) {
      if (neighbors?.truncated) stop(ref, 'node_limit');
      for (const next of unseen) {
        if (witness.steps.length >= maxDepth) {
          stop(ref, 'depth_limit');
          break;
        }
        if (nodes.size >= maxNodes) {
          stop(ref, 'node_limit');
          break;
        }
        if (links.size + inferredEdges >= maxEdges) {
          stop(ref, 'edge_limit');
          break;
        }
        try {
          nodes.set(next, access.inspect(next));
        } catch {
          stop(ref, 'unavailable_evidence');
          continue;
        }
        inferredEdges++;
        queue.push({
          refs: [...witness.refs, next],
          steps: [
            ...witness.steps,
            {
              from: ref,
              to: next,
              traversal: 'inferred_same_file',
              inference: 'same_file_adjacency'
            }
          ]
        });
        extended = true;
      }
    }
    if ((!eligible || !extended) && !result.stops.some((item) => item.ref === ref)) {
      stop(ref, 'no_recorded_connection');
      if (!options.bridgeSameFile && unseen.length)
        result.stops.at(-1)!.note =
          'Other chunks in this file have recorded connections; bridge_same_file=true may extend traversal using inferred same-file adjacency.';
    }
    if (!options.target && !extended) emit(witness);
  }
  result.nodes = [...nodes.values()];
  const diagnosticBudget = Math.max(0, maxEdges - links.size - inferredEdges);
  if (staleLinks.size > diagnosticBudget) stop(root.ref, 'edge_limit');
  result.links = [...links.values(), ...[...staleLinks.values()].slice(0, diagnosticBudget)];
  return result;
}
