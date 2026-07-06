import { Command } from 'commander';
import { runDaemonClient } from '../../core/daemon/client.js';

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
    
    // Provide stdout/stderr handlers to prevent crashing
    process.on('uncaughtException', (err) => {
      process.stderr.write(`ContextOS uncaught exception: ${err.message}\n`);
    });
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`ContextOS unhandled rejection: ${reason}\n`);
    });
    
    // Serve now just connects to the daemon or spawns it
    await runDaemonClient(projectDir);
  });
