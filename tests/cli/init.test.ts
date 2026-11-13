import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initCommand, initializeProject } from '../../src/cli/commands/init.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';

describe('CLI init command', () => {
  let home: string;
  let project: string;
  let originalCwd: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-init-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-init-project-'));
    originalCwd = process.cwd();
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
    process.chdir(project);
    fs.writeFileSync(
      path.join(project, 'CLAUDE.md'),
      '# Project notes\nKeep this user-authored text.\n'
    );
    const registry = new WorkspaceRegistry();
    registry.ensureGroup('payments');
    registry.close();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    vi.restoreAllMocks();
    homedirSpy.mockRestore();
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('initializes globally, enrolls the checkout, and installs managed agent guidance', async () => {
    await initCommand.parseAsync([
      'node',
      'contextos',
      project,
      '--group',
      'payments',
      '--no-index'
    ]);

    const registry = new WorkspaceRegistry();
    try {
      const source = registry.resolve(project);
      expect(source.projectId).toBeTruthy();
      expect(source.viewId).toBeTruthy();
      expect(source.dbPath).toBe(
        path.join(
          home,
          '.contextos',
          'projects',
          source.projectId,
          'views',
          source.viewId,
          'index.db'
        )
      );
      expect(registry.list('payments').map((view) => view.projectId)).toEqual([source.projectId]);
      expect(registry.listAll().some((view) => view.repoId === source.repoId)).toBe(true);
      expect(fs.existsSync(path.join(project, '.contextos'))).toBe(false);
      expect(fs.existsSync(source.dbPath)).toBe(true);
      expect(fs.existsSync(path.join(home, '.contextos', 'runtime', 'daemon.pid'))).toBe(false);
      expect(fs.existsSync(path.join(home, '.contextos', 'runtime'))).toBe(false);
      expect(fs.existsSync(path.join(path.dirname(source.dbPath), 'index-owner.json'))).toBe(false);

      const instructions = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
      const claude = fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8');
      expect(claude).toContain('Keep this user-authored text.');
      expect(claude).toContain('@AGENTS.md');
      expect(claude).not.toContain('<!-- contextos:managed:start -->');
      expect(instructions).toContain('<!-- contextos:managed:start -->');
      expect(instructions).toContain(
        'always save useful, durable discoveries when you have verified them'
      );
      expect(instructions).toContain('Do not save candidates, ambiguous matches, guesses');
    } finally {
      registry.close();
    }

    await initializeProject(project, { group: 'payments', index: false, integrations: false });
    const updated = fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8');
    expect(updated.match(/<!-- contextos:managed:start -->/g)).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8').match(/@AGENTS\.md/g)
    ).toHaveLength(1);
  });

  it('leaves invalid existing MCP configuration untouched and does not register the project', async () => {
    const mcpConfig = path.join(project, '.mcp.json');
    const invalid = '{ this is intentionally invalid';
    fs.writeFileSync(mcpConfig, invalid);

    await expect(initializeProject(project, { group: 'payments', index: false })).rejects.toThrow(
      'invalid JSON config'
    );

    expect(fs.readFileSync(mcpConfig, 'utf8')).toBe(invalid);
    expect(fs.existsSync(path.join(project, '.contextos'))).toBe(false);
    const registry = new WorkspaceRegistry();
    try {
      expect(registry.projects()).toHaveLength(0);
    } finally {
      registry.close();
    }
  });

  it('respects disabled automatic MCP configuration while installing project guidance', async () => {
    fs.writeFileSync(
      path.join(home, '.contextos', 'config.json'),
      JSON.stringify({ cursor: { autoGenerateConfig: false } })
    );
    fs.writeFileSync(path.join(project, '.mcp.json'), 'unrelated client configuration');
    await initializeProject(project, { group: 'payments', index: false });
    expect(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).toBe(
      'unrelated client configuration'
    );
    expect(fs.existsSync(path.join(project, '.vscode'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
    expect(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8')).toContain(
      '<!-- contextos:managed:start -->'
    );
    const registry = new WorkspaceRegistry();
    try {
      expect(registry.list('payments')).toHaveLength(1);
    } finally {
      registry.close();
    }
  });
});
