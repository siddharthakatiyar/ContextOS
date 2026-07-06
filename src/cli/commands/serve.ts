import { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';
import { DB, acquireServerLock, releaseServerLock } from '../../core/storage/database.js';

export const serveCommand = new Command('serve')
  .description('Start the ContextOS MCP server (stdio)')
  .action(async () => {
    // Use CONTEXTOS_REPO_ROOT env var if set (MCP clients often spawn with CWD=/)
    const envRoot = process.env.CONTEXTOS_REPO_ROOT?.trim();
    let projectDir = envRoot && envRoot.length > 1 ? envRoot : process.cwd();
    
    // If CWD is root (/) — which happens when MCP clients don't set CWD —
    // fall back to home directory to avoid writing to filesystem root
    if (projectDir === '/') {
      const os = await import('os');
      projectDir = os.default.homedir();
    }
    
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
