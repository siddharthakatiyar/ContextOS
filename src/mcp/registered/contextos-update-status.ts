import { registerUpdateStatusTool } from '../tools/update-status.js';

import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const { originalServer } = c;
  registerUpdateStatusTool(originalServer);
}
