import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGetContextTool } from './tools/get-context.js';
import { loadConfig } from '../config/index.js';
import { registerIndexFilesTool } from './tools/index-files.js';
import { registerGetStatusTool } from './tools/get-status.js';
import { registerGetGraphTools } from './tools/get-graph.js';
import { registerExecuteTool } from './tools/execute.js';
import { registerListTopicsTool } from './tools/list-topics.js';
import { registerKnowledgeTools } from './tools/knowledge.js';
import { registerFeedbackTools } from './tools/feedback.js';
import { registerReadFileTool } from './tools/read-file.js';
import { registerExpandTool } from './tools/expand.js';
import { MCP_SERVER_INSTRUCTIONS } from './instructions.js';
import { DB } from '../core/storage/database.js';
import { checkForUpdates, formatUpdateNotice } from '../core/updater/index.js';
import { registerUpdateStatusTool } from './tools/update-status.js';
import { getPackageVersion } from '../utils/version.js';

const version = getPackageVersion();

export async function startMcpServer(dbs: DB[]) {
  const server = new McpServer(
    {
      name: 'contextos',
      version: version
    },
    { instructions: MCP_SERVER_INSTRUCTIONS }
  );

  const config = loadConfig();

  registerGetContextTool(server, dbs);
  registerIndexFilesTool(server, dbs[0]);
  registerGetStatusTool(server, dbs[0]);
  registerUpdateStatusTool(server);
  registerExecuteTool(server);
  registerReadFileTool(server);
  registerExpandTool(server, dbs);

  if (config.legacyTools) {
    const { registerSaveContextTool } = await import('./tools/save-context.js');
    const { registerLegacyListTopicsTool } = await import('./tools/list-topics.js');
    const { registerLegacyReadTopicTool } = await import('./tools/read-topic.js');
    const { registerLegacyKnowledgeTools } = await import('./tools/knowledge.js');
    const { registerLegacyFeedbackTools } = await import('./tools/feedback.js');
    const { registerLegacyGetGraphTools } = await import('./tools/get-graph.js');

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

  const updateNotice = formatUpdateNotice(await checkForUpdates());
  if (updateNotice) process.stderr.write(updateNotice);

  // Graceful shutdown: close DB connections on exit
  const cleanup = () => {
    for (const db of dbs) {
      try {
        db.close();
      } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Note: All logging must be to stderr for MCP servers using stdio transport
  process.stderr.write(`ContextOS MCP Server v${version} started.\n`);
}
