import { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';
import { DB } from '../../core/storage/database.js';

export const serveCommand = new Command('serve')
  .description('Start the ContextOS MCP server (stdio)')
  .action(async () => {
    // Suppress regular stdout logs since MCP uses stdout
    const dbs = DB.resolveDatabases();
    await startMcpServer(dbs);
  });
