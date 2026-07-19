import net from 'net';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import path from 'path';
import { DB } from '../storage/database.js';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerGetContextTool } from "../../mcp/tools/get-context.js";
import { registerIndexFilesTool } from "../../mcp/tools/index-files.js";
import { registerGetStatusTool } from "../../mcp/tools/get-status.js";
import { registerGetGraphTools } from "../../mcp/tools/get-graph.js";
import { registerExecuteTool } from "../../mcp/tools/execute.js";
import { registerListTopicsTool } from "../../mcp/tools/list-topics.js";
import { registerKnowledgeTools } from "../../mcp/tools/knowledge.js";
import { registerFeedbackTools } from "../../mcp/tools/feedback.js";
import { startWatcher } from '../watcher/index.js';
import { SessionStore } from '../session/session-store.js';

import { fileURLToPath } from "url";
import type { FSWatcher } from "chokidar";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let version = '0.3.0';
try {
  let pkgPath = path.join(__dirname, "../../../../package.json");
  if (!fs.existsSync(pkgPath)) {
    pkgPath = path.join(__dirname, "../../../../../package.json");
  }
  version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version;
} catch {
  // fallback
}

export class ContextOSDaemon {
  private server: net.Server;
  private dbs: DB[] = [];
  private socketPath: string;
  private pidPath: string;
  private watcher?: FSWatcher;
  private projectDir: string;
  private connections = 0;
  private gcTimer?: NodeJS.Timeout;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
    const ctxDir = path.join(projectDir, '.contextos');
    if (!fs.existsSync(ctxDir)) {
      fs.mkdirSync(ctxDir, { recursive: true });
    }
    // On Windows, named pipes must be in \\.\pipe\ prefix. So we handle that conditionally.
    const isWin = process.platform === 'win32';
    if (isWin) {
      const nameHash = Buffer.from(projectDir).toString('hex');
      this.socketPath = path.join('\\\\?\\pipe', `contextos-${nameHash}`);
    } else {
      const runDir = path.join(os.homedir(), '.contextos', 'run');
      if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
      const shortHash = crypto.createHash('md5').update(projectDir).digest('hex').substring(0, 12);
      this.socketPath = path.join(runDir, `d-${shortHash}.sock`);
    }
    
    this.pidPath = path.join(ctxDir, 'daemon.pid');

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.on('error', (err: any) => {
      console.error(`Daemon server error: ${err.message}`);
    });
  }

  public async start(): Promise<void> {
    // Check if another daemon is already running
    if (fs.existsSync(this.pidPath)) {
      const pid = parseInt(fs.readFileSync(this.pidPath, 'utf8').trim(), 10);
      if (pid) {
        try {
          process.kill(pid, 0); // Check if alive
          throw new Error(`Daemon is already running with PID ${pid}`);
        } catch (err: any) {
          if (err.code === 'EPERM') {
            throw new Error(`Daemon is already running with PID ${pid} (owned by another user)`);
          } else if (err.code !== 'ESRCH') {
            throw err;
          }
          // Stale PID file, clean it up
          console.warn(`[ContextOS] Cleaning up stale PID file ${this.pidPath}`);
          fs.unlinkSync(this.pidPath);
        }
      }
    }

    // Clean up stale socket (Unix only)
    if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) {
      fs.unlinkSync(this.socketPath);
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

    this.watcher = startWatcher(this.dbs[0], this.projectDir);

    return new Promise((resolve, reject) => {
      this.server.once('error', (err) => {
        reject(err);
      });
      
      this.server.listen(this.socketPath, () => {
        fs.writeFileSync(this.pidPath, String(process.pid));
        
        // Override console.log and console.error to write to a log file instead
        // since the daemon is fully detached and stdio is ignored
        const logPath = path.join(path.dirname(this.pidPath), 'daemon.log');
        const logStream = fs.createWriteStream(logPath, { flags: 'a' });
        
        const logWithTime = (level: string, ...args: any[]) => {
          const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
          logStream.write(`[${new Date().toISOString()}] [${level}] ${msg}\n`);
        };
        
        console.log = (...args) => logWithTime('INFO', ...args);
        console.error = (...args) => logWithTime('ERROR', ...args);
        console.warn = (...args) => logWithTime('WARN', ...args);

        // Prevent unhandled errors from crashing the daemon
        process.on('uncaughtException', (err) => {
          console.error(`Daemon uncaught exception: ${err.message}\n${err.stack}`);
        });
        process.on('unhandledRejection', (reason) => {
          console.error(`Daemon unhandled rejection: ${reason}`);
        });

        const cleanup = () => this.stop();
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
        process.on('exit', cleanup);

        console.log(`ContextOS Daemon started on ${this.socketPath}`);
        this.resetGCTimer(); // Start GC timer
        resolve();
      });
    });
  }

  public stop() {
    try {
      if (fs.existsSync(this.pidPath)) fs.unlinkSync(this.pidPath);
      if (process.platform !== 'win32' && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
      for (const db of this.dbs) {
        db.close();
      }
      if (this.watcher) {
        this.watcher.close();
      }
      this.server.close();
    } catch {
      // Ignore errors on shutdown
    }
  }

  private handleConnection(socket: net.Socket) {
    this.connections++;
    this.resetGCTimer(); // Cancel GC since we have an active connection

    const mcpServer = new McpServer({
      name: "contextos-daemon",
      version: version,
    });

    // Register all tools for this specific MCP Server instance
    registerGetContextTool(mcpServer, this.dbs);
    registerIndexFilesTool(mcpServer, this.dbs[0]);
    registerGetStatusTool(mcpServer, this.dbs[0]);
    registerGetGraphTools(mcpServer, this.dbs[0]);
    registerExecuteTool(mcpServer);
    registerListTopicsTool(mcpServer, this.dbs[0]);
    registerKnowledgeTools(mcpServer, this.dbs);
    registerFeedbackTools(mcpServer, this.dbs);

    // Use StdioServerTransport but with the socket stream
    const transport = new StdioServerTransport(socket, socket);
    mcpServer.connect(transport).catch(console.error);

    socket.on('close', () => {
      this.connections--;
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
    if (this.connections <= 0) {
      this.gcTimer = setTimeout(() => {
        console.log("No connections for 30 minutes, shutting down daemon.");
        this.stop();
      }, 30 * 60 * 1000);
    }
  }
}
