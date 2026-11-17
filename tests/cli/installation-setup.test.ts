import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existingProjectRoots,
  stopInstallationDaemon,
  upgradeExistingProjects,
  verifiedDaemonProcess,
  type InstallationDaemonAdapters
} from '../../src/cli/utils/installation-setup.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { createUpgradeLock } from '../../src/core/updater/upgrade-lock.js';
import { applyMigrations } from '../../src/core/storage/schema.js';
import { getPackageVersion } from '../../src/utils/version.js';

describe('automatic existing-project setup', () => {
  let temporary: string;
  let home: string;
  let project: string;
  let child: ChildProcess | undefined;
  beforeEach(() => {
    temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-install-')));
    home = path.join(temporary, 'home');
    project = path.join(temporary, 'project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CONTEXTOS_SKIP_SETUP', '0');
    for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'COPILOT_HOME'])
      vi.stubEnv(name, '');
  });
  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => child!.once('exit', () => resolve()));
    }
    child = undefined;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  function legacy() {
    const file = path.join(project, '.contextos', 'index.db');
    fs.mkdirSync(path.dirname(file));
    const db = new Database(file);
    applyMigrations(db);
    db.prepare(
      "INSERT INTO knowledge_facts (id,fact,created_at,updated_at,last_accessed) VALUES ('memory','Keep this verified memory',1,1,1)"
    ).run();
    db.close();
    return file;
  }
  it('does not initialize a fresh project or create user state', async () => {
    const log = vi.fn();
    expect(await upgradeExistingProjects({ cwd: project, log })).toEqual({
      updated: [],
      unavailable: [],
      errors: []
    });
    expect(fs.readdirSync(project)).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });
  it('migrates on first use, retains legacy memories and user text, then does nothing on repeat', async () => {
    const original = legacy();
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'My project rules\n');
    const log = vi.fn();
    const result = await upgradeExistingProjects({ cwd: project, log });
    expect(result.errors).toEqual([]);
    expect(result.updated).toEqual([project]);
    expect(fs.existsSync(original)).toBe(true);
    expect(fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8')).toContain(
      'My project rules\n\n@AGENTS.md'
    );
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain('ctx_trace');
    const registry = new WorkspaceRegistry();
    const source = registry.resolve(project);
    registry.close();
    const migrated = new Database(source.dbPath, { readonly: true });
    expect(migrated.prepare('SELECT fact FROM knowledge_facts').get()).toEqual({
      fact: 'Keep this verified memory'
    });
    migrated.close();
    log.mockClear();
    expect((await upgradeExistingProjects({ cwd: project, log })).updated).toEqual([]);
    expect(log).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(home, '.contextos', 'upgrade.lock'))).toBe(false);
  });
  it('preserves memberships and explicit MCP configuration when refreshing known projects', async () => {
    const registry = new WorkspaceRegistry();
    registry.ensureGroup('payments');
    registry.register(project, { workspace: 'payments' });
    registry.close();
    const config = {
      mcpServers: {
        contextos: { command: 'custom-contextos', args: ['serve', '--group', 'payments'] },
        other: { command: 'other' }
      }
    };
    fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify(config));
    expect((await upgradeExistingProjects({ log: vi.fn() })).errors).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8'))).toEqual(config);
    const after = new WorkspaceRegistry();
    expect(after.list('default')).toEqual([]);
    expect(after.list('payments')).toHaveLength(1);
    after.close();
  });
  it('retries a failed checkout without blocking another project or marking failure as complete', async () => {
    const second = path.join(temporary, 'second');
    fs.mkdirSync(second);
    const registry = new WorkspaceRegistry();
    registry.register(project);
    registry.register(second);
    registry.close();
    fs.writeFileSync(path.join(project, '.mcp.json'), '{invalid');
    const result = await upgradeExistingProjects({ log: vi.fn() });
    expect(result.errors.map((item) => item.root)).toEqual([project]);
    expect(result.updated).toEqual([second]);
    fs.writeFileSync(path.join(project, '.mcp.json'), '{}');
    expect((await upgradeExistingProjects({ log: vi.fn() })).updated).toEqual([project]);
  });
  it('does not resurrect purged registrations through the legacy registry tables', () => {
    const registry = new WorkspaceRegistry();
    registry.close();
    const db = new Database(path.join(home, '.contextos', 'registry.db'));
    db.exec('CREATE TABLE legacy_repositories (root_path TEXT)');
    db.prepare("INSERT INTO registry_metadata VALUES ('groups_migrated','1')").run();
    db.prepare('INSERT INTO legacy_repositories VALUES (?)').run(project);
    db.close();
    expect(existingProjectRoots()).toEqual([]);
  });
  it('does not re-import legacy workspace backups after their one-time import', () => {
    const registry = new WorkspaceRegistry();
    registry.close();
    const db = new Database(path.join(home, '.contextos', 'registry.db'));
    db.prepare("INSERT INTO registry_metadata VALUES ('legacy_imported','1')").run();
    db.close();
    fs.writeFileSync(
      path.join(home, '.contextos', 'workspaces.json'),
      JSON.stringify({ old: { repos: [project] } })
    );
    expect(existingProjectRoots()).toEqual([]);
  });
  it('honors the staging opt-out even for existing legacy data', async () => {
    legacy();
    vi.stubEnv('CONTEXTOS_SKIP_SETUP', '1');
    expect((await upgradeExistingProjects({ cwd: project })).updated).toEqual([]);
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
  });
  it('runs migration from a global postinstall and leaves local installs untouched', () => {
    legacy();
    const script = path.resolve('scripts/postinstall.mjs');
    const env = {
      ...process.env,
      HOME: home,
      INIT_CWD: project,
      CONTEXTOS_SUPPRESS_INSTALL_NOTICE: '1',
      CONTEXTOS_GLOBAL_INSTRUCTIONS: '0'
    };
    const local = spawnSync(process.execPath, [script], {
      env: { ...env, npm_config_global: 'false' },
      encoding: 'utf8'
    });
    expect(local.status, local.stderr).toBe(0);
    expect(fs.existsSync(path.join(home, '.contextos'))).toBe(false);
    const global = spawnSync(process.execPath, [script], {
      env: { ...env, npm_config_global: 'true' },
      encoding: 'utf8',
      timeout: 15000
    });
    expect(global.status, global.stderr).toBe(0);
    expect(global.stdout).toBe('');
    expect(fs.existsSync(path.join(home, '.contextos', 'installation-setup.json'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(project, '.contextos', 'index.db'))).toBe(true);
  });
  it('suppresses both install-time hooks when both controls are set', () => {
    legacy();
    const instruction = path.join(home, '.codex', 'AGENTS.md');
    fs.mkdirSync(path.dirname(instruction));
    fs.writeFileSync(instruction, 'Keep my instructions\r\n');
    const result = spawnSync(process.execPath, [path.resolve('scripts/postinstall.mjs')], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        INIT_CWD: project,
        npm_config_global: 'true',
        CONTEXTOS_GLOBAL_INSTRUCTIONS: '0',
        CONTEXTOS_SKIP_SETUP: '1',
        CONTEXTOS_SUPPRESS_INSTALL_NOTICE: '1'
      },
      encoding: 'utf8',
      timeout: 15000
    });
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(instruction, 'utf8')).toBe('Keep my instructions\r\n');
    expect(fs.existsSync(path.join(home, '.contextos'))).toBe(false);
    expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.contextos', 'index.db'))).toBe(true);
  });
  it('migrates from CLI first use and keeps machine-readable output clean', () => {
    legacy();
    fs.writeFileSync(
      path.join(project, 'payment.ts'),
      'export type PaymentStatus = "pending" | "paid";\n'
    );
    const result = spawnSync(
      process.execPath,
      [path.resolve('dist/bin/contextos.js'), 'query', 'PaymentStatus', '--json'],
      {
        cwd: project,
        env: { ...process.env, HOME: home, CONTEXTOS_EMBEDDINGS: '0' },
        encoding: 'utf8',
        timeout: 60_000
      }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).context).toContain('PaymentStatus');
    expect(result.stderr).toContain('Updated 1 project checkout');
    expect(result.stderr).toContain('[BackgroundIndexer]');
    expect(fs.existsSync(path.join(project, 'AGENTS.md'))).toBe(true);
  }, 65_000);
  function daemon() {
    const file = path.join(home, 'daemon.pid');
    fs.writeFileSync(file, '44512');
    const adapters: InstallationDaemonAdapters = {
      alive: vi.fn().mockReturnValue(true),
      verified: vi.fn().mockReturnValue(true),
      request: vi.fn().mockResolvedValue({ ok: true, version: '1.1.0' }),
      terminate: vi.fn(),
      wait: vi.fn().mockResolvedValue(true)
    };
    return { file, adapters };
  }
  it('drains a verified older daemon and waits for exit before migration', async () => {
    const { file, adapters } = daemon();
    await stopInstallationDaemon(project, file, 'token', true, adapters);
    expect(adapters.request).toHaveBeenNthCalledWith(
      2,
      project,
      'prepare-upgrade',
      'token',
      '1.1.0',
      120_000
    );
    expect(adapters.wait).toHaveBeenCalledWith(44512);
    expect(adapters.terminate).not.toHaveBeenCalled();
  });
  it('uses graceful SIGTERM for a verified older daemon with active MCP clients', async () => {
    const { file, adapters } = daemon();
    vi.mocked(adapters.request)
      .mockResolvedValueOnce({ ok: true, version: '1.1.0' })
      .mockResolvedValueOnce({
        ok: false,
        error: 'daemon has active MCP connections; close ContextOS clients'
      });
    await stopInstallationDaemon(project, file, 'token', true, adapters);
    expect(adapters.verified).toHaveBeenCalledTimes(2);
    expect(adapters.terminate).toHaveBeenCalledWith(44512);
    expect(adapters.wait).toHaveBeenCalledWith(44512);
  });
  it('restarts an owner reporting the replaced manifest version during a new setup revision', async () => {
    const { file, adapters } = daemon();
    const version = getPackageVersion();
    vi.mocked(adapters.request).mockResolvedValue({ ok: true, version });
    await stopInstallationDaemon(project, file, 'token', true, adapters);
    expect(adapters.request).toHaveBeenNthCalledWith(
      2,
      project,
      'prepare-upgrade',
      'token',
      version,
      120_000
    );
    expect(adapters.wait).toHaveBeenCalledWith(44512);
  });
  it('retains a current owner after the setup revision has completed', async () => {
    const { file, adapters } = daemon();
    vi.mocked(adapters.request).mockResolvedValue({ ok: true, version: getPackageVersion() });
    await stopInstallationDaemon(project, file, 'token', false, adapters);
    expect(adapters.request).toHaveBeenCalledTimes(1);
    expect(adapters.wait).not.toHaveBeenCalled();
  });
  it('never signals an unverified, reused or unresponsive PID', async () => {
    const { file, adapters } = daemon();
    vi.mocked(adapters.verified).mockReturnValue(false);
    await expect(stopInstallationDaemon(project, file, 'token', true, adapters)).rejects.toThrow(
      'Cannot verify'
    );
    expect(adapters.request).not.toHaveBeenCalled();
    vi.mocked(adapters.verified).mockReturnValue(true);
    vi.mocked(adapters.request).mockResolvedValue({ ok: false, error: 'timeout' });
    await expect(stopInstallationDaemon(project, file, 'token', true, adapters)).rejects.toThrow(
      'Cannot verify'
    );
    expect(adapters.terminate).not.toHaveBeenCalled();
    expect(verifiedDaemonProcess(process.pid)).toBe(false);
  });
  it('leaves a daemon that is still draining intact and never forces termination', async () => {
    const { file, adapters } = daemon();
    vi.mocked(adapters.wait).mockResolvedValue(false);
    await expect(stopInstallationDaemon(project, file, 'token', true, adapters)).rejects.toThrow(
      'still draining'
    );
    expect(fs.existsSync(file)).toBe(true);
    expect(adapters.terminate).not.toHaveBeenCalled();
  });
  it.skipIf(process.platform === 'win32')(
    'verifies and stops a real ContextOS daemon through its control socket',
    async () => {
      const registry = new WorkspaceRegistry();
      registry.close();
      let output = '';
      child = spawn(process.execPath, [path.resolve('dist/bin/contextos.js'), 'daemon', 'start'], {
        cwd: project,
        env: { ...process.env, HOME: home, CONTEXTOS_SKIP_SETUP: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      child.stdout?.on('data', (chunk) => {
        output += chunk;
      });
      child.stderr?.on('data', (chunk) => {
        output += chunk;
      });
      const file = path.join(home, '.contextos', 'runtime', 'daemon.pid');
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(file) && Date.now() < deadline && child.exitCode === null)
        await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fs.existsSync(file), output).toBe(true);
      expect(verifiedDaemonProcess(child.pid!)).toBe(true);
      // Exercise macOS ps inspection from the source layout against a compiled CLI.
      expect(verifiedDaemonProcess(child.pid!, 'darwin')).toBe(true);
      const lock = createUpgradeLock();
      try {
        await stopInstallationDaemon(path.dirname(file), file, lock.token, true);
        expect(fs.existsSync(file)).toBe(false);
      } finally {
        lock.release();
      }
    },
    20_000
  );
});
