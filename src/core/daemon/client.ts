import net from 'net';
import path from 'path';
import fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { getErrorCode, getErrorMessage } from '../../utils/errors.js';
import { canonicalDirectory, getDaemonSocketPath } from '../../utils/secure-state.js';
import { waitForUpgradeToFinish } from '../updater/upgrade-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function getSocketPath(projectDir: string): string {
  return getDaemonSocketPath(canonicalDirectory(projectDir));
}

function connectToDaemon(socketPath: string, timeoutMs = 1000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);

    socket.setTimeout(timeoutMs, () => socket.destroy(new Error('Socket connection timed out')));
    socket.once('connect', () => {
      socket.setTimeout(0);
      resolve(socket);
    });

    socket.once('error', (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

async function spawnDaemon(projectDir: string, workspace?: string): Promise<void> {
  let binPath = path.resolve(__dirname, '../../../bin/contextos.js');
  if (!fs.existsSync(binPath)) binPath = path.resolve(process.cwd(), 'bin/contextos.ts');
  const isTs = binPath.endsWith('.ts');
  const cmd = isTs ? 'tsx' : process.execPath;
  const args = [binPath, 'daemon', 'start', ...(workspace ? ['--workspace', workspace] : [])];
  await waitForUpgradeToFinish();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: projectDir,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CONTEXTOS_REPO_ROOT: projectDir }
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Wait for a newly started daemon to bind its socket, including under heavy startup load. */
export async function waitForDaemonSocket(
  socketPath: string,
  options: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<net.Socket> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 200;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      return await connectToDaemon(socketPath, Math.max(1, Math.min(1000, deadline - Date.now())));
    } catch (error) {
      lastError = error;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new Error(
          `ContextOS daemon did not become ready within ${timeoutMs}ms at ${socketPath}: ${getErrorMessage(lastError)}. Run contextos daemon status and contextos daemon start to diagnose.`
        );
      await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
    }
  }
}

/** Exponential backoff for transparent reconnects: 200ms, 400ms, ... capped at 8s. */
export function computeBackoffMs(attempt: number): number {
  return Math.min(100 * Math.pow(2, Math.max(0, attempt)), 8_000);
}

const MAX_RECONNECT_ATTEMPTS = 10;
const HEALTHY_CONNECTION_MS = 30_000;

/** Retry state shared by successive socket generations. */
export class ReconnectBackoff {
  private attempts = 0;

  public nextDelay(): number | null {
    this.attempts++;
    if (this.attempts > MAX_RECONNECT_ATTEMPTS) return null;
    return computeBackoffMs(this.attempts);
  }

  public reset(): void {
    this.attempts = 0;
  }

  public getAttempts(): number {
    return this.attempts;
  }
}

export async function runDaemonClient(
  projectDir: string,
  workspace?: { name: string; id: string; activeRepoId: string }
): Promise<void> {
  await waitForUpgradeToFinish();
  const socketPath = workspace
    ? (await import('../workspace/daemon.js')).workspaceSocketPath()
    : getSocketPath(projectDir);
  let activeRoot: string | undefined;
  if (workspace) {
    const { WorkspaceRegistry } = await import('../workspace/registry.js');
    const registry = new WorkspaceRegistry();
    try {
      activeRoot = registry.resolve(workspace.activeRepoId).rootPath;
    } finally {
      registry.close();
    }
  }
  const reconnectBackoff = new ReconnectBackoff();
  let stopping = false;
  let currentSocket: net.Socket | undefined;
  process.stdin.once('end', () => {
    stopping = true;
    currentSocket?.end();
  });

  const connectWithRetry = async (): Promise<net.Socket> => {
    try {
      return await connectToDaemon(socketPath);
    } catch {
      await spawnDaemon(projectDir, workspace?.name);
      return waitForDaemonSocket(socketPath);
    }
  };

  const wireSocket = async () => {
    if (stopping) return;
    const socket = await connectWithRetry();
    if (stopping) {
      socket.destroy();
      return;
    }
    currentSocket = socket;

    if (workspace)
      socket.write(
        JSON.stringify({
          workspaceId: workspace.id,
          activeRepoId: workspace.activeRepoId,
          cwd: activeRoot
        }) + '\n'
      );
    process.stdin.pipe(socket);
    socket.pipe(process.stdout);

    // A socket that stays up for this interval is considered healthy. Resetting
    // immediately on 'connect' made connect-then-crash loops start at attempt 1
    // forever, defeating both exponential backoff and the retry cap.
    const healthyTimer = setTimeout(() => reconnectBackoff.reset(), HEALTHY_CONNECTION_MS);

    const onDisconnect = () => {
      clearTimeout(healthyTimer);
      // Cleanup existing bindings
      process.stdin.unpipe(socket);
      socket.unpipe(process.stdout);
      if (stopping) return;

      // The daemon died or dropped us. Reconnect with exponential backoff —
      // previously this looped spawn→crash→respawn every ~600ms forever when
      // the daemon could not start (e.g. corrupt DB), pinning the CPU.
      const delay = reconnectBackoff.nextDelay();
      if (delay === null) {
        process.stderr.write(
          `ContextOS daemon unreachable after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts at ${socketPath}. Giving up.\n`
        );
        process.exit(1);
        return;
      }
      setTimeout(() => {
        wireSocket().catch((error) => {
          process.stderr.write(`Fatal reconnect error: ${getErrorMessage(error)}\n`);
          process.exit(1);
        });
      }, delay);
    };

    socket.once('close', onDisconnect);
    socket.once('error', (error) => {
      // Suppress ECONNRESET logs since we handle it seamlessly
      if (getErrorCode(error) !== 'ECONNRESET') {
        process.stderr.write(
          `Connection to daemon lost: ${getErrorMessage(error)}. Reconnecting...\n`
        );
      }
      socket.destroy();
      // onDisconnect will be called by 'close' event
    });
  };

  await wireSocket();
}
