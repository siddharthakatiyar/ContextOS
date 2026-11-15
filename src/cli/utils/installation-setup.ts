import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
import { discoverProject } from '../../core/workspace/discovery.js';
import { getPackageVersion } from '../../utils/version.js';
import { assertNoSymlinkInPath, writePrivateStateFile } from '../../utils/secure-state.js';
import {
  createUpgradeLock,
  getActiveUpgradeToken,
  waitForUpgradeToFinish
} from '../../core/updater/upgrade-lock.js';
import { requestDaemon } from '../commands/upgrade.js';
import { refreshProjectSetup } from '../commands/init.js';

const SETUP_REVISION = '1';
const STOP_TIMEOUT_MS = 120_000;

interface SetupState {
  revision: string;
  roots: string[];
}
export interface InstallationSetupResult {
  updated: string[];
  unavailable: string[];
  errors: { root: string; error: string }[];
}
export interface InstallationSetupOptions {
  cwd?: string;
  index?: boolean;
  log?: (message: string) => void;
}

/** Discover only prior registrations and legacy state; never crawl the user's home. */
export function existingProjectRoots(cwd?: string, home = os.homedir()): string[] {
  const roots = new Set<string>();
  const state = path.join(home, '.contextos');
  const registry = path.join(state, 'registry.db');
  let importLegacy = true;
  if (fs.existsSync(registry)) {
    assertNoSymlinkInPath(registry);
    const db = new Database(registry, { readonly: true });
    try {
      const hasMetadata = db
        .prepare("SELECT 1 FROM sqlite_master WHERE name='registry_metadata' AND type='table'")
        .get();
      if (hasMetadata)
        importLegacy = !db
          .prepare("SELECT 1 FROM registry_metadata WHERE key='legacy_imported' AND value='1'")
          .get();
      const migrated =
        hasMetadata &&
        db
          .prepare("SELECT 1 FROM registry_metadata WHERE key='groups_migrated' AND value='1'")
          .get();
      for (const table of migrated ? ['repositories'] : ['repositories', 'legacy_repositories']) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'").get(table))
          continue;
        const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
        const active = columns.some((column) => column.name === 'active');
        const filter = active
          ? ' WHERE active=1 AND worktree_id IN (SELECT id FROM worktrees WHERE removed=0)'
          : '';
        for (const row of db.prepare(`SELECT root_path FROM ${table}${filter}`).all() as {
          root_path: string;
        }[])
          roots.add(row.root_path);
      }
    } finally {
      db.close();
    }
  }
  const legacy = path.join(state, 'workspaces.json');
  if (importLegacy && fs.existsSync(legacy)) {
    assertNoSymlinkInPath(legacy);
    const workspaces = JSON.parse(fs.readFileSync(legacy, 'utf8')) as Record<
      string,
      { repos?: string[] }
    >;
    for (const workspace of Object.values(workspaces))
      for (const root of workspace.repos ?? []) roots.add(root);
  }
  if (cwd) {
    try {
      const canonical = fs.realpathSync(cwd);
      const discovery = discoverProject(canonical);
      const root =
        discovery.worktrees
          .filter(
            (tree) => canonical === tree.rootPath || canonical.startsWith(tree.rootPath + path.sep)
          )
          .sort((a, b) => b.rootPath.length - a.rootPath.length)[0]?.rootPath ?? canonical;
      if (fs.existsSync(path.join(root, '.contextos', 'index.db'))) {
        roots.add(root);
      }
    } catch {
      // Missing paths are retained when registered, but never guessed from parents.
    }
  }
  return [
    ...new Set(
      [...roots].map((root) => {
        try {
          return fs.realpathSync(root);
        } catch {
          return path.resolve(root);
        }
      })
    )
  ];
}

function readState(file: string, revision: string): Set<string> {
  try {
    assertNoSymlinkInPath(file);
    const state = JSON.parse(fs.readFileSync(file, 'utf8')) as SetupState;
    return new Set(state.revision === revision ? state.roots : []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError)
      return new Set();
    throw error;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** A PID file alone never authorizes signalling a process (PIDs can be reused). */
export function verifiedDaemonProcess(pid: number, platform = process.platform): boolean {
  try {
    if (pid === process.pid || pid <= 0 || !Number.isSafeInteger(pid)) return false;
    if (platform === 'linux') {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) return false;
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!args.some((arg, i) => arg === 'daemon' && args[i + 1] === 'start')) return false;
      return args.some((arg) => {
        if (!path.isAbsolute(arg) || !/[/\\]bin[/\\]contextos(?:\.js)?$/.test(arg)) return false;
        let root = path.dirname(arg);
        for (let i = 0; i < 4; i++, root = path.dirname(root)) {
          try {
            if (
              JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name ===
              '@siddharthakatiyar/contextos'
            )
              return true;
          } catch {
            /* The script may be in dist/bin. */
          }
        }
        return false;
      });
    }
    if (platform === 'darwin') {
      const uid = execFileSync('ps', ['-p', String(pid), '-o', 'uid='], {
        encoding: 'utf8',
        timeout: 2000
      }).trim();
      if (Number(uid) !== process.getuid?.()) return false;
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 2000
      }).trim();
      const scripts = [
        path.resolve(import.meta.dirname, '../../../bin/contextos.js'),
        path.resolve(import.meta.dirname, '../../../dist/bin/contextos.js')
      ];
      return (
        scripts.some((script) => command.includes(' ' + script + ' daemon start')) &&
        /(?:^|\/)node(?:\s|$)/.test(command)
      );
    }
    return false;
  } catch {
    return false;
  }
}

export interface InstallationDaemonAdapters {
  alive(pid: number): boolean;
  verified(pid: number): boolean;
  request: typeof requestDaemon;
  terminate(pid: number): void;
  wait(pid: number): Promise<boolean>;
}
const daemonAdapters: InstallationDaemonAdapters = {
  alive,
  verified: verifiedDaemonProcess,
  request: requestDaemon,
  terminate: (pid) => process.kill(pid, 'SIGTERM'),
  async wait(pid) {
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    while (alive(pid) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 100));
    return !alive(pid);
  }
};

/** Gracefully drain old daemons; verify both their control protocol and process identity. */
export async function stopInstallationDaemon(
  projectDir: string,
  pidFile: string,
  token: string,
  restartCurrentVersion: boolean,
  adapters = daemonAdapters
): Promise<void> {
  assertNoSymlinkInPath(pidFile);
  if (!fs.existsSync(pidFile)) return;
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid daemon PID: ${pidFile}`);
  if (!adapters.alive(pid)) return;
  if (!adapters.verified(pid))
    throw new Error(`Cannot verify ContextOS daemon PID ${pid}; stop it manually before retrying.`);
  const version = await adapters.request(projectDir, 'get-version', token, undefined, 3000);
  if (!version.ok || !version.version)
    throw new Error(
      `Cannot verify daemon control for PID ${pid}; stop it manually before retrying.`
    );
  if (!restartCurrentVersion && version.version === getPackageVersion()) return;
  const response = await adapters.request(
    projectDir,
    'prepare-upgrade',
    token,
    version.version,
    STOP_TIMEOUT_MS
  );
  // Older daemons refuse control shutdown with attached MCP clients. Their normal
  // SIGTERM handler drains indexing too; only use it after verifying ownership.
  if (!response.ok) {
    if (!/active MCP|MCP connections|MCP clients/i.test(response.error ?? ''))
      throw new Error(`Daemon ${pid} could not drain: ${response.error ?? 'unknown error'}`);
    if (Number(fs.readFileSync(pidFile, 'utf8').trim()) !== pid || !adapters.verified(pid))
      throw new Error(`Daemon identity changed for PID ${pid}; retry setup.`);
    adapters.terminate(pid);
  } else if (response.version !== version.version) {
    throw new Error(`Daemon ${pid} changed versions while preparing setup; retry.`);
  }
  if (!(await adapters.wait(pid)))
    throw new Error(
      `Daemon ${pid} is still draining; retry after indexing finishes. No forced termination was attempted.`
    );
}

/** Run after a global install, or once on first use of a legacy project. */
export async function upgradeExistingProjects(
  options: InstallationSetupOptions = {}
): Promise<InstallationSetupResult> {
  const result: InstallationSetupResult = { updated: [], unavailable: [], errors: [] };
  if (process.env.CONTEXTOS_SKIP_SETUP === '1') return result;
  const log =
    options.log ?? ((message: string) => process.stderr.write(`[ContextOS] ${message}\n`));
  const home = os.homedir();
  const stateHome = path.join(home, '.contextos');
  const stateFile = path.join(stateHome, 'installation-setup.json');
  const revision = `${getPackageVersion()}:${SETUP_REVISION}`;
  const roots = existingProjectRoots(options.cwd, home);
  if (!roots.length) return result;
  let completed = readState(stateFile, revision);
  const pending = roots.filter((root) => !completed.has(root));
  if (!pending.length) return result;
  await waitForUpgradeToFinish();
  const inherited = getActiveUpgradeToken();
  const lock =
    inherited && process.env.CONTEXTOS_UPGRADE_TOKEN === inherited
      ? undefined
      : createUpgradeLock();
  const token = lock?.token ?? inherited!;
  try {
    // Another installer may have completed setup while this process waited.
    completed = readState(stateFile, revision);
    const remaining = roots.filter((root) => !completed.has(root));
    if (!remaining.length) return result;
    log('Updating existing projects; legacy indexes and user-written instructions are retained.');
    await stopInstallationDaemon(
      path.join(stateHome, 'runtime'),
      path.join(stateHome, 'runtime', 'daemon.pid'),
      token,
      // Older owners read their version from disk after npm replaces the package.
      // Before any checkout completes this setup revision, restart that verified
      // owner even when it now reports the newly installed manifest's version.
      completed.size === 0
    );
    for (const root of roots)
      await stopInstallationDaemon(root, path.join(root, '.contextos', 'daemon.pid'), token, true);
    const registry = new WorkspaceRegistry();
    const runtime = new WorkspaceRuntime(registry);
    try {
      for (const root of remaining) {
        if (completed.has(root)) continue;
        if (!fs.existsSync(root)) {
          result.unavailable.push(root);
          continue;
        }
        try {
          let source = registry.active(root);
          if (!source) source = registry.register(root);
          else registry.reconcile();
          const views = registry
            .listAll()
            .filter((view) => view.projectId === source.projectId && view.active);
          const refreshed: string[] = [];
          for (const view of views) {
            if (!fs.existsSync(view.rootPath)) continue;
            // Keep memberships and existing explicit MCP commands unchanged.
            for (const warning of refreshProjectSetup(view.rootPath))
              log(`${view.rootPath}: ${warning}`);
            if (options.index) await runtime.get(view).index(false, log);
            refreshed.push(view.rootPath);
          }
          for (const root of refreshed) completed.add(root);
          completed.add(root);
          result.updated.push(root);
          writePrivateStateFile(stateFile, JSON.stringify({ revision, roots: [...completed] }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push({ root, error: message });
          log(`${root}: setup will retry on next use: ${message}`);
        }
      }
    } finally {
      await runtime.close();
      registry.close();
    }
    if (result.updated.length)
      log(
        `Updated ${result.updated.length} project checkout(s). ${options.index ? 'Indexing is complete.' : 'Indexes rebuild automatically on next use.'} Reconnect your coding agent to load refreshed tools.`
      );
    return result;
  } finally {
    lock?.release();
  }
}
