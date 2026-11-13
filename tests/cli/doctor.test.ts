import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectDoctorReport } from '../../src/cli/commands/doctor.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceDaemon } from '../../src/core/workspace/daemon.js';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-doctor-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('contextos doctor', () => {
  it('inspects the registered global view without creating project-local state', async () => {
    const root = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    vi.spyOn(os, 'homedir').mockReturnValue(homeDirectory);
    const registry = new WorkspaceRegistry();
    const source = registry.register(root);
    registry.close();
    const report = await collectDoctorReport({ cwd: root, homeDirectory });
    const check = report.checks.find((item) => item.id === 'index-database');
    expect(check?.status).toBe('pass');
    expect(check?.details?.path).toBe(source.dbPath);
    expect(fs.existsSync(path.join(root, '.contextos'))).toBe(false);
  });

  it('probes the shared daemon using the registered project handshake', async () => {
    const root = temporaryDirectory();
    const homeDirectory = temporaryDirectory();
    vi.spyOn(os, 'homedir').mockReturnValue(homeDirectory);
    vi.stubEnv('CONTEXTOS_EMBEDDINGS', '0');
    const registry = new WorkspaceRegistry();
    registry.register(root);
    registry.close();
    const daemon = new WorkspaceDaemon('default');
    try {
      await daemon.start();
      const report = await collectDoctorReport({ cwd: root, homeDirectory });
      expect(report.checks.find((item) => item.id === 'daemon-mcp')?.status).toBe('pass');
    } finally {
      await daemon.stop();
      vi.unstubAllEnvs();
    }
  });
  it('reports missing state as unknown without creating files or directories', async () => {
    const root = temporaryDirectory();
    const homeDirectory = path.join(root, 'home');

    const report = await collectDoctorReport({ cwd: root, homeDirectory });

    expect(report.exitCode).toBe(0);
    expect(report.checks.find((check) => check.id === 'index-database')?.status).toBe('unknown');
    expect(report.checks.find((check) => check.id === 'index-status')?.status).toBe('unknown');
    expect(report.checks.find((check) => check.id === 'daemon-pid')?.status).toBe('unknown');
    expect(report.checks.find((check) => check.id === 'daemon-mcp')?.status).toBe('unknown');
    expect(fs.existsSync(path.join(root, '.contextos'))).toBe(false);
    expect(fs.existsSync(path.join(root, '.mcp.json'))).toBe(false);
    expect(fs.existsSync(path.join(homeDirectory, '.contextos'))).toBe(false);
  });

  it('flags an MCP root mismatch and reports the configured package version without running it', async () => {
    const root = temporaryDirectory();
    const otherRoot = path.join(root, 'other-repository');
    fs.mkdirSync(otherRoot);
    const localScript = path.join(process.cwd(), 'src', 'cli', 'commands', 'doctor.ts');
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          contextos: {
            command: process.execPath,
            args: [localScript, 'serve'],
            env: { CONTEXTOS_REPO_ROOT: otherRoot }
          }
        }
      })
    );

    const report = await collectDoctorReport({ cwd: root, homeDirectory: path.join(root, 'home') });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((check) => check.id === 'mcp-root:.mcp.json')?.status).toBe('fail');
    expect(report.checks.find((check) => check.id === 'mcp-version:.mcp.json')?.status).toBe(
      'pass'
    );
    expect(fs.existsSync(path.join(root, '.contextos'))).toBe(false);
  });

  it('fails a missing configured script instead of inheriting a parent package version', async () => {
    const root = temporaryDirectory();
    const missingScript = path.join(process.cwd(), 'dist', 'bin', 'missing-contextos.js');
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          contextos: {
            command: process.execPath,
            args: [missingScript, 'serve'],
            env: { CONTEXTOS_REPO_ROOT: root }
          }
        }
      })
    );

    const report = await collectDoctorReport({ cwd: root, homeDirectory: path.join(root, 'home') });

    const versionCheck = report.checks.find((check) => check.id === 'mcp-version:.mcp.json');
    expect(versionCheck?.status).toBe('fail');
    expect(versionCheck?.summary).toContain('configured ContextOS script does not exist');
    expect(report.exitCode).toBe(1);
  });

  it('inspects ContextOS Codex servers under different names and ignores unrelated MCP servers', async () => {
    const root = temporaryDirectory();
    const localScript = path.join(process.cwd(), 'src', 'cli', 'commands', 'doctor.ts');
    const serverArgs = JSON.stringify([localScript, 'serve']);
    const serverCommand = JSON.stringify(process.execPath);
    const codexDirectory = path.join(root, '.codex');
    fs.mkdirSync(codexDirectory);
    fs.writeFileSync(
      path.join(codexDirectory, 'config.toml'),
      `[mcp_servers.contextos-local]\n` +
        `command = ${serverCommand}\n` +
        `args = ${serverArgs}\n\n` +
        `[mcp_servers.contextos-local.env]\n` +
        `CONTEXTOS_REPO_ROOT = ${JSON.stringify(root)}\n\n` +
        `[mcp_servers.project-context]\n` +
        `command = ${serverCommand}\n` +
        `args = ${serverArgs}\n\n` +
        `[mcp_servers.project-context.env]\n` +
        `CONTEXTOS_REPO_ROOT = ${JSON.stringify(root)}\n\n` +
        `[mcp_servers.notes]\n` +
        `command = "node"\n` +
        `args = ["/tmp/notes-server.js"]\n\n` +
        `[mcp_servers.notes.env]\n` +
        `NOTES_REGION = "test"\n`
    );

    const report = await collectDoctorReport({ cwd: root, homeDirectory: path.join(root, 'home') });

    expect(
      report.checks.find((check) => check.id === 'mcp-root:.codex/config.toml:contextos-local')
        ?.status
    ).toBe('pass');
    expect(
      report.checks.find((check) => check.id === 'mcp-version:.codex/config.toml:contextos-local')
        ?.status
    ).toBe('pass');
    expect(
      report.checks.find((check) => check.id === 'mcp-root:.codex/config.toml:project-context')
        ?.status
    ).toBe('pass');
    expect(
      report.checks.find((check) => check.id === 'mcp-version:.codex/config.toml:project-context')
        ?.status
    ).toBe('pass');
    expect(report.checks.some((check) => check.id.includes(':notes'))).toBe(false);
    expect(report.exitCode).toBe(0);
  });

  it('does not call an incomplete index a failure when progress counters are absent', async () => {
    const root = temporaryDirectory();
    const stateDirectory = path.join(root, '.contextos');
    fs.mkdirSync(stateDirectory);
    fs.writeFileSync(
      path.join(stateDirectory, 'status.json'),
      JSON.stringify({ fullIndexCompleted: false, processed: 0 })
    );

    const report = await collectDoctorReport({ cwd: root, homeDirectory: path.join(root, 'home') });

    const status = report.checks.find((check) => check.id === 'index-status');
    expect(status?.status).toBe('unknown');
    expect(status?.summary).toContain('progress counters are unavailable');
    expect(report.exitCode).toBe(0);
    expect(fs.existsSync(path.join(stateDirectory, 'daemon.pid'))).toBe(false);
  });

  it('opens an existing index read-only and leaves its bytes and directory entries unchanged', async () => {
    const root = temporaryDirectory();
    const stateDirectory = path.join(root, '.contextos');
    fs.mkdirSync(stateDirectory);
    const databasePath = path.join(stateDirectory, 'index.db');
    const writableDb = new Database(databasePath);
    writableDb.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      CREATE TABLE files (path TEXT PRIMARY KEY, layer TEXT NOT NULL, last_indexed INTEGER NOT NULL);
      CREATE TABLE chunks (id TEXT PRIMARY KEY, layer TEXT NOT NULL);
      CREATE TABLE relationships (id INTEGER PRIMARY KEY, layer TEXT NOT NULL);
    `);
    writableDb.close();
    const before = fs.readFileSync(databasePath);
    const entriesBefore = fs.readdirSync(stateDirectory).sort();

    const report = await collectDoctorReport({ cwd: root, homeDirectory: path.join(root, 'home') });

    expect(report.checks.find((check) => check.id === 'index-database')?.status).toBe('pass');
    expect(fs.readFileSync(databasePath).equals(before)).toBe(true);
    expect(fs.readdirSync(stateDirectory).sort()).toEqual(entriesBefore);
    expect(fs.existsSync(path.join(stateDirectory, 'status.json'))).toBe(false);
    expect(fs.existsSync(path.join(stateDirectory, 'daemon.pid'))).toBe(false);
  });

  it('marks malformed status state as a confirmed failure without repairing it', async () => {
    const root = temporaryDirectory();
    const stateDirectory = path.join(root, '.contextos');
    fs.mkdirSync(stateDirectory);
    const statusPath = path.join(stateDirectory, 'status.json');
    const original = '{broken\n';
    fs.writeFileSync(statusPath, original);

    const report = await collectDoctorReport({ cwd: root, homeDirectory: path.join(root, 'home') });

    expect(report.exitCode).toBe(1);
    expect(report.checks.find((check) => check.id === 'index-status')?.status).toBe('fail');
    expect(fs.readFileSync(statusPath, 'utf8')).toBe(original);
  });
});
