import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WorkspaceRegistry } from './registry.js';
import { WorkspaceRuntime } from './runtime.js';
import { getContextOSHome } from '../storage/database.js';
import {
  ensurePrivateStateDir,
  getDaemonSocketPath,
  writePrivateStateFile,
  removePrivateStateFile,
  secureBoundSocket,
  assertNoSymlinkInPath
} from '../../utils/secure-state.js';
import { registerWorkspaceTools } from '../../mcp/workspace-tools.js';
import { getPackageVersion } from '../../utils/version.js';
import { getErrorMessage } from '../../utils/errors.js';

export function workspaceStateDirectory(name: string): string {
  const registry = new WorkspaceRegistry();
  try {
    return ensurePrivateStateDir(
      path.join(getContextOSHome(), 'workspaces', registry.workspace(name).id)
    );
  } finally {
    registry.close();
  }
}

export class WorkspaceDaemon {
  private registry = new WorkspaceRegistry();
  readonly runtime: WorkspaceRuntime;
  private server: net.Server;
  private clients = new Map<net.Socket, McpServer>();
  private refresh?: NodeJS.Timeout;
  private endpoint: string;
  private pidFile: string;
  private closing?: Promise<void>;
  private refreshing = false;
  private token = crypto.randomUUID();
  constructor(readonly name: string) {
    const root = workspaceStateDirectory(name);
    this.endpoint = getDaemonSocketPath(root);
    this.pidFile = path.join(ensurePrivateStateDir(path.join(root, '.contextos')), 'daemon.pid');
    this.runtime = new WorkspaceRuntime(this.registry, name);
    this.server = net.createServer((socket) => this.connect(socket));
  }
  async start(): Promise<void> {
    const lease = this.registry.takeLease('workspace:' + this.registry.workspace(this.name).id, {
      pid: process.pid,
      token: this.token,
      endpoint: this.endpoint,
      protocol: 1
    });
    if (lease.token !== this.token)
      throw new Error(`Workspace daemon already running (PID ${lease.pid})`);
    if (fs.existsSync(this.pidFile)) {
      const pid = Number(fs.readFileSync(this.pidFile, 'utf8'));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new Error(`Workspace daemon already running (PID ${pid})`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    if (process.platform !== 'win32' && fs.existsSync(this.endpoint)) {
      assertNoSymlinkInPath(this.endpoint);
      fs.unlinkSync(this.endpoint);
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.endpoint, resolve);
    });
    secureBoundSocket(this.endpoint);
    writePrivateStateFile(this.pidFile, String(process.pid));
    const refresh = async () => {
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        await this.runtime.refreshWatchers();
      } catch (error) {
        process.stderr.write(`Workspace refresh: ${getErrorMessage(error)}\n`);
      } finally {
        this.refreshing = false;
      }
    };
    void refresh();
    this.refresh = setInterval(() => void refresh(), 1000);
    this.refresh.unref();
  }
  private connect(socket: net.Socket): void {
    let buffer = Buffer.alloc(0);
    socket.setTimeout(5000, () => socket.destroy());
    const receive = (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      if (buffer.length > 8192) {
        socket.destroy();
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      socket.removeListener('data', receive);
      socket.pause();
      socket.setTimeout(0);
      try {
        const setup = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as {
          workspaceId: string;
          activeRepoId?: string;
          action?: string;
        };
        if (setup.workspaceId !== this.registry.workspace(this.name).id)
          throw new Error('Workspace handshake does not match server');
        if (setup.action === 'refresh') {
          socket.resume();
          void this.runtime
            .refreshWatchers()
            .then(() => this.runtime.waitForIdle())
            .then(
              () => socket.end(JSON.stringify({ ok: true }) + '\n'),
              (error) =>
                socket.end(JSON.stringify({ ok: false, error: getErrorMessage(error) }) + '\n')
            );
          return;
        }
        const source = setup.activeRepoId ? this.registry.resolve(setup.activeRepoId) : undefined;
        if (!source || !this.registry.list(this.name).some((r) => r.repoId === source.repoId))
          throw new Error('An active repository within the workspace is required');
        const server = new McpServer({ name: 'contextos', version: getPackageVersion() });
        registerWorkspaceTools(server, this.runtime, {
          cwd: source.rootPath,
          activeRepoId: source.repoId
        });
        this.clients.set(socket, server);
        const rest = buffer.subarray(newline + 1);
        if (rest.length) socket.unshift(rest);
        void server
          .connect(new StdioServerTransport(socket, socket))
          .then(() => socket.resume())
          .catch(() => socket.destroy());
      } catch (error) {
        process.stderr.write(`Workspace connection: ${getErrorMessage(error)}\n`);
        socket.destroy();
      }
    };
    socket.on('data', receive);
    socket.on('error', () => {});
    socket.on('close', () => {
      const server = this.clients.get(socket);
      this.clients.delete(socket);
      void server?.close();
    });
  }
  stop(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.refresh) clearInterval(this.refresh);
      if (this.server.listening) this.server.close();
      for (const [socket, server] of this.clients) {
        await server.close();
        socket.destroy();
      }
      this.clients.clear();
      while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 20));
      await this.runtime.close();
      this.registry.releaseLease('workspace:' + this.registry.workspace(this.name).id, this.token);
      this.registry.close();
      removePrivateStateFile(this.pidFile);
      if (process.platform !== 'win32' && fs.existsSync(this.endpoint)) {
        assertNoSymlinkInPath(this.endpoint);
        fs.unlinkSync(this.endpoint);
      }
    })());
  }
}

/** Notify an existing workspace daemon without starting one just for removal. */
export async function refreshWorkspaceDaemon(name: string): Promise<void> {
  const registry = new WorkspaceRegistry();
  try {
    const workspace = registry.workspace(name);
    const owner = registry.lease('workspace:' + workspace.id);
    if (!owner) return;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise<void>((resolve, reject) => {
      const socket = net.createConnection(owner.endpoint);
      let buffer = '';
      socket.setTimeout(30 * 60 * 1000, () =>
        socket.destroy(new Error('Workspace drain timed out'))
      );
      socket.once('connect', () =>
        socket.write(JSON.stringify({ workspaceId: workspace.id, action: 'refresh' }) + '\n')
      );
      socket.on('data', (data) => {
        buffer += data.toString('utf8');
        if (!buffer.includes('\n')) return;
        socket.end();
        try {
          const result = JSON.parse(buffer.split('\n')[0]);
          if (!result.ok) throw new Error(result.error);
          resolve();
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
      socket.once('end', () => {
        if (!buffer.includes('\n'))
          reject(new Error('Workspace daemon disconnected before draining'));
      });
    });
  } finally {
    registry.close();
  }
}
