import { z } from 'zod';

import { KnowledgeInspector } from '../../core/knowledge/inspector.js';
import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, scopeFor, wrap } = c;
  server.tool(
    'ctx_contract',
    'Inspect an indexed OpenAPI JSON/YAML or protobuf contract on demand. Returns HTTP methods, paths, schemas, or fully qualified gRPC operations and streaming signatures with fresh source evidence. Does not infer client/server connections, fetch external references or save edges; use ctx_link after establishing the connection.',
    {
      ...selectors,
      ref: z.string(),
      operation: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).default(20),
      include_schemas: z.boolean().default(false)
    },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      if (!context.resolve) throw new Error('Contract inspection requires a workspace runtime.');
      return {
        ...new KnowledgeInspector(graph, scope.sources, context.resolve).contract(
          args.ref as string,
          {
            operation: args.operation as string | undefined,
            limit: args.limit as number,
            includeSchemas: args.include_schemas as boolean
          }
        ),
        scope
      };
    })
  );
}
