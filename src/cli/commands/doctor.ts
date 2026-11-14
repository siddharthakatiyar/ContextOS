import { Command, Option } from 'commander';
import Database from 'better-sqlite3';
import chalk from 'chalk';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { INDEXER_VERSION } from '../../core/daemon/background-indexer.js';
import { getPackageVersion } from '../../utils/version.js';
import { canonicalDirectory, unixSocketPath } from '../../utils/secure-state.js';
import { registeredProjectPaths } from '../../core/workspace/project-paths.js';
import {
  DIAGNOSTIC_CLIENTS,
  inspectAgentDiagnostics,
  inspectRegisteredScope,
  type DiagnosticClient
} from '../utils/agent-diagnostics.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  summary: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  root: string;
  cliVersion: string;
  checks: DoctorCheck[];
  summary: Record<DoctorStatus, number>;
  exitCode: 0 | 1;
}

interface McpServerEntry {
  serverName?: string;
  command?: string;
  args?: string[];
  env?: Record<string, unknown>;
}

interface DaemonPidResult {
  check: DoctorCheck;
  pid: number | null;
  processExists: boolean;
}

interface DaemonProbeResult {
  serverInfo: { name?: string; version?: string } | null;
  tools: string[];
}

const PROJECT_MCP_CONFIGS = [
  { relativePath: '.mcp.json', format: 'json' as const },
  { relativePath: path.join('.cursor', 'mcp.json'), format: 'json' as const },
  { relativePath: path.join('.agents', 'mcp_config.json'), format: 'json' as const },
  { relativePath: path.join('.vscode', 'cline_mcp_settings.json'), format: 'json' as const },
  { relativePath: path.join('.vscode', 'roo_mcp_settings.json'), format: 'json' as const },
  { relativePath: path.join('.codex', 'config.toml'), format: 'toml' as const }
];

const EXPECTED_READ_HELPERS = ['ctx_expand', 'ctx_read_file'];
const MCP_PROBE_TIMEOUT_MS = 1_200;
const STALE_CHECK_LIMIT = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function canonicalIfAvailable(inputPath: string): string {
  try {
    return fs.realpathSync(inputPath);
  } catch {
    return path.resolve(inputPath);
  }
}

function parseTomlString(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      return typeof parsed === 'string' ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.lastIndexOf("'");
    return end > 0 ? trimmed.slice(1, end) : undefined;
  }
  return undefined;
}

function parseTomlStringArray(value: string): string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(value.trim());
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function isContextOSMcpEntry(entry: McpServerEntry): boolean {
  if (entry.env && ('CONTEXTOS_REPO_ROOT' in entry.env || 'CONTEXTOS_WORKSPACE' in entry.env)) {
    return true;
  }

  const commandName = entry.command?.replace(/\\/g, '/').split('/').pop() ?? '';
  if (/^contextos(?:\.(?:cmd|exe))?$/i.test(commandName)) return true;

  return (
    entry.args?.some((argument) => {
      const normalized = argument.replace(/\\/g, '/');
      return (
        /(?:^|\/)contextos(?:\.(?:[cm]?js|ts))?$/i.test(normalized) ||
        /^@siddharthakatiyar\/contextos(?:@[^/]+)?$/i.test(normalized)
      );
    }) ?? false
  );
}

function readTomlMcpEntries(contents: string): McpServerEntry[] {
  const entries = new Map<string, McpServerEntry>();
  let current: McpServerEntry | null = null;
  let section: 'other' | 'server' | 'env' = 'other';

  for (const line of contents.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)?.[1];
    if (header) {
      const match = header.match(
        /^mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))(?:\.(env))?$/
      );
      if (!match) {
        current = null;
        section = 'other';
        continue;
      }

      const serverName = match[1] ?? match[2] ?? match[3];
      current = entries.get(serverName) ?? { serverName, env: {} };
      entries.set(serverName, current);
      section = match[4] ? 'env' : 'server';
      continue;
    }

    if (!current || section === 'other') continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(?:#.*)?$/);
    if (!assignment) continue;
    const [, key, rawValue] = assignment;
    if (section === 'server') {
      if (key === 'command') current.command = parseTomlString(rawValue);
      if (key === 'args') current.args = parseTomlStringArray(rawValue);
    } else if (key === 'CONTEXTOS_REPO_ROOT' || key === 'CONTEXTOS_WORKSPACE') {
      const value = parseTomlString(rawValue);
      if (value !== undefined && current.env) current.env[key] = value;
    }
  }

  return [...entries.values()].filter(isContextOSMcpEntry);
}

function readJsonMcpEntry(contents: string): { entry: McpServerEntry | null; error?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      entry: null,
      error: 'invalid JSON (contents omitted)'
    };
  }

  if (!isRecord(parsed)) return { entry: null, error: 'top-level JSON value must be an object' };
  if (parsed.mcpServers === undefined) return { entry: null };
  if (!isRecord(parsed.mcpServers)) return { entry: null, error: 'mcpServers must be an object' };

  const entry = parsed.mcpServers.contextos;
  if (entry === undefined) return { entry: null };
  if (!isRecord(entry)) return { entry: null, error: 'mcpServers.contextos must be an object' };

  const env = entry.env;
  if (env !== undefined && !isRecord(env)) {
    return { entry: null, error: 'mcpServers.contextos.env must be an object' };
  }

  const args = entry.args;
  if (
    args !== undefined &&
    (!Array.isArray(args) || !args.every((item) => typeof item === 'string'))
  ) {
    return { entry: null, error: 'mcpServers.contextos.args must be a string array' };
  }

  return {
    entry: {
      serverName: 'contextos',
      command: asString(entry.command),
      args: args as string[] | undefined,
      env: env as Record<string, unknown> | undefined
    }
  };
}

function resolveCommandPath(command: string, root: string): string | null {
  const commandPath =
    command.includes(path.sep) || path.isAbsolute(command)
      ? path.resolve(root, command)
      : ((process.env.PATH ?? '')
          .split(path.delimiter)
          .map((directory) => path.join(directory, command))
          .find((candidate) => {
            try {
              fs.accessSync(candidate, fs.constants.X_OK);
              return true;
            } catch {
              return false;
            }
          }) ?? null);

  if (!commandPath) return null;
  try {
    return fs.realpathSync(commandPath);
  } catch {
    return commandPath;
  }
}

interface ConfiguredScript {
  path: string;
  exists: boolean;
}

function configuredScriptPath(entry: McpServerEntry, root: string): ConfiguredScript | null {
  if (!entry.command) return null;
  let candidate: string | null = null;
  const commandPath = resolveCommandPath(entry.command, root);

  if (/\.(?:[cm]?js|ts)$/i.test(entry.command)) {
    candidate =
      commandPath ??
      (path.isAbsolute(entry.command) || entry.command.includes(path.sep)
        ? path.resolve(root, entry.command)
        : null);
  } else if (/^node(?:js)?(?:\.exe)?$/i.test(path.basename(entry.command))) {
    candidate = entry.args?.find((arg) => /\.(?:[cm]?js|ts)$/i.test(arg))
      ? path.resolve(
          root,
          entry.args.find((arg) => /\.(?:[cm]?js|ts)$/i.test(arg))!
        )
      : null;
  } else if (commandPath && /\.(?:[cm]?js|ts)$/i.test(commandPath)) {
    candidate = commandPath;
  }

  if (!candidate) return null;
  const scriptPath = canonicalIfAvailable(candidate);
  let exists = false;
  try {
    exists = fs.statSync(scriptPath).isFile();
  } catch {
    // A known configured script path that cannot be read is not a package version.
  }
  return { path: scriptPath, exists };
}

function packageVersionForScript(scriptPath: string | null): string | null {
  if (!scriptPath) return null;
  let directory = path.dirname(scriptPath);
  for (let depth = 0; depth < 7; depth++) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (parsed.name === '@siddharthakatiyar/contextos' && typeof parsed.version === 'string') {
        return parsed.version;
      }
    } catch {
      // Continue toward the package root; installed and source layouts differ.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

function inspectMcpConfigs(root: string, cliVersion: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  let discoveredEntries = 0;

  for (const config of PROJECT_MCP_CONFIGS) {
    const configPath = path.join(root, config.relativePath);
    if (!fs.existsSync(configPath)) continue;

    let entries: McpServerEntry[] = [];
    let parseError: string | undefined;
    try {
      const contents = fs.readFileSync(configPath, 'utf8');
      if (config.format === 'json') {
        const parsed = readJsonMcpEntry(contents);
        entries = parsed.entry ? [parsed.entry] : [];
        parseError = parsed.error;
      } else {
        entries = readTomlMcpEntries(contents);
      }
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }

    if (parseError) {
      checks.push({
        id: `mcp-config:${config.relativePath}`,
        status: 'fail',
        summary: `Cannot inspect ${config.relativePath}: ${parseError}`,
        details: { path: configPath }
      });
      continue;
    }
    if (entries.length === 0) continue;

    for (const entry of entries) {
      discoveredEntries++;
      const serverSuffix =
        entry.serverName && entry.serverName !== 'contextos' ? `:${entry.serverName}` : '';
      const configLabel = serverSuffix
        ? `${config.relativePath} (${entry.serverName})`
        : config.relativePath;
      const configuredRoot = entry.env?.CONTEXTOS_REPO_ROOT;
      if (configuredRoot === undefined || configuredRoot === '') {
        checks.push({
          id: `mcp-root:${config.relativePath}${serverSuffix}`,
          status: 'unknown',
          summary: `${configLabel} does not set CONTEXTOS_REPO_ROOT; the MCP client's launch directory determines the repository`,
          details: { path: configPath }
        });
      } else if (typeof configuredRoot !== 'string') {
        checks.push({
          id: `mcp-root:${config.relativePath}${serverSuffix}`,
          status: 'fail',
          summary: `${configLabel} has a non-string CONTEXTOS_REPO_ROOT`,
          details: { path: configPath }
        });
      } else if (!path.isAbsolute(configuredRoot)) {
        checks.push({
          id: `mcp-root:${config.relativePath}${serverSuffix}`,
          status: 'unknown',
          summary: `${configLabel} uses a relative CONTEXTOS_REPO_ROOT, whose resolution depends on the MCP client's working directory`,
          details: { path: configPath, configuredRoot }
        });
      } else {
        const resolvedRoot = canonicalIfAvailable(configuredRoot);
        const matches = resolvedRoot === root;
        checks.push({
          id: `mcp-root:${config.relativePath}${serverSuffix}`,
          status: matches ? 'pass' : 'fail',
          summary: matches
            ? `${configLabel} points at this repository`
            : `${configLabel} points at ${resolvedRoot}, not this repository`,
          details: { path: configPath, configuredRoot, resolvedRoot, expectedRoot: root }
        });
      }

      const configuredScript = configuredScriptPath(entry, root);
      if (configuredScript && !configuredScript.exists) {
        checks.push({
          id: `mcp-version:${config.relativePath}${serverSuffix}`,
          status: 'fail',
          summary: `The configured ContextOS script does not exist at ${configuredScript.path}`,
          details: { path: configPath, scriptPath: configuredScript.path }
        });
        continue;
      }

      const configuredVersion = packageVersionForScript(configuredScript?.path ?? null);
      if (configuredVersion === null) {
        checks.push({
          id: `mcp-version:${config.relativePath}${serverSuffix}`,
          status: 'unknown',
          summary: `Cannot determine the installed version configured by ${configLabel} without running its command`,
          details: { path: configPath, scriptPath: configuredScript?.path ?? null }
        });
      } else {
        const matches = configuredVersion === cliVersion;
        checks.push({
          id: `mcp-version:${config.relativePath}${serverSuffix}`,
          status: matches ? 'pass' : 'fail',
          summary: matches
            ? `${configLabel} uses ContextOS ${configuredVersion}`
            : `${configLabel} uses ContextOS ${configuredVersion}, while this CLI is ${cliVersion}`,
          details: {
            path: configPath,
            scriptPath: configuredScript?.path ?? null,
            configuredVersion,
            cliVersion
          }
        });
      }
    }
  }

  if (discoveredEntries === 0 && !checks.some((check) => check.id.startsWith('mcp-config:'))) {
    checks.push({
      id: 'mcp-configs',
      status: 'unknown',
      summary: 'No project MCP configuration with a ContextOS server entry was found',
      details: { inspectedPaths: PROJECT_MCP_CONFIGS.map((config) => config.relativePath) }
    });
  }

  return checks;
}

function inspectIndexDatabase(
  root: string,
  databasePath = path.join(root, '.contextos', 'index.db')
): DoctorCheck {
  if (!fs.existsSync(databasePath)) {
    return {
      id: 'index-database',
      status: 'unknown',
      summary: 'No local index database exists yet',
      details: { path: databasePath }
    };
  }

  let db: Database.Database | undefined;
  try {
    // The regular DB constructor creates state, applies migrations, and can
    // recover a corrupt database. Doctor must never do any of those things.
    db = new Database(databasePath, { readonly: true, fileMustExist: true, timeout: 500 });
    db.pragma('query_only = ON');
    const quickCheck = db.pragma('quick_check') as Array<{ quick_check?: string }>;
    if (!quickCheck.length || quickCheck[0].quick_check !== 'ok') {
      return {
        id: 'index-database',
        status: 'fail',
        summary: 'The local index database failed SQLite quick_check',
        details: { path: databasePath, quickCheck }
      };
    }

    const tables = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name)
    );
    const requiredTables = ['schema_version', 'files', 'chunks', 'relationships'];
    const missingTables = requiredTables.filter((table) => !tables.has(table));
    if (missingTables.length > 0) {
      return {
        id: 'index-database',
        status: 'fail',
        summary: `The local index database is missing required tables: ${missingTables.join(', ')}`,
        details: { path: databasePath, missingTables }
      };
    }

    const counts = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM files WHERE layer = 'repo') AS files,
          (SELECT COUNT(*) FROM chunks WHERE layer = 'repo') AS chunks,
          (SELECT COUNT(*) FROM relationships WHERE layer = 'repo') AS relationships`
      )
      .get() as { files: number; chunks: number; relationships: number };

    const sample = db
      .prepare(`SELECT path, last_indexed FROM files WHERE layer = 'repo' LIMIT ?`)
      .all(STALE_CHECK_LIMIT) as Array<{ path: string; last_indexed: number }>;
    let newerOnDisk = 0;
    let missingOnDisk = 0;
    let pathsOutsideRoot = 0;
    for (const row of sample) {
      const relative = path.relative(root, row.path);
      if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
        pathsOutsideRoot++;
      }
      try {
        if (!fs.existsSync(row.path)) {
          missingOnDisk++;
        } else if (fs.statSync(row.path).mtimeMs > row.last_indexed) {
          newerOnDisk++;
        }
      } catch {
        // Unreadable files are omitted from the mtime heuristic.
      }
    }

    const check: DoctorCheck = {
      id: 'index-database',
      status: pathsOutsideRoot > 0 ? 'fail' : newerOnDisk + missingOnDisk > 0 ? 'warn' : 'pass',
      summary:
        pathsOutsideRoot > 0
          ? `${pathsOutsideRoot} sampled repo-layer index rows point outside this repository`
          : newerOnDisk + missingOnDisk > 0
            ? `The index opens cleanly; its freshness heuristic found ${newerOnDisk} newer and ${missingOnDisk} missing file(s)`
            : 'The local index database opens cleanly and its sampled repo files show no mtime changes',
      details: {
        path: databasePath,
        ...counts,
        sampledFiles: sample.length,
        sampleLimit: STALE_CHECK_LIMIT,
        newerOnDisk,
        missingOnDisk,
        pathsOutsideRoot,
        freshnessMethod: 'sampled file mtime newer than last_indexed; heuristic only'
      }
    };
    return check;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = (error as NodeJS.ErrnoException).code;
    const transientLock = code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
    return {
      id: 'index-database',
      status: transientLock ? 'unknown' : 'fail',
      summary: transientLock
        ? 'The index database is busy; its contents could not be checked safely'
        : `Cannot read the local index database: ${message}`,
      details: { path: databasePath, code }
    };
  } finally {
    db?.close();
  }
}

function inspectIndexStatus(
  root: string,
  statusPath = path.join(root, '.contextos', 'status.json')
): DoctorCheck {
  if (!fs.existsSync(statusPath)) {
    return {
      id: 'index-status',
      status: 'unknown',
      summary: 'No indexing status file is present',
      details: { path: statusPath }
    };
  }

  let status: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (!isRecord(parsed)) throw new Error('top-level value must be an object');
    status = parsed;
  } catch (error) {
    return {
      id: 'index-status',
      status: 'fail',
      summary: `The indexing status file is invalid: ${error instanceof Error ? error.message : String(error)}`,
      details: { path: statusPath }
    };
  }

  if (typeof status.error === 'string' && status.error.length > 0) {
    return {
      id: 'index-status',
      status: 'fail',
      summary: `The last index run reported an error: ${status.error.slice(0, 300)}`,
      details: { path: statusPath }
    };
  }

  if (status.fullIndexCompleted === true) {
    if (status.indexerVersion !== undefined && typeof status.indexerVersion !== 'number') {
      return {
        id: 'index-status',
        status: 'unknown',
        summary: 'The full index is marked complete, but its indexer version is not a number',
        details: { path: statusPath, storedIndexerVersion: status.indexerVersion }
      };
    }
    if (typeof status.indexerVersion === 'number' && status.indexerVersion !== INDEXER_VERSION) {
      return {
        id: 'index-status',
        status: 'warn',
        summary: `The index was completed by indexer version ${status.indexerVersion}; this CLI expects ${INDEXER_VERSION}`,
        details: {
          path: statusPath,
          indexedAt: typeof status.lastIndexTime === 'number' ? status.lastIndexTime : null,
          storedIndexerVersion: status.indexerVersion,
          currentIndexerVersion: INDEXER_VERSION
        }
      };
    }
    if (status.indexerVersion === undefined) {
      return {
        id: 'index-status',
        status: 'unknown',
        summary: 'The full index is marked complete, but its indexer version is unavailable',
        details: { path: statusPath, indexedAt: status.lastIndexTime ?? null }
      };
    }
    return {
      id: 'index-status',
      status: 'pass',
      summary: 'The full index is marked complete for the current indexer version',
      details: {
        path: statusPath,
        indexedAt: typeof status.lastIndexTime === 'number' ? status.lastIndexTime : null,
        indexerVersion: status.indexerVersion
      }
    };
  }

  if (status.fullIndexCompleted === false) {
    const processed = status.processed;
    const total = status.total;
    if (typeof processed === 'number' && typeof total === 'number' && total > 0) {
      return {
        id: 'index-status',
        status: 'warn',
        summary: `Indexing is incomplete (${processed} / ${total} files reported); this is not a completed-index failure`,
        details: {
          path: statusPath,
          processed,
          total,
          progressPercentage: status.progressPercentage ?? null
        }
      };
    }
    return {
      id: 'index-status',
      status: 'unknown',
      summary: 'The index is not marked complete, but progress counters are unavailable',
      details: {
        path: statusPath,
        processed: typeof processed === 'number' ? processed : null,
        total: typeof total === 'number' ? total : null
      }
    };
  }

  return {
    id: 'index-status',
    status: 'unknown',
    summary: 'The status file does not say whether a full index completed',
    details: { path: statusPath }
  };
}

function inspectDaemonPid(
  root: string,
  pidPath = path.join(root, '.contextos', 'daemon.pid')
): DaemonPidResult {
  if (!fs.existsSync(pidPath)) {
    return {
      check: {
        id: 'daemon-pid',
        status: 'unknown',
        summary: 'No daemon PID file is present; daemon process state is unavailable',
        details: { path: pidPath }
      },
      pid: null,
      processExists: false
    };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(pidPath, 'utf8').trim();
  } catch (error) {
    return {
      check: {
        id: 'daemon-pid',
        status: 'unknown',
        summary: `Cannot read the daemon PID file: ${error instanceof Error ? error.message : String(error)}`,
        details: { path: pidPath }
      },
      pid: null,
      processExists: false
    };
  }

  const pid = Number.parseInt(raw, 10);
  if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== raw) {
    return {
      check: {
        id: 'daemon-pid',
        status: 'fail',
        summary: 'The daemon PID file does not contain a valid positive process ID',
        details: { path: pidPath }
      },
      pid: null,
      processExists: false
    };
  }

  try {
    process.kill(pid, 0);
    return {
      check: {
        id: 'daemon-pid',
        status: 'pass',
        summary: `The daemon PID ${pid} refers to a live process`,
        details: { path: pidPath, pid }
      },
      pid,
      processExists: true
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      return {
        check: {
          id: 'daemon-pid',
          status: 'fail',
          summary: `The daemon PID file is stale; process ${pid} does not exist`,
          details: { path: pidPath, pid }
        },
        pid,
        processExists: false
      };
    }
    return {
      check: {
        id: 'daemon-pid',
        status: 'unknown',
        summary: `Cannot confirm whether daemon process ${pid} is accessible`,
        details: { path: pidPath, pid, code }
      },
      pid,
      processExists: code === 'EPERM'
    };
  }
}

function daemonSocketPath(root: string, homeDirectory: string): string {
  if (process.platform === 'win32') {
    return path.join('\\\\?\\pipe', `contextos-${Buffer.from(root).toString('hex')}`);
  }
  const hash = crypto.createHash('md5').update(root).digest('hex').slice(0, 12);
  return unixSocketPath(path.join(homeDirectory, '.contextos', 'run'), `d-${hash}.sock`, false);
}

function unpackRpcError(message: Record<string, unknown>): Error | null {
  if (!isRecord(message.error)) return null;
  return new Error(asString(message.error.message) ?? 'MCP request failed');
}

async function probeDaemon(
  socketPath: string,
  cliVersion: string,
  sharedRoot?: string
): Promise<DaemonProbeResult> {
  const socket = net.createConnection(socketPath);
  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }
  >();
  let buffer = '';

  const rejectPending = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        rejectPending(new Error('Daemon returned invalid MCP JSON'));
        continue;
      }
      if (!isRecord(message) || typeof message.id !== 'number') continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      const rpcError = unpackRpcError(message);
      if (rpcError) request.reject(rpcError);
      else request.resolve(message);
    }
  });
  socket.on('error', (error) => rejectPending(error));
  socket.on('end', () => rejectPending(new Error('Daemon closed the MCP connection')));

  const waitForConnection = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Daemon connection timed out')),
      MCP_PROBE_TIMEOUT_MS
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const request = (id: number, method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Daemon did not answer ${method} within ${MCP_PROBE_TIMEOUT_MS} ms`));
      }, MCP_PROBE_TIMEOUT_MS);
      pending.set(id, {
        resolve: (response) => {
          clearTimeout(timer);
          resolve(response);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });

  try {
    await waitForConnection;
    if (sharedRoot) socket.write(JSON.stringify({ action: 'doctor', cwd: sharedRoot }) + '\n');
    const initializeResponse = await request(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'contextos-doctor', version: cliVersion }
    });
    const initializeResult = isRecord(initializeResponse.result) ? initializeResponse.result : {};
    const serverInfo = isRecord(initializeResult.serverInfo)
      ? {
          name: asString(initializeResult.serverInfo.name),
          version: asString(initializeResult.serverInfo.version)
        }
      : null;
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const toolsResponse = await request(2, 'tools/list', {});
    const toolsResult = isRecord(toolsResponse.result) ? toolsResponse.result : {};
    const tools = Array.isArray(toolsResult.tools)
      ? toolsResult.tools
          .filter((tool): tool is Record<string, unknown> => isRecord(tool))
          .map((tool) => asString(tool.name))
          .filter((name): name is string => name !== undefined)
      : [];
    return { serverInfo, tools };
  } finally {
    socket.destroy();
  }
}

function inspectDaemonVersion(daemon: DaemonProbeResult | null, cliVersion: string): DoctorCheck {
  if (!daemon) {
    return {
      id: 'daemon-version',
      status: 'unknown',
      summary: 'The daemon version cannot be checked because no MCP response was available'
    };
  }
  const daemonVersion = daemon.serverInfo?.version;
  if (!daemonVersion || daemonVersion === 'unknown' || cliVersion === 'unknown') {
    return {
      id: 'daemon-version',
      status: 'unknown',
      summary: 'The daemon or CLI did not provide a comparable version',
      details: { daemonVersion: daemonVersion ?? null, cliVersion }
    };
  }
  const matches = daemonVersion === cliVersion;
  return {
    id: 'daemon-version',
    status: matches ? 'pass' : 'fail',
    summary: matches
      ? `The daemon and CLI are both version ${cliVersion}`
      : `The running daemon is version ${daemonVersion}, while this CLI is ${cliVersion}`,
    details: { daemonName: daemon.serverInfo?.name ?? null, daemonVersion, cliVersion }
  };
}

function inspectDaemonTools(daemon: DaemonProbeResult | null): DoctorCheck {
  if (!daemon) {
    return {
      id: 'daemon-tools',
      status: 'unknown',
      summary: 'The daemon tool list cannot be checked because no MCP response was available'
    };
  }
  const missing = EXPECTED_READ_HELPERS.filter((name) => !daemon.tools.includes(name));
  return {
    id: 'daemon-tools',
    status: missing.length > 0 ? 'warn' : 'pass',
    summary:
      missing.length > 0
        ? `The daemon does not advertise ${missing.join(', ')}, which the local stdio MCP server registers`
        : 'The daemon advertises the local code-reading helper tools',
    details: {
      advertisedCount: daemon.tools.length,
      advertisedTools: daemon.tools,
      expectedReadHelpers: EXPECTED_READ_HELPERS,
      sourceFiles: ['src/mcp/server.ts', 'src/core/daemon/daemon.ts']
    }
  };
}

export async function collectDoctorReport(
  options: {
    cwd?: string;
    homeDirectory?: string;
    client?: DiagnosticClient;
    noninteractive?: boolean;
  } = {}
): Promise<DoctorReport> {
  const root = canonicalDirectory(options.cwd ?? process.cwd());
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const cliVersion = getPackageVersion();
  const registered = registeredProjectPaths(root, homeDirectory);
  const checks = inspectMcpConfigs(root, cliVersion);
  checks.push(...inspectRegisteredScope(root, homeDirectory));
  checks.push(
    ...inspectAgentDiagnostics({
      root,
      projectRoot: registered?.rootPath,
      homeDirectory,
      client: options.client,
      noninteractive: options.noninteractive
    })
  );
  checks.push(inspectIndexDatabase(registered?.rootPath ?? root, registered?.dbPath));
  checks.push(
    inspectIndexStatus(
      root,
      registered ? path.join(path.dirname(registered.dbPath), 'status.json') : undefined
    )
  );

  const sharedDir = path.join(homeDirectory, '.contextos', 'runtime');
  const sharedPid = path.join(sharedDir, 'daemon.pid');
  const usingShared = fs.existsSync(sharedPid);
  const daemonPid = inspectDaemonPid(root, usingShared ? sharedPid : undefined);
  checks.push(daemonPid.check);

  let daemon: DaemonProbeResult | null = null;
  const socketPath = usingShared
    ? process.platform === 'win32'
      ? daemonSocketPath(sharedDir, homeDirectory)
      : unixSocketPath(sharedDir, 'daemon.sock', false)
    : daemonSocketPath(root, homeDirectory);
  if (fs.existsSync(socketPath)) {
    try {
      daemon = await probeDaemon(
        socketPath,
        cliVersion,
        usingShared ? (registered?.rootPath ?? root) : undefined
      );
      checks.push({
        id: 'daemon-mcp',
        status: 'pass',
        summary: `The daemon answered MCP initialize and tools/list requests (${daemon.tools.length} tools advertised)`,
        details: { socketPath, serverInfo: daemon.serverInfo }
      });
    } catch (error) {
      checks.push({
        id: 'daemon-mcp',
        status: daemonPid.processExists ? 'fail' : 'unknown',
        summary: `The daemon socket did not provide an MCP response: ${error instanceof Error ? error.message : String(error)}`,
        details: { socketPath, pid: daemonPid.pid }
      });
    }
  } else {
    checks.push({
      id: 'daemon-mcp',
      status: daemonPid.processExists ? 'fail' : 'unknown',
      summary: daemonPid.processExists
        ? 'A live daemon PID is recorded, but its MCP socket is missing'
        : 'No daemon MCP socket is present',
      details: { socketPath, pid: daemonPid.pid }
    });
  }

  checks.push(inspectDaemonVersion(daemon, cliVersion));
  checks.push(inspectDaemonTools(daemon));

  const summary: Record<DoctorStatus, number> = {
    pass: 0,
    warn: 0,
    fail: 0,
    unknown: 0
  };
  for (const check of checks) summary[check.status]++;

  return {
    root,
    cliVersion,
    checks,
    summary,
    exitCode: summary.fail > 0 ? 1 : 0
  };
}

function renderHumanReport(report: DoctorReport): string {
  const labels: Record<DoctorStatus, string> = {
    pass: chalk.green('PASS'),
    warn: chalk.yellow('WARN'),
    fail: chalk.red('FAIL'),
    unknown: chalk.gray('UNKNOWN')
  };
  const lines = [
    chalk.bold(`ContextOS doctor — ${report.root}`),
    `CLI version: ${report.cliVersion}`,
    ''
  ];
  for (const check of report.checks) {
    lines.push(`${labels[check.status]}  ${check.summary}`);
    if (check.id === 'agent-instructions' && Array.isArray(check.details?.files)) {
      for (const file of check.details.files as Array<{
        path: string;
        exists: boolean;
        importedBy?: string;
        containsContextOS?: boolean;
        unreadable?: boolean;
      }>) {
        if (!file.exists && !file.importedBy) continue;
        const state = !file.exists
          ? 'missing import'
          : file.unreadable
            ? 'unreadable'
            : file.containsContextOS
              ? 'ContextOS guidance'
              : 'no ContextOS guidance';
        lines.push(
          `  ${file.path} (${state}${file.importedBy ? `; imported by ${file.importedBy}` : ''})`
        );
      }
    }
    if (check.id === 'agent-mcp-registration' && Array.isArray(check.details?.registrations)) {
      for (const registration of check.details.registrations as Array<{
        path: string;
        serverName: string;
        enabled: boolean;
      }>)
        lines.push(
          `  ${registration.path} (${registration.serverName}; ${registration.enabled ? 'enabled' : 'disabled'})`
        );
    }
  }
  lines.push(
    '',
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warning(s), ${report.summary.fail} failure(s), ${report.summary.unknown} unknown`
  );
  return lines.join('\n');
}

export const doctorCommand = new Command('doctor')
  .description('Diagnose ContextOS configuration, daemon, and index state without changing files')
  .option('--json', 'Output diagnostics as JSON')
  .addOption(
    new Option(
      '--client <client>',
      'Inspect instruction discovery, MCP registration, and configured tool permissions for one client'
    ).choices([...DIAGNOSTIC_CLIENTS])
  )
  .option('--noninteractive', 'Diagnose approval requirements for a run that cannot answer prompts')
  .action(
    async (options: { json?: boolean; client?: DiagnosticClient; noninteractive?: boolean }) => {
      const report = await collectDoctorReport({
        client: options.client,
        noninteractive: options.noninteractive
      });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else console.log(renderHumanReport(report));
      if (report.exitCode !== 0) process.exitCode = report.exitCode;
    }
  );
