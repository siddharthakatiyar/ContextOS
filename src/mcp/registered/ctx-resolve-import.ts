import { z } from 'zod';

import { KnowledgeInspector } from '../../core/knowledge/inspector.js';
import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, scopeFor, wrap } = c;
  server.tool(
    'ctx_resolve_import',
    'Inspect one exact local import on demand. Supports relative JS/TS imports, explicit file:/link: package dependencies and local Go module replacements. Returns indexed export locations and manifest evidence without saving edges. Inspect source binding/call-site use before asserting a symbol is consumed; unsupported or ambiguous mappings fail closed.',
    {
      ...selectors,
      source: z.string(),
      specifier: z.string().min(1),
      symbol: z.string().min(1).optional(),
      mode: z.enum(['import', 'require', 'types']).default('import')
    },
    wrap(async (args, graph) => {
      const scope = scopeFor(args);
      if (!context.resolve) throw new Error('Import inspection requires a workspace runtime.');
      const inspector = new KnowledgeInspector(graph, scope.sources, context.resolve);
      return {
        ...(await inspector.resolveImport({
          source: args.source as string,
          specifier: args.specifier as string,
          symbol: args.symbol as string | undefined,
          mode: args.mode as 'import' | 'require' | 'types'
        })),
        scope
      };
    })
  );
}
