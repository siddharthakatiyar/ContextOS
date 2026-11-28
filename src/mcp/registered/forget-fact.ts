import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const { server, legacyEnabled, knowledgeDefinitions } = c;
  if (!legacyEnabled) return;
  const forget = knowledgeDefinitions.find((d) => d.name === 'ctx_forget')!;
  server.tool(
    'forget_fact',
    'Deprecated alias for ctx_forget; removes one fact within the selected scope.',
    forget.schema,
    forget.handler
  );
}
