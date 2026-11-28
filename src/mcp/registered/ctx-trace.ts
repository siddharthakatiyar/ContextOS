import { z } from 'zod';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, selectors, verbose, scopeFor, compactLink, wrap } = c;
  server.tool(
    'ctx_trace',
    'Defaults to compact nodes and evidence refs; use verbose for full metadata. Trace saved, evidence-backed relationships across selected projects and worktrees. Returns ordered shortest witness paths, citations and explicit gaps; does not discover or invent connections. Incoming/outgoing follow stored edge direction; both can traverse edges in reverse and labels those steps.',
    {
      ...selectors,
      ...verbose,
      start: z.string(),
      target: z.string().optional(),
      direction: z.enum(['outgoing', 'incoming', 'both']).default('both'),
      relationships: z
        .array(
          z.enum([
            'imports',
            'implements_contract',
            'calls_api',
            'publishes_event',
            'consumes_event',
            'reads_resource',
            'writes_resource'
          ])
        )
        .optional(),
      bridge_same_file: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          'Opt in to explicitly inferred adjacency between chunks in the same file; never saves these steps as links.'
        ),
      max_depth: z.number().int().min(1).max(12).default(6),
      max_nodes: z.number().int().min(1).max(500).default(50),
      max_edges: z.number().int().min(1).max(1000).default(100),
      max_paths: z.number().int().min(1).max(100).default(20)
    },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const trace = graph.trace(
        {
          start: args.start as string,
          target: args.target as string | undefined,
          direction: args.direction as 'outgoing' | 'incoming' | 'both',
          relationships: args.relationships as
            import('../../core/knowledge/graph-store.js').LinkType[] | undefined,
          maxDepth: args.max_depth as number,
          maxNodes: args.max_nodes as number,
          maxEdges: args.max_edges as number,
          maxPaths: args.max_paths as number,
          bridgeSameFile: args.bridge_same_file as boolean
        },
        scope.repoIds
      );
      if (args.verbose) return trace;
      return {
        ...trace,
        nodes: trace.nodes.map((node) => ({
          ref: node.ref,
          project: node.project,
          file: node.relativePath,
          lines: [node.startLine ?? null, node.endLine ?? null]
        })),
        links: trace.links.map((link) => ({
          ...compactLink(link),
          source: link.source,
          target: link.target
        }))
      };
    }, true)
  );
}
