import net from 'net';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
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
    const runDir = path.join(os.homedir(), '.contextos', 'run');
    if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
    // Use a hash of the project path to ensure uniqueness but stay within max socket path length limit (104 chars)
    const shortHash = crypto.createHash('md5').update(projectDir).digest('hex').substring(0, 12);
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

  const connectWithRetry = async (): Promise<net.Socket> => {
    let socket: net.Socket;
    try {
      socket = await connectToDaemon(socketPath);
    } catch (e: any) {
      await spawnDaemon(projectDir);
      let retries = 5;
      while (retries > 0) {
        try {
          socket = await connectToDaemon(socketPath);
          break;
        } catch (err) {
          retries--;
          if (retries === 0) {
            process.stderr.write(
              `Failed to connect to ContextOS Daemon at ${socketPath}: ${err}\n`
            );
            process.exit(1);
          }
          await new Promise((r) => setTimeout(r, 200));
        }
      }
    }
    return socket!;
  };

  const wireSocket = async () => {
    const socket = await connectWithRetry();

    process.stdin.pipe(socket);
    socket.pipe(process.stdout);

    const onDisconnect = () => {
      // Cleanup existing bindings
      process.stdin.unpipe(socket);
      socket.unpipe(process.stdout);

      // The daemon died or dropped us. Reconnect transparently.
      // Wait 100ms before trying to reconnect to let the port cleanup
      setTimeout(
        () =>
          wireSocket().catch((e) => {
            process.stderr.write(`Fatal reconnect error: ${e.message}\n`);
            process.exit(1);
          }),
        100
      );
    };

    socket.once('close', onDisconnect);
    socket.once('error', (err: any) => {
      // Suppress ECONNRESET logs since we handle it seamlessly
      if (err.code !== 'ECONNRESET') {
        process.stderr.write(`Connection to daemon lost: ${err.message}. Reconnecting...\n`);
      }
      socket.destroy();
      // onDisconnect will be called by 'close' event
    });
  };

  await wireSocket();
}
