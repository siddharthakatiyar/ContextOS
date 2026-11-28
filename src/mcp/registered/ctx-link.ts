import { knowledgeWriteSchema } from '../knowledge-write-schema.js';
import { resolveKnowledgeWriteContext } from '../../core/knowledge/write-context.js';

import { z } from 'zod';

import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  const { server, context, selectors, verbose, writeResult, scopeFor, wrap } = c;
  server.tool(
    'ctx_link',
    'Save a verified relationship after inspecting both endpoints and necessary dependency/routing/contract evidence. Matching names alone are insufficient. Save no guesses or ambiguous candidates. Writes validate source freshness, not semantic correctness.',
    {
      ...knowledgeWriteSchema,
      ...selectors,
      ...verbose,
      source: z.string(),
      target: z.string(),
      relationship: z.enum([
        'imports',
        'implements_contract',
        'calls_api',
        'publishes_event',
        'consumes_event',
        'reads_resource',
        'writes_resource'
      ]),
      rationale: z.string().min(1),
      evidence: z.array(z.string()).optional(),
      expected_generations: z.record(z.string(), z.number().int().nonnegative())
    },
    wrap((args, graph) => {
      const scope = scopeFor(args);
      const link = graph.link(
        {
          ...resolveKnowledgeWriteContext(args),
          source: args.source as string,
          target: args.target as string,
          type: args.relationship as import('../../core/knowledge/graph-store.js').LinkType,
          rationale: args.rationale as string,
          evidenceRefs: args.evidence as string[] | undefined,
          expectedGenerations: args.expected_generations as Record<string, number>
        },
        scope.repoIds
      );
      context.clearCache();
      return writeResult(
        args,
        {
          link: args.verbose
            ? link
            : { id: link.id, type: link.type, source: link.source, target: link.target },
          endpoints: [link.source, link.target].map((ref) => ({
            ref,
            name: scope.sources.find((s) => ref.startsWith(`contextos:${s.repoId}:`))?.name
          })),
          generations: Object.fromEntries(link.evidence.map((e) => [e.viewId, e.generation])),
          warnings: []
        },
        scope
      );
    })
  );
}
