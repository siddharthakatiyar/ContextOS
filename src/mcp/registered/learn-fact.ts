import { z } from 'zod';

import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const { server, legacyEnabled, knowledgeDefinitions } = c;
  if (!legacyEnabled) return;
  const remember = knowledgeDefinitions.find((d) => d.name === 'ctx_remember')!;
  server.tool(
    'learn_fact',
    'Deprecated alias for verified ctx_remember. Code facts require evidence and expected_generations. Use provenance=user only for an explicit user decision or preference.',
    {
      ...Object.fromEntries(
        Object.entries(remember.schema).filter(([key]) => !['content', 'type'].includes(key))
      ),
      fact: z.string()
    },
    (args) => remember.handler({ ...args, content: args.fact, type: 'cross_session_fact' })
  );
}
