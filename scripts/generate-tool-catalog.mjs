// Build artifact: the SDK serializes the same registrations used by the daemon.
import fs from 'node:fs';
import { workspaceToolCatalog } from '../dist/src/mcp/tool-catalog.js';
import { MCP_SERVER_INSTRUCTIONS } from '../dist/src/mcp/instructions.js';
const catalog = {
  instructions: MCP_SERVER_INSTRUCTIONS,
  standard: await workspaceToolCatalog(false),
  legacy: await workspaceToolCatalog(true)
};
fs.writeFileSync(
  new URL('../dist/src/mcp/tool-catalog.json', import.meta.url),
  JSON.stringify(catalog)
);
