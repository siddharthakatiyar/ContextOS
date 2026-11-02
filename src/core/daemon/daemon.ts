import net from 'net';
import fs from 'fs';
import path from 'path';
import { DB } from '../storage/database.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerGetContextTool } from '../../mcp/tools/get-context.js';
import { registerIndexFilesTool } from '../../mcp/tools/index-files.js';
import { registerGetStatusTool } from '../../mcp/tools/get-status.js';
import { registerGetGraphTools } from '../../mcp/tools/get-graph.js';
import { registerExecuteTool } from '../../mcp/tools/execute.js';
import { registerListTopicsTool } from '../../mcp/tools/list-topics.js';
import { registerKnowledgeTools } from '../../mcp/tools/knowledge.js';
import { registerFeedbackTools } from '../../mcp/tools/feedback.js';
import { registerUpdateStatusTool } from '../../mcp/tools/update-status.js';
import { registerReadFileTool } from '../../mcp/tools/read-file.js';
import { registerExpandTool } from '../../mcp/tools/expand.js';
import { MCP_SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';
import { startWatcher, type ContextOSWatcher } from '../watcher/index.js';
import { SessionStore } from '../session/session-store.js';
import { BackgroundIndexer, waitForBackgroundIndexing } from './background-indexer.js';

import { getErrorCode, getErrorMessage } from '../../utils/errors.js';
import { getPackageVersion } from '../../utils/version.js';
import {
  assertNoSymlinkInPath,
  canonicalDirectory,
  ensurePrivateStateDir,
  getDaemonControlSocketPath,
  getDaemonSocketPath,
  preparePrivateStateFile,
  removePrivateStateFile,
  secureBoundSocket,
  tightenPrivateStateFile,
  writePrivateStateFile
} from '../../utils/secure-state.js';
import { getActiveUpgradeToken, isUpgradeInProgress } from '../updater/upgrade-lock.js';

const version = getPackageVersion();

export class ContextOSDaemon {
  private server: net.Server;
  private controlServer: net.Server;
  private dbs: DB[] = [];
  private socketPath: string;
  private controlSocketPath: string;
  private pidPath: string;
  private watcher?: ContextOSWatcher;
  private projectDir: string;
  private connections = 0;
  private clientSockets = new Set<net.Socket>();
  private gcTimer?: NodeJS.Timeout;
  private stopping = false;
  private startupReady = false;
  private stopPromise?: Promise<void>;
  private upgradeDrain?: Promise<void>;
  public backgroundIndexer?: BackgroundIndexer;

  constructor(projectDir: string) {
    this.projectDir = canonicalDirectory(projectDir);
    const ctxDir = ensurePrivateStateDir(path.join(this.projectDir, '.contextos'));
    this.socketPath = getDaemonSocketPath(this.projectDir);
    this.controlSocketPath = getDaemonControlSocketPath(this.projectDir);

    this.pidPath = path.join(ctxDir, 'daemon.pid');
    preparePrivateStateFile(this.pidPath);

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    this.controlServer = net.createServer((socket) => {
      this.handleControlConnection(socket);
    });

    this.server.on('error', (error) => {
      console.error(`Daemon server error: ${getErrorMessage(error)}`);
    });
    this.controlServer.on('error', (error) => {
      console.error(`Daemon control server error: ${getErrorMessage(error)}`);
    });
  }

  public async start(): Promise<void> {
    if (isUpgradeInProgress() && process.env.CONTEXTOS_UPGRADE_TOKEN !== getActiveUpgradeToken()) {
      throw new Error(
        'A ContextOS upgrade is in progress; wait for it to finish before starting a daemon.'
      );
    }
    preparePrivateStateFile(this.pidPath);
    // Check if another daemon is already running
    if (fs.existsSync(this.pidPath)) {
      const pid = parseInt(fs.readFileSync(this.pidPath, 'utf8').trim(), 10);
      if (pid) {
        try {
          process.kill(pid, 0); // Check if alive
          throw new Error(`Daemon is already running with PID ${pid}`);
        } catch (error) {
          const code = getErrorCode(error);
          if (code === 'EPERM') {
            throw new Error(`Daemon is already running with PID ${pid} (owned by another user)`);
          } else if (code !== 'ESRCH') {
            throw error;
          }
          // Stale PID file, clean it up
          console.warn(`[ContextOS] Cleaning up stale PID file ${this.pidPath}`);
          removePrivateStateFile(this.pidPath);
        }
      }
    }

    // Clean up stale socket (Unix only)
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      assertNoSymlinkInPath(this.socketPath);
      fs.unlinkSync(this.socketPath);
    }
    if (process.platform !== 'win32' && fs.existsSync(this.controlSocketPath)) {
      assertNoSymlinkInPath(this.controlSocketPath);
      fs.unlinkSync(this.controlSocketPath);
    }

    // Initialize core services ONCE
    this.dbs = DB.resolveDatabases(this.projectDir);

    // Lightweight startup: PRAGMA optimize + optional retention prune (B22)
    for (const db of this.dbs) {
      try {
        db.getInstance().pragma('optimize');
      } catch {
        // ignore optimize failures
      }
      try {
        const store = new SessionStore(db);
        store.pruneRetention();
      } catch {
        // retention is best-effort
      }
    }

    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        reject(err);
      });

      this.server.listen(this.socketPath, async () => {
        try {
          await new Promise<void>((controlResolve, controlReject) => {
            this.controlServer.once('error', controlReject);
            this.controlServer.listen(this.controlSocketPath, () => {
              try {
                secureBoundSocket(this.controlSocketPath);
                controlResolve();
              } catch (error) {
                controlReject(error);
              }
            });
          });
          // The private run directory blocks traversal before this chmod, and
          // the socket itself is tightened before any daemon work begins.
          secureBoundSocket(this.socketPath);
          writePrivateStateFile(this.pidPath, String(process.pid));
        } catch (error) {
          this.server.close();
          this.controlServer.close();
          reject(error);
          return;
        }

        // Override console.log and console.error to write to a log file instead
        // since the daemon is fully detached and stdio is ignored
        const logPath = path.join(path.dirname(this.pidPath), 'daemon.log');
        let logStream: ReturnType<typeof fs.createWriteStream>;
        try {
          preparePrivateStateFile(logPath);
          logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
          tightenPrivateStateFile(logPath);
        } catch (error) {
          this.server.close();
          this.controlServer.close();
          reject(error);
          return;
        }

        const logWithTime = (level: string, ...args: unknown[]) => {
          const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : a)).join(' ');
          logStream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
        };

        console.log = (...args) => logWithTime('INFO', ...args);
        console.error = (...args) => logWithTime('ERROR', ...args);
        console.warn = (...args) => logWithTime('WARN', ...args);

        // Keep the daemon alive on unexpected errors, but log them with full
        // context so failures are diagnosable instead of silent. NOTE: continuing
        // after an uncaughtException is deliberate (availability over strictness);
        // a clean self-restart on uncaught is tracked as future hardening.
        process.on('uncaughtException', (err) => {
          console.error(
            `Daemon uncaughtException [${err?.name || 'Error'}]: ${err?.message}\n${err?.stack || ''}`
          );
        });
        process.on('unhandledRejection', (reason) => {
          const detail =
            reason instanceof Error ? `${reason.message}\n${reason.stack || ''}` : String(reason);
          console.error(`Daemon unhandledRejection: ${detail}`);
        });

        const cleanup = () => {
          void this.stop();
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        console.log(`ContextOS Daemon started on ${this.socketPath}`);
        this.resetGCTimer(); // Start GC timer

        // Trigger background index if not complete
        try {
          const { loadConfig } = await import('../../config/index.js');
          const config = loadConfig({ cwd: this.projectDir });
          const statusPath = path.join(this.projectDir, '.contextos', 'status.json');
          let needsFullIndex = true;
          if (fs.existsSync(statusPath)) {
            const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
            const { INDEXER_VERSION } = await import('./background-indexer.js');
            if (status.fullIndexCompleted && status.indexerVersion === INDEXER_VERSION) {
              needsFullIndex = false;
            } else if (status.fullIndexCompleted && status.indexerVersion !== INDEXER_VERSION) {
              console.log(
                `[ContextOS] Indexer version changed (was ${status.indexerVersion || 'unknown'}, now ${INDEXER_VERSION}). Triggering auto-reindex...`
              );
            }
          }

          if (needsFullIndex) {
            // Start the watcher BEFORE indexing (buffered): events fired during
            // the full index used to be lost until restart. Buffered replays are
            // cheap — indexFile hash-skips unchanged files.
            this.watcher = startWatcher(this.dbs[0], this.projectDir, { buffered: true });
            const flushBufferedEvents = () => {
              try {
                (this.watcher as ContextOSWatcher | undefined)?.flushBufferedEvents?.();
              } catch (err) {
                console.error(
                  `[ContextOS] Failed replaying buffered watch events: ${getErrorMessage(err as Error)}`
                );
              }
            };
            this.backgroundIndexer = new BackgroundIndexer(this.dbs[0], this.projectDir);
            void this.backgroundIndexer.startFullIndex(config).then(
              () => flushBufferedEvents(),
              (err: Error) => {
                console.error(`[ERROR] Background indexer failed: ${err.message}`);
                // Flush even if indexing failed so we don't leave the daemon deaf
                flushBufferedEvents();
              }
            );
          } else {
            this.watcher = startWatcher(this.dbs[0], this.projectDir);
          }
        } catch (error) {
          console.error(`Failed to start background index: ${getErrorMessage(error)}`);
        }

        this.startupReady = true;
        resolve();
      });
    });
  }

  public stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  private async finishStop(): Promise<void> {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    try {
      if (!this.upgradeDrain) this.upgradeDrain = this.drainForUpgrade();
      await this.upgradeDrain;
    } catch (error) {
      console.error(`Daemon drain failed: ${getErrorMessage(error)}`);
      return;
    }

    for (const socket of this.clientSockets) socket.destroy();
    this.clientSockets.clear();

    try {
      if (this.server.listening) this.server.close();
      if (this.controlServer.listening) this.controlServer.close();
    } catch {
      // Ignore sockets that have already closed.
    }

    for (const db of this.dbs) {
      try {
        db.close();
      } catch {
        // Continue shutting down other databases.
      }
    }

    try {
      if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
        assertNoSymlinkInPath(this.socketPath);
        fs.unlinkSync(this.socketPath);
      }
      if (process.platform !== 'win32' && fs.existsSync(this.controlSocketPath)) {
        assertNoSymlinkInPath(this.controlSocketPath);
        fs.unlinkSync(this.controlSocketPath);
      }
      removePrivateStateFile(this.pidPath);
    } catch (error) {
      console.error(`Daemon state cleanup failed: ${getErrorMessage(error)}`);
    }
  }

  private drainForUpgrade(): Promise<void> {
    if (this.upgradeDrain) return this.upgradeDrain;
    this.stopping = true;
    if (this.gcTimer) clearTimeout(this.gcTimer);
    if (this.server.listening) this.server.close();

    this.upgradeDrain = (async () => {
      if (this.watcher) {
        await this.watcher.close();
        await this.watcher.waitForIdle?.();
      }
      await waitForBackgroundIndexing();
    })();
    return this.upgradeDrain;
  }

  private handleControlConnection(socket: net.Socket) {
    let answered = false;
    let buffer = '';
    const respond = (result: Record<string, unknown>, stopAfter = false) => {
      if (answered) return;
      answered = true;
      if (requestTimer) clearTimeout(requestTimer);
      if (socket.destroyed) {
        if (stopAfter) void this.stop();
        return;
      }
      socket.end(`${JSON.stringify(result)}\n`, () => {
        if (stopAfter) setTimeout(() => void this.stop(), 25).unref();
      });
    };
    const requestTimer = setTimeout(() => {
      respond({ ok: false, error: 'maintenance request timed out' });
    }, 30_000);

    socket.on('data', (chunk) => {
      if (answered) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > 8_192) {
        respond({ ok: false, error: 'maintenance request is too large' });
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;

      let request: unknown;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        respond({ ok: false, error: 'invalid maintenance request' });
        return;
      }
      if (
        request === null ||
        typeof request !== 'object' ||
        !('action' in request) ||
        (request.action !== 'get-version' && request.action !== 'prepare-upgrade') ||
        !('token' in request) ||
        typeof request.token !== 'string' ||
        request.token !== getActiveUpgradeToken()
      ) {
        respond({ ok: false, error: 'unauthorized maintenance request' });
        return;
      }
      if (!this.startupReady) {
        respond({
          ok: false,
          error: 'daemon startup is still in progress; retry after it is ready'
        });
        return;
      }
      if (request.action === 'get-version') {
        respond({ ok: true, version });
        return;
      }
      if (!('expectedVersion' in request) || request.expectedVersion !== version) {
        respond({ ok: false, error: 'daemon version does not match the upgrade CLI' });
        return;
      }
      if (this.connections > 0) {
        respond({
          ok: false,
          error: 'daemon has active MCP connections; close ContextOS clients and retry the upgrade'
        });
        return;
      }
      clearTimeout(requestTimer);

      void this.drainForUpgrade().then(
        () => respond({ ok: true, version }, true),
        (error: unknown) => respond({ ok: false, error: getErrorMessage(error) })
      );
    });
  }

  private handleConnection(socket: net.Socket) {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    this.connections++;
    this.clientSockets.add(socket);
    this.resetGCTimer(); // Cancel GC since we have an active connection

    const mcpServer = new McpServer(
      {
        name: 'contextos-daemon',
        version: version
      },
      { instructions: MCP_SERVER_INSTRUCTIONS }
    );

    // Register all tools for this specific MCP Server instance
    registerGetContextTool(mcpServer, this.dbs);
    registerIndexFilesTool(mcpServer, this.dbs[0]);
    registerGetStatusTool(mcpServer, this.dbs[0]);
    registerUpdateStatusTool(mcpServer);
    registerGetGraphTools(mcpServer, this.dbs[0]);
    registerExecuteTool(mcpServer);
    registerReadFileTool(mcpServer);
    registerExpandTool(mcpServer, this.dbs);
    registerListTopicsTool(mcpServer, this.dbs[0]);
    registerKnowledgeTools(mcpServer, this.dbs);
    registerFeedbackTools(mcpServer, this.dbs);

    // Use StdioServerTransport but with the socket stream
    const transport = new StdioServerTransport(socket, socket);
    mcpServer.connect(transport).catch(console.error);

    socket.on('close', () => {
      this.connections--;
      this.clientSockets.delete(socket);
      if (this.connections <= 0) {
        this.resetGCTimer(); // Start shutdown countdown when empty
      }
    });

    socket.on('error', (err) => {
      console.error(`Socket error: ${err.message}`);
    });
  }

  /**
   * Automatically shuts down the daemon if no one connects for 30 minutes.
   */
  private resetGCTimer() {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    if (!this.stopping && this.connections <= 0) {
      this.gcTimer = setTimeout(
        () => {
          console.log('No connections for 30 minutes, shutting down daemon.');
          this.stop();
        },
        30 * 60 * 1000
      );
    }
  }
}
