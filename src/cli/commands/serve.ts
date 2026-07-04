import { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';
import { DB, acquireServerLock, releaseServerLock } from '../../core/storage/database.js';

export const serveCommand = new Command('serve')
  .description('Start the ContextOS MCP server (stdio)')
  .action(async () => {
    // Use CONTEXTOS_REPO_ROOT env var if set (MCP clients often spawn with CWD=/)
    const projectDir = process.env.CONTEXTOS_REPO_ROOT || process.cwd();
    
    // Change into the project directory so all path resolution works correctly
    try {
      process.chdir(projectDir);
    } catch {
      // If we can't chdir, continue with whatever cwd we have
    }
    
    // Prevent duplicate server processes for the same project
    if (!acquireServerLock(projectDir)) {
      process.stderr.write(`ContextOS: Another server is already running for ${projectDir}. Reusing existing instance.\n`);
    }
    
    // Release lock on exit
    const releaseLock = () => releaseServerLock(projectDir);
    process.on('exit', releaseLock);
    process.on('SIGINT', releaseLock);
    process.on('SIGTERM', releaseLock);
    
    // Suppress regular stdout logs since MCP uses stdout
    const dbs = DB.resolveDatabases(projectDir);
    await startMcpServer(dbs);
  });
