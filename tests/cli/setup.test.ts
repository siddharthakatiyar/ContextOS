import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectProjectSetup } from '../../src/cli/commands/setup.js';
import { initializeProject } from '../../src/cli/commands/init.js';
import { installProjectAgentConfigs } from '../../src/cli/utils/project-agent-config.js';
import { generateCursorConfig } from '../../src/mcp/cursor/config-generator.js';

const roots: string[] = [];
function temp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-setup-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('project setup', () => {
  it('checks uninitialized projects without creating a registry, then observes registration', async () => {
    const home = temp();
    const root = temp();
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(inspectProjectSetup(root).status).toBe('not_initialized');
    expect(fs.readdirSync(home)).toEqual([]);
    expect(fs.readdirSync(root)).toEqual([]);
    await initializeProject(root, { index: false, integrations: false });
    const result = inspectProjectSetup(root);
    expect(result.status).toBe('registered');
    expect(result.scope.details?.viewId).toBeTruthy();
    expect(result.readiness.details?.generation).toBe(0);
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { contextos: { command: 'contextos', args: ['serve'] } } })
    );
    const nested = inspectProjectSetup(path.join(root, 'nested'), 'claude');
    expect(nested.mcp && !Array.isArray(nested.mcp) && nested.mcp.status).toBe('pass');
  });
  it('rejects dangling config symlinks', () => {
    const root = temp();
    fs.symlinkSync(path.join(root, 'missing-target'), path.join(root, 'opencode.json'));
    expect(() =>
      installProjectAgentConfigs(root, generateCursorConfig({ projectRoot: root }))
    ).toThrow('symlink');
    expect(fs.existsSync(path.join(root, 'missing-target'))).toBe(false);
  });
  it('registers detected Antigravity and Gemini in project configs without changing global config', () => {
    const home = temp();
    const root = temp();
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    for (const name of ['agy', 'gemini'])
      fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
    fs.mkdirSync(path.join(root, '.gemini'));
    fs.writeFileSync(
      path.join(root, '.gemini', 'settings.json'),
      JSON.stringify({ mcpServers: { custom: { command: 'keep' } }, theme: 'user' })
    );
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve('bin/contextos.ts'), 'init', root, '--no-index', '--json'],
      {
        env: {
          ...process.env,
          HOME: home,
          PATH: bin,
          CODEX_HOME: path.join(home, 'codex'),
          CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
          XDG_CONFIG_HOME: path.join(home, 'xdg'),
          CONTEXTOS_AUTO_PATCH_REEXEC: '1'
        },
        encoding: 'utf8',
        timeout: 30000
      }
    );
    expect(result.status, result.stderr).toBe(0);
    const agy = JSON.parse(fs.readFileSync(path.join(root, '.agents', 'mcp_config.json'), 'utf8'));
    const gemini = JSON.parse(fs.readFileSync(path.join(root, '.gemini', 'settings.json'), 'utf8'));
    expect(agy.mcpServers.contextos.command).toBe('contextos');
    expect(gemini.mcpServers.contextos.command).toBe('contextos');
    expect(gemini.mcpServers.custom.command).toBe('keep');
    expect(gemini.theme).toBe('user');
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
  });
  it('keeps indexed CLI initialization JSON clean and reports skipped JSONC', () => {
    const home = temp();
    const root = temp();
    fs.writeFileSync(path.join(root, 'sample.ts'), 'export const sample = 1;\n');
    fs.writeFileSync(path.join(root, 'opencode.jsonc'), '{ /* user config */ }\n');
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve('bin/contextos.ts'), 'init', root, '--json'],
      {
        env: { ...process.env, HOME: home, CONTEXTOS_AUTO_PATCH_REEXEC: '1' },
        encoding: 'utf8',
        timeout: 60000
      }
    );
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.status).toBe('registered');
    expect(output.state).toBe('ready');
    expect(output.generation).toBeGreaterThan(0);
    expect(output.integrationWarnings.join(' ')).toContain('opencode.jsonc');
    expect(result.stderr).toContain('[BackgroundIndexer]');
  }, 70000);
  it('preserves TOML configuration and an existing OpenCode registration', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, '.codex'));
    const toml = path.join(root, '.codex', 'config.toml');
    fs.writeFileSync(toml, 'model = "example"\n# user note\n');
    fs.writeFileSync(
      path.join(root, 'opencode.json'),
      JSON.stringify({ mcp: { servers: { contextos: { type: 'local', command: ['custom'] } } } })
    );
    const generated = generateCursorConfig({ projectRoot: root });
    installProjectAgentConfigs(root, generated);
    const first = fs.readFileSync(toml, 'utf8');
    expect(first.startsWith('model = "example"\n# user note\n')).toBe(true);
    expect(first).toContain('[mcp_servers.contextos]');
    installProjectAgentConfigs(root, generated);
    expect(fs.readFileSync(toml, 'utf8')).toBe(first);
    expect(
      JSON.parse(fs.readFileSync(path.join(root, 'opencode.json'), 'utf8')).mcp.servers.contextos
        .command
    ).toEqual(['custom']);
  });
});
