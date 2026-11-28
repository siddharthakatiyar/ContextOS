import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  c.registerViewTool('ctx_list_topics');
}
