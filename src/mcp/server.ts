import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContextTool } from "./tools/get-context.js";
import { loadConfig } from "../config/index.js";
import { registerSaveContextTool } from "./tools/save-context.js";
import { registerIndexFilesTool } from "./tools/index-files.js";
import { registerGetStatusTool } from "./tools/get-status.js";
import { registerGetGraphTools } from "./tools/get-graph.js";
import { registerExecuteTool } from "./tools/execute.js";
import { registerListTopicsTool } from "./tools/list-topics.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerFeedbackTools } from "./tools/feedback.js";
import { registerReadFileTool } from "./tools/read-file.js";
import { registerExpandTool } from "./tools/expand.js";
import { DB } from "../core/storage/database.js";
import { checkForUpdates } from "../core/updater/index.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let version = '0.3.0';
try {
  let pkgPath = path.join(__dirname, "../../package.json");
  if (!fs.existsSync(pkgPath)) {
    pkgPath = path.join(__dirname, "../../../package.json");
  }
  version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
} catch {
  // fallback
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

  const config = loadConfig();

  registerGetContextTool(server, dbs);
  registerIndexFilesTool(server, dbs[0]);
  registerGetStatusTool(server, dbs[0]);
  registerExecuteTool(server);
  registerReadFileTool(server);
  registerExpandTool(server, dbs);
  
  if (config.legacyTools) {
    const { registerSaveContextTool } = await import("./tools/save-context.js");
    const { registerLegacyListTopicsTool } = await import("./tools/list-topics.js");
    const { registerLegacyReadTopicTool } = await import("./tools/read-topic.js");
    const { registerLegacyKnowledgeTools } = await import("./tools/knowledge.js");
    const { registerLegacyFeedbackTools } = await import("./tools/feedback.js");
    const { registerLegacyGetGraphTools } = await import("./tools/get-graph.js");
    
    registerSaveContextTool(server, dbs[0]);
    registerLegacyListTopicsTool(server, dbs[0]);
    registerLegacyReadTopicTool(server, dbs[0]);
    registerLegacyKnowledgeTools(server, dbs);
    registerLegacyFeedbackTools(server, dbs);
    registerLegacyGetGraphTools(server, dbs[0]);
  } else {
    registerListTopicsTool(server, dbs[0]);
    registerKnowledgeTools(server, dbs);
    registerFeedbackTools(server, dbs);
    registerGetGraphTools(server, dbs[0]);
  }

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

