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
  unixSocketPath,
  assertNoSymlinkInPath
} from '../../utils/secure-state.js';
import { MCP_SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';
import { registerWorkspaceTools } from '../../mcp/workspace-tools.js';
import { getPackageVersion } from '../../utils/version.js';
import { getErrorMessage } from '../../utils/errors.js';
import { getActiveUpgradeToken } from '../updater/upgrade-lock.js';

export function workspaceStateDirectory(name: string): string {
  void name;
  return ensurePrivateStateDir(path.join(getContextOSHome(), 'runtime'));
}

export function workspaceSocketPath(): string {
  const root = workspaceStateDirectory('default');
  return process.platform === 'win32'
    ? getDaemonSocketPath(root)
    : unixSocketPath(root, 'daemon.sock');
}

export class WorkspaceDaemon {
  private registry = new WorkspaceRegistry();
  readonly runtime: WorkspaceRuntime;
  private server: net.Server;
  private clients = new Map<net.Socket, McpServer>();
  private clientWorkspaces = new Map<net.Socket, string>();
  private refresh?: NodeJS.Timeout;
  private idleTimer?: NodeJS.Timeout;
  private endpoint: string;
  private pidFile: string;
  private closing?: Promise<void>;
  private refreshing = false;
  private token = crypto.randomUUID();
  private started = false;
  constructor(readonly name: string) {
    const root = workspaceStateDirectory(name);
    this.endpoint = workspaceSocketPath();
    this.pidFile = path.join(root, 'daemon.pid');
    this.runtime = new WorkspaceRuntime(this.registry);
    this.server = net.createServer((socket) => this.connect(socket));
  }
  private scheduleIdleStop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.clients.size) return;
    const configured = Number(process.env.CONTEXTOS_DAEMON_IDLE_MS);
    const delay = Number.isFinite(configured) && configured > 0 ? configured : 60_000;
    this.idleTimer = setTimeout(() => void this.stop(), delay);
    this.idleTimer.unref();
  }
  async start(): Promise<void> {
    const lease = this.registry.takeLease('workspace:shared', {
      pid: process.pid,
      token: this.token,
      endpoint: this.endpoint,
      protocol: 1
    });
    if (lease.token !== this.token)
      throw new Error(`Workspace daemon already running (PID ${lease.pid})`);
    try {
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
      this.started = true;
      const refresh = async () => {
        if (this.refreshing) return;
        this.refreshing = true;
        try {
          await this.runtime.refreshWatchers([...new Set(this.clientWorkspaces.values())]);
        } catch (error) {
          process.stderr.write(`Workspace refresh: ${getErrorMessage(error)}\n`);
        } finally {
          this.refreshing = false;
        }
      };
      void refresh();
      this.refresh = setInterval(() => void refresh(), 5000);
      this.refresh.unref();
      this.scheduleIdleStop();
    } catch (error) {
      if (this.server.listening) {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
        if (process.platform !== 'win32' && fs.existsSync(this.endpoint)) {
          assertNoSymlinkInPath(this.endpoint);
          fs.unlinkSync(this.endpoint);
        }
      }
      this.registry.releaseLease('workspace:shared', this.token);
      throw error;
    }
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
          cwd?: string;
          action?: string;
          repoIds?: string[];
          token?: string;
          expectedVersion?: string;
        };
        if (setup.action === 'get-version' || setup.action === 'prepare-upgrade') {
          const token = getActiveUpgradeToken();
          const version = getPackageVersion();
          socket.resume();
          const error =
            !token || token !== setup.token
              ? 'Invalid upgrade token'
              : setup.action === 'prepare-upgrade' && setup.expectedVersion !== version
                ? 'Daemon version does not match the upgrade CLI'
                : setup.action === 'prepare-upgrade' && this.clients.size
                  ? 'Close active MCP clients before upgrading'
                  : undefined;
          if (error) {
            socket.end(JSON.stringify({ ok: false, error }) + '\n');
            return;
          }
          socket.end(JSON.stringify({ ok: true, version }) + '\n');
          if (setup.action === 'prepare-upgrade') void this.stop();
          return;
        }
        const workspace =
          setup.action === 'doctor' && setup.cwd
            ? this.registry.groups().find((group) => {
                const active = this.registry.active(setup.cwd!);
                return (
                  active &&
                  this.registry
                    .list(group.id, true)
                    .some((source) => source.repoId === active.repoId)
                );
              })
            : this.registry.workspace(setup.workspaceId);
        if (!workspace) throw new Error('Project is not registered in a group');
        if (setup.action === 'quiesce' || setup.action === 'resume') {
          if (!Array.isArray(setup.repoIds) || setup.repoIds.some((id) => typeof id !== 'string'))
            throw new Error('Expected repository IDs for maintenance');
          const ids = setup.repoIds;
          socket.resume();
          const operation =
            setup.action === 'quiesce'
              ? this.runtime.quiesce(ids)
              : Promise.resolve(this.runtime.resume(ids));
          void operation.then(
            () => socket.end(JSON.stringify({ ok: true }) + '\n'),
            (error) =>
              socket.end(JSON.stringify({ ok: false, error: getErrorMessage(error) }) + '\n')
          );
          return;
        }
        if (setup.action === 'refresh') {
          socket.resume();
          void this.runtime
            .refreshWatchers([...new Set(this.clientWorkspaces.values())])
            .then(() => this.runtime.waitForIdle())
            .then(
              () => socket.end(JSON.stringify({ ok: true }) + '\n'),
              (error) =>
                socket.end(JSON.stringify({ ok: false, error: getErrorMessage(error) }) + '\n')
            );
          return;
        }
        const source =
          (setup.cwd && this.registry.active(setup.cwd)) ||
          (setup.activeRepoId ? this.registry.resolve(setup.activeRepoId) : undefined);
        if (
          !source ||
          !this.registry.list(workspace.id, true).some((r) => r.repoId === source.repoId)
        )
          throw new Error('An active repository within the workspace is required');
        const server = new McpServer(
          { name: 'contextos', version: getPackageVersion() },
          { instructions: MCP_SERVER_INSTRUCTIONS }
        );
        registerWorkspaceTools(server, this.runtime, {
          cwd: setup.cwd ?? source.rootPath,
          workspace: workspace.name
        });
        this.clients.set(socket, server);
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.clientWorkspaces.set(socket, workspace.name);
        void this.runtime
          .refreshWatchers([...new Set(this.clientWorkspaces.values())])
          .catch((error) => process.stderr.write(`Workspace refresh: ${getErrorMessage(error)}\n`));
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
      this.clientWorkspaces.delete(socket);
      void server?.close();
      if (this.closing) return;
      this.scheduleIdleStop();
      void this.runtime
        .refreshWatchers([...new Set(this.clientWorkspaces.values())])
        .catch((error) => process.stderr.write(`Workspace refresh: ${getErrorMessage(error)}\n`));
    });
  }
  stop(): Promise<void> {
    return (this.closing ??= (async () => {
      if (this.refresh) clearInterval(this.refresh);
      if (this.idleTimer) clearTimeout(this.idleTimer);
      if (this.server.listening) this.server.close();
      for (const [socket, server] of this.clients) {
        await server.close();
        socket.destroy();
      }
      this.clients.clear();
      while (this.refreshing) await new Promise((resolve) => setTimeout(resolve, 20));
      await this.runtime.close();
      if (this.started) this.registry.releaseLease('workspace:shared', this.token);
      this.registry.close();
      if (this.started) removePrivateStateFile(this.pidFile);
      if (this.started && process.platform !== 'win32' && fs.existsSync(this.endpoint)) {
        assertNoSymlinkInPath(this.endpoint);
        fs.unlinkSync(this.endpoint);
      }
    })());
  }
}

/** Notify an existing workspace daemon without starting one just for removal. */
export async function refreshWorkspaceDaemon(
  name: string,
  action: 'refresh' | 'quiesce' | 'resume' = 'refresh',
  repoIds: string[] = []
): Promise<void> {
  const registry = new WorkspaceRegistry();
  try {
    const workspace = registry.workspace(name);
    const owner = registry.lease('workspace:shared');
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
        socket.write(JSON.stringify({ workspaceId: workspace.id, action, repoIds }) + '\n')
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
