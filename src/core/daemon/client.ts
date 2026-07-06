import net from 'net';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSocketPath(projectDir: string): string {
  const isWin = process.platform === 'win32';
  const nameHash = Buffer.from(projectDir).toString('hex');
  if (isWin) {
    return path.join('\\\\?\\pipe', `contextos-${nameHash}`);
  } else {
    const os = require('os');
    const runDir = path.join(os.homedir(), '.contextos', 'run');
    if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
    // Use a hash of the project path to ensure uniqueness but stay within max socket path length limit (104 chars)
    const shortHash = require('crypto').createHash('md5').update(projectDir).digest('hex').substring(0, 12);
    return path.join(runDir, `d-${shortHash}.sock`);
  }
}

function connectToDaemon(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    
    socket.once('connect', () => {
      resolve(socket);
    });
    
    socket.once('error', (err) => {
      reject(err);
    });
  });
}

function spawnDaemon(projectDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Find the CLI binary
    // client.ts is in dist/src/core/daemon/client.js
    // bin/contextos.js is in dist/bin/contextos.js
    let binPath = path.resolve(__dirname, '../../../bin/contextos.js');
    if (!fs.existsSync(binPath)) {
      // Maybe we are running via tsx in dev
      binPath = path.resolve(process.cwd(), 'bin/contextos.ts');
    }

    const isTs = binPath.endsWith('.ts');
    const cmd = isTs ? 'tsx' : 'node';
    const args = isTs ? [binPath, 'daemon', 'start'] : [binPath, 'daemon', 'start'];

    const child = spawn(cmd, args, {
      cwd: projectDir,
      detached: true,
      stdio: 'ignore', // run in background completely detached
      env: { ...process.env, CONTEXTOS_REPO_ROOT: projectDir }
    });

    child.unref();

    // Give the daemon a moment to start and bind the socket
    setTimeout(() => resolve(), 500);
  });
}

export async function runDaemonClient(projectDir: string): Promise<void> {
  const socketPath = getSocketPath(projectDir);
  
  let socket: net.Socket;
  try {
    socket = await connectToDaemon(socketPath);
  } catch (e: any) {
    // Daemon is likely not running. Spawn it.
    await spawnDaemon(projectDir);
    
    // Try again with retries
    let retries = 5;
    while (retries > 0) {
      try {
        socket = await connectToDaemon(socketPath);
        break;
      } catch (err) {
        retries--;
        if (retries === 0) {
          process.stderr.write(`Failed to connect to ContextOS Daemon at ${socketPath}: ${err}\n`);
          process.exit(1);
        }
        // Wait 200ms before retrying
        await new Promise(r => setTimeout(r, 200));
      }
    }
  }

  // Once connected, pipe stdio
  // @ts-ignore - socket is guaranteed to be assigned if we reached here
  process.stdin.pipe(socket);
  // @ts-ignore
  socket.pipe(process.stdout);

  // When socket closes, exit the proxy
  // @ts-ignore
  socket.on('close', () => {
    process.exit(0);
  });
  
  // @ts-ignore
  socket.on('error', (err: any) => {
    process.stderr.write(`Connection to daemon lost: ${err.message}\n`);
    process.exit(1);
  });
}
