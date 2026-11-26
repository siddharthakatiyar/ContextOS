import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initCommand,
  initializeProject,
  refreshProjectSetup
} from '../../src/cli/commands/init.js';
import { repoCommand } from '../../src/cli/commands/repo.js';
import { groupCommand } from '../../src/cli/commands/group.js';
import { setupCommand } from '../../src/cli/commands/setup.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import * as installation from '../../src/cli/utils/installation-setup.js';

let temporary: string;
let root: string;
function git(cwd: string, ...args: string[]) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}
function repository(name: string) {
  const dir = path.join(temporary, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}
function snapshot(dir: string) {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(dir, file), fs.readFileSync(file).toString('base64')];
    })
    .sort((a, b) => a[0].localeCompare(b[0]));
}
beforeEach(() => {
  temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-side-effects-'));
  const home = path.join(temporary, 'home');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(home, '.gemini'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('CONTEXTOS_SKIP_SETUP', '1');
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(installation, 'upgradeExistingProjects');
  root = repository('target');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});

const packageVersion = (
  JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as { version: string }
).version;

describe('project integration side effects', () => {
  it.each(['project add disabled', 'group add', 'init disabled', 'init CLI disabled'])(
    '%s only registers, leaving every checkout untouched',
    async (command) => {
      fs.writeFileSync(path.join(root, 'source.ts'), 'export const value = 1;\n');
      git(root, 'add', 'source.ts');
      git(
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '-qm',
        'initial'
      );
      const linked = path.join(temporary, 'linked');
      git(root, 'worktree', 'add', '-q', '-b', 'linked', linked);
      const other = repository('registered');
      const registry = new WorkspaceRegistry();
      registry.ensureGroup('g');
      registry.register(other, { workspace: 'g' });
      registry.close();
      fs.writeFileSync(path.join(root, 'AGENTS.md'), 'User rules\n');
      fs.writeFileSync(path.join(root, '.mcp.json'), 'invalid JSON must be ignored');
      const before = [root, linked, other].map(snapshot);
      if (command === 'project add disabled')
        await repoCommand.parseAsync([
          'node',
          'contextos',
          'add',
          root,
          '--group',
          'g',
          '--no-index',
          '--no-integrations'
        ]);
      else if (command === 'group add')
        await groupCommand.parseAsync(['node', 'contextos', 'add', 'g', root, '--no-index']);
      else if (command === 'init CLI disabled')
        await initCommand.parseAsync([
          'node',
          'contextos',
          root,
          '--group',
          'g',
          '--no-index',
          '--no-integrations'
        ]);
      else await initializeProject(root, { group: 'g', index: false, integrations: false });
      expect(installation.upgradeExistingProjects).not.toHaveBeenCalled();
      expect([root, linked, other].map(snapshot)).toEqual(before);
      expect(console.warn).toHaveBeenCalledWith(
        'Automatic project integrations are disabled; no checkout files were changed.'
      );
      const after = new WorkspaceRegistry();
      try {
        expect(after.list('g', true)).toHaveLength(3);
      } finally {
        after.close();
      }
    }
  );

  it('keeps setup scoped to its target, preserves user instructions, and excludes exact generated paths idempotently', async () => {
    const other = repository('other');
    const registry = new WorkspaceRegistry();
    registry.register(other);
    registry.close();
    const beforeOther = snapshot(other);
    for (const name of ['.cursor', '.agents', '.codex', '.grok'])
      fs.mkdirSync(path.join(root, name));
    const agents =
      'User instructions\n<!-- contextos:managed:start -->\nold\n<!-- contextos:managed:end -->\n';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), agents);
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'User Claude instructions\n');
    fs.writeFileSync(path.join(root, 'opencode.json'), '{}\n');
    fs.writeFileSync(path.join(root, '.gitignore'), '# user ignore\n');
    const exclude = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
    fs.writeFileSync(exclude, '# user exclude without newline');
    await setupCommand.parseAsync(['node', 'contextos', root, '--no-index']);
    expect(installation.upgradeExistingProjects).not.toHaveBeenCalled();
    expect(snapshot(other)).toEqual(beforeOther);
    const paths = [
      'AGENTS.md',
      '.mcp.json',
      '.cursor/mcp.json',
      '.agents/mcp_config.json',
      '.gemini/settings.json',
      '.codex/config.toml',
      '.grok/config.toml',
      'opencode.json',
      '.vscode/cline_mcp_settings.json',
      '.vscode/roo_mcp_settings.json'
    ];
    const first = fs.readFileSync(exclude, 'utf8');
    expect(first.startsWith('# user exclude without newline\n')).toBe(true);
    for (const file of paths) {
      expect(fs.existsSync(path.join(root, file)), file).toBe(true);
      expect(
        first.split('\n').filter((line) => line === `/${file}`),
        file
      ).toHaveLength(1);
      expect(git(root, 'check-ignore', file), file).toBe(file);
    }
    expect(first).not.toContain('/.codex/\n');
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('User instructions\n');
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toContain(
      'User Claude instructions\n'
    );
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('# user ignore\n');
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe(
      '?? .gitignore\n?? CLAUDE.md'
    );
    refreshProjectSetup(root);
    expect(fs.readFileSync(exclude, 'utf8')).toBe(first);
    fs.writeFileSync(path.join(root, '.codex', 'user.txt'), 'visible');
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toContain(
      '?? .codex/user.txt'
    );
  });

  it('keeps handwritten untracked instructions visible, on init', async () => {
    for (const file of ['AGENTS.md', 'CLAUDE.md'])
      fs.writeFileSync(path.join(root, file), 'My handwritten rules\n');
    await initializeProject(root, { index: false });
    const exclude = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
    for (const file of ['AGENTS.md', 'CLAUDE.md']) {
      expect(fs.readFileSync(exclude, 'utf8').split('\n')).not.toContain(`/${file}`);
      expect(git(root, 'status', '--porcelain')).toContain(`?? ${file}`);
    }
  });

  it.each(['init', 'project add'])(
    'refreshes both registered worktrees of this project on %s',
    async (command) => {
      git(
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-qm',
        'initial'
      );
      const linked = path.join(temporary, 'linked');
      git(root, 'worktree', 'add', '-q', '-b', 'linked', linked);
      const other = repository('unrelated');
      const registry = new WorkspaceRegistry();
      registry.register(root);
      registry.register(other);
      registry.close();
      for (const checkout of [root, linked]) {
        fs.writeFileSync(
          path.join(checkout, 'AGENTS.md'),
          '<!-- contextos:managed:start -->\nold\n<!-- contextos:managed:end -->\n'
        );
      }
      const untouched = snapshot(other);
      if (command === 'init') await initializeProject(root, { index: false });
      else await repoCommand.parseAsync(['node', 'contextos', 'add', root, '--no-index']);
      for (const checkout of [root, linked]) {
        expect(fs.readFileSync(path.join(checkout, 'AGENTS.md'), 'utf8')).toContain(
          `managed instructions v${packageVersion}`
        );
        expect(git(checkout, 'status', '--porcelain', '--untracked-files=all')).toBe('');
        const exclude = path.resolve(
          checkout,
          git(checkout, 'rev-parse', '--git-path', 'info/exclude')
        );
        expect(fs.readFileSync(exclude, 'utf8')).toContain('/AGENTS.md\n');
      }
      expect(snapshot(other)).toEqual(untouched);
      expect(installation.upgradeExistingProjects).not.toHaveBeenCalled();
    }
  );

  it('excludes integrations generated by an earlier setup without duplicating existing rules', () => {
    fs.writeFileSync(
      path.join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { contextos: { command: 'custom' } } })
    );
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(
      path.join(root, '.codex', 'config.toml'),
      '[mcp_servers.contextos]\ncommand = "custom"\n'
    );
    fs.writeFileSync(
      path.join(root, 'opencode.json'),
      JSON.stringify({ mcp: { servers: { contextos: { command: ['custom'] } } } })
    );
    const exclude = path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude'));
    fs.writeFileSync(exclude, '# custom rules\r\n/AGENTS.md\r\n');
    refreshProjectSetup(root);
    const contents = fs.readFileSync(exclude, 'utf8');
    expect(contents.startsWith('# custom rules\r\n/AGENTS.md\r\n')).toBe(true);
    expect(contents.match(/\/AGENTS\.md/g)).toHaveLength(1);
    expect(git(root, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  });

  it('never modifies or excludes tracked files, including instructions and client configuration', () => {
    fs.mkdirSync(path.join(root, '.codex'));
    const files = ['AGENTS.md', 'CLAUDE.md', '.mcp.json', '.codex/config.toml', 'opencode.json'];
    for (const file of files) fs.writeFileSync(path.join(root, file), '{}\n');
    git(root, 'add', ...files);
    refreshProjectSetup(root);
    for (const file of files)
      expect(fs.readFileSync(path.join(root, file), 'utf8'), file).toBe('{}\n');
    expect(git(root, 'diff')).toBe('');
    const exclude = fs.readFileSync(
      path.resolve(root, git(root, 'rev-parse', '--git-path', 'info/exclude')),
      'utf8'
    );
    for (const file of files) expect(exclude.split('\n')).not.toContain(`/${file}`);
  });

  it('uses the linked worktree Git exclude path without writing to the primary checkout', () => {
    git(
      root,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-qm',
      'initial'
    );
    const linked = path.join(temporary, 'linked');
    git(root, 'worktree', 'add', '-q', '-b', 'linked', linked);
    refreshProjectSetup(linked);
    const exclude = path.resolve(linked, git(linked, 'rev-parse', '--git-path', 'info/exclude'));
    expect(fs.readFileSync(exclude, 'utf8')).toContain('/AGENTS.md\n');
    expect(git(linked, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(fs.existsSync(path.join(root, 'AGENTS.md'))).toBe(false);
  });

  it('supports directories without Git and performs no disabled setup writes', () => {
    const plain = path.join(temporary, 'plain');
    fs.mkdirSync(plain);
    expect(refreshProjectSetup(plain, { integrations: false })).toEqual([
      'Automatic project integrations are disabled; no checkout files were changed.'
    ]);
    expect(fs.readdirSync(plain)).toEqual([]);
    refreshProjectSetup(plain);
    expect(fs.existsSync(path.join(plain, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(plain, '.git'))).toBe(false);
  });
});
