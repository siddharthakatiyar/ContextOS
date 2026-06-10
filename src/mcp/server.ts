import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContextTool } from "./tools/get-context.js";
import { registerSaveContextTool } from "./tools/save-context.js";
import { registerIndexFilesTool } from "./tools/index-files.js";
import { registerGetStatusTool } from "./tools/get-status.js";
import { registerGetGraphTools } from "./tools/get-graph.js";
import { registerExecuteTool } from "./tools/execute.js";
import { DB } from "../core/storage/database.js";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

let version = '0.3.0';
try {
  version = require("../../package.json").version;
} catch {
  try {
    version = require("../../../package.json").version;
  } catch {
    // fallback
  }
}

export async function startMcpServer(dbs: DB[]) {
  const server = new McpServer({
    name: "contextos",
    version: version,
  });

  registerGetContextTool(server, dbs);
  registerSaveContextTool(server, dbs[0]);
  registerIndexFilesTool(server, dbs[0]);
  registerGetStatusTool(server, dbs[0]);
  registerGetGraphTools(server, dbs[0]);
  registerExecuteTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Note: All logging must be to stderr for MCP servers using stdio transport
  process.stderr.write(`ContextOS MCP Server started.\n`);
}
