import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContextTool } from "./tools/get-context.js";
import { registerSaveContextTool } from "./tools/save-context.js";
import { registerIndexFilesTool } from "./tools/index-files.js";
import { registerGetStatusTool } from "./tools/get-status.js";
import { registerGetGraphTools } from "./tools/get-graph.js";
import { registerExecuteTool } from "./tools/execute.js";
import { registerListTopicsTool } from "./tools/list-topics.js";
import { registerReadTopicTool } from "./tools/read-topic.js";
import { DB } from "../core/storage/database.js";
import { checkForUpdates } from "../core/updater/index.js";
import { createRequire } from "module";
import fs from "fs";
import path from "path";

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

/**
 * Check if we should run the auto-updater.
 * Only runs once per day to avoid spawning unnecessary child processes.
 */
function shouldCheckForUpdates(): boolean {
  try {
    const markerPath = path.join(process.cwd(), '.contextos', 'last-update-check');
    const oneDayMs = 24 * 60 * 60 * 1000;
    if (fs.existsSync(markerPath)) {
      const lastCheck = parseInt(fs.readFileSync(markerPath, 'utf8').trim(), 10);
      if (Date.now() - lastCheck < oneDayMs) {
        return false;
      }
    }
    // Write current timestamp
    const dir = path.dirname(markerPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerPath, String(Date.now()));
    return true;
  } catch {
    return false;
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
  registerListTopicsTool(server, dbs[0]);
  registerReadTopicTool(server, dbs[0]);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // NOTE: File watcher is intentionally NOT started in serve mode.
  // Each MCP client spawns its own process — running N watchers on the same
  // directory tree exhausts file descriptors and crashes the system.
  // Use `contextos watch` CLI command for standalone file watching.
  
  // Check for auto-updates at most once per day
  if (shouldCheckForUpdates()) {
    checkForUpdates();
  }
  
  // Graceful shutdown: close DB connections on exit
  const cleanup = () => {
    for (const db of dbs) {
      try { db.close(); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Note: All logging must be to stderr for MCP servers using stdio transport
  process.stderr.write(`ContextOS MCP Server v${version} started.\n`);
}

