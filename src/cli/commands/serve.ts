import { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';
import { DB, acquireServerLock, releaseServerLock } from '../../core/storage/database.js';

export const serveCommand = new Command('serve')
  .description('Start the ContextOS MCP server (stdio)')
  .action(async () => {
    const cwd = process.cwd();
    
    // Prevent duplicate server processes for the same project
    if (!acquireServerLock(cwd)) {
      process.stderr.write(`ContextOS: Another server is already running for ${cwd}. Reusing existing instance.\n`);
    }
    
    // Release lock on exit
    const releaseLock = () => releaseServerLock(cwd);
    process.on('exit', releaseLock);
    process.on('SIGINT', releaseLock);
    process.on('SIGTERM', releaseLock);
    
    // Suppress regular stdout logs since MCP uses stdout
    const dbs = DB.resolveDatabases();
    await startMcpServer(dbs);
  });

