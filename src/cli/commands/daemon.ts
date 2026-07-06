import { Command } from 'commander';
import { ContextOSDaemon } from '../../core/daemon/daemon.js';
import fs from 'fs';
import path from 'path';

export const daemonCommand = new Command('daemon')
  .description('Manage the ContextOS background daemon')

daemonCommand.command('start')
  .description('Start the ContextOS daemon for the current project')
  .action(async () => {
    const envRoot = process.env.CONTEXTOS_REPO_ROOT?.trim();
    let projectDir = envRoot && envRoot.length > 1 ? envRoot : process.cwd();
    if (projectDir === '/') {
      const os = await import('os');
      projectDir = os.default.homedir();
    }
    
    try {
      const daemon = new ContextOSDaemon(projectDir);
      await daemon.start();
    } catch (e: any) {
      process.stderr.write(`Failed to start daemon: ${e.message}\n`);
      process.exit(1);
    }
  });

daemonCommand.command('stop')
  .description('Stop the ContextOS daemon for the current project')
  .action(async () => {
    const projectDir = process.cwd();
    const pidPath = path.join(projectDir, '.contextos', 'daemon.pid');
    
    if (fs.existsSync(pidPath)) {
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
        process.kill(pid, 'SIGTERM');
        console.log(`Daemon (PID ${pid}) stopped.`);
        fs.unlinkSync(pidPath);
      } catch (e: any) {
        console.error(`Failed to stop daemon: ${e.message}`);
      }
    } else {
      console.log('No daemon is currently running for this project.');
    }
  });

daemonCommand.command('status')
  .description('Check the status of the ContextOS daemon')
  .action(async () => {
    const projectDir = process.cwd();
    const pidPath = path.join(projectDir, '.contextos', 'daemon.pid');
    
    if (fs.existsSync(pidPath)) {
      try {
        const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
        process.kill(pid, 0); // test if alive
        console.log(`Daemon is RUNNING (PID ${pid})`);
      } catch {
        console.log(`Daemon is NOT RUNNING (stale PID file found)`);
      }
    } else {
      console.log('Daemon is NOT RUNNING.');
    }
  });
