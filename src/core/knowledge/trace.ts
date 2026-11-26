import type { Evidence, LinkType, VerifiedLink } from './graph-store.js';

export interface TraceNode {
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
  start: string;
  target?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  relationships?: LinkType[];
  maxDepth?: number;
  maxNodes?: number;
  maxEdges?: number;
  maxPaths?: number;
}
export interface TraceStep {
  linkId: string;
  from: string;
  to: string;
  traversal: 'forward' | 'reverse';
}
export interface TraceStop {
  ref: string;
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
  coverage: 'recorded_verified_links_only';
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
  const result: TraceResult = {
    start: root.ref,
    target: options.target,
    direction,
    coverage: 'recorded_verified_links_only',
    found: options.target ? false : null,
    nodes: [],
    links: [],
    paths: [],
    stops: [],
    partial: false,
    truncated: false
  };
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
        stop(ref, status === 'invalid' ? 'stale_evidence' : 'unavailable_evidence');
        continue;
      }
      eligible++;
      const next = link.source === ref ? link.target : link.source;
      if (witness.steps.length >= maxDepth && !nodes.has(next)) {
        stop(ref, 'depth_limit');
        continue;
      }
      if (!links.has(link.id) && links.size >= maxEdges) {
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
    if (!eligible && !result.stops.some((item) => item.ref === ref))
      stop(ref, 'no_recorded_connection');
    if (!options.target && !extended) emit(witness);
  }
  result.nodes = [...nodes.values()];
  result.links = [...links.values()];
  return result;
}
