import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/daemon/client.js', () => ({ runDaemonClient: vi.fn() }));
vi.mock('../../src/core/updater/index.js', () => ({
  checkForUpdates: vi.fn(),
  formatUpdateNotice: vi.fn()
}));
vi.mock('../../src/core/updater/auto-patch-policy.js', () => ({
  readAutoPatchPolicy: () => 'notify'
}));
vi.mock('../../src/cli/utils/installation-setup.js', () => ({ upgradeExistingProjects: vi.fn() }));

import { serveCommand } from '../../src/cli/commands/serve.js';
import { initializeProject } from '../../src/cli/commands/init.js';
import { runDaemonClient } from '../../src/core/daemon/client.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { nestedProjectWarning } from '../../src/core/workspace/project-boundary.js';

let temporary: string;
let root: string;
let registry: WorkspaceRegistry;
let originalCwd: string;
let uncaught: Set<NodeJS.UncaughtExceptionListener>;
let rejected: Set<NodeJS.UnhandledRejectionListener>;
beforeEach(() => {
  originalCwd = process.cwd();
  temporary = fs.mkdtempSync(path.resolve('scratch', 'nested-project-'));
  vi.stubEnv('GIT_CEILING_DIRECTORIES', temporary);
  root = path.join(temporary, 'parent');
  fs.mkdirSync(path.join(root, '.contextos'), { recursive: true });
  fs.writeFileSync(path.join(root, '.contextos', 'index.db'), '');
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(temporary, 'home'));
  vi.stubEnv('CONTEXTOS_REPO_ROOT', root);
  registry = new WorkspaceRegistry();
  uncaught = new Set(process.listeners('uncaughtException'));
  rejected = new Set(process.listeners('unhandledRejection'));
  vi.mocked(runDaemonClient).mockClear();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(originalCwd);
  for (const listener of process.listeners('uncaughtException'))
    if (!uncaught.has(listener)) process.removeListener('uncaughtException', listener);
  for (const listener of process.listeners('unhandledRejection'))
    if (!rejected.has(listener)) process.removeListener('unhandledRejection', listener);
  registry.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(temporary, { recursive: true, force: true });
});
function child(relative = 'nested/child') {
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, { recursive: true });
  return registry.register(directory);
}

describe('nested registered project boundaries', () => {
  it('skips automatic registration of a legacy non-Git umbrella folder', async () => {
    child();
    await expect(serveCommand.parseAsync(['node', 'contextos'])).rejects.toThrow(
      'Skipping automatic project registration'
    );
    expect(registry.projects()).toHaveLength(1);
    expect(runDaemonClient).not.toHaveBeenCalled();
  });
  it('allows an explicit project selection from its parent', async () => {
    const source = child();
    await serveCommand.parseAsync([
      'node',
      'contextos',
      '--group',
      'default',
      '--project',
      source.projectId
    ]);
    expect(runDaemonClient).toHaveBeenCalledWith(source.rootPath, expect.any(Object));
    expect(registry.projects()).toHaveLength(1);
  });
  it('still auto-registers a standalone non-Git legacy project', async () => {
    await serveCommand.parseAsync(['node', 'contextos']);
    expect(registry.projects()).toHaveLength(1);
    expect(runDaemonClient).toHaveBeenCalledWith(root, expect.any(Object));
  });
  it('warns before explicitly initializing a non-Git parent, including JSON output', async () => {
    child();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await initializeProject(root, { index: false, integrations: false });
    expect(warning.mock.calls.flat().join('\n')).toContain('contains registered projects');
    const output = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await initializeProject(root, { index: false, integrations: false, json: true });
    const result = JSON.parse(String(output.mock.calls[0][0]));
    expect(result.integrationWarnings.join('\n')).toContain('Select --group');
  });
  it('uses canonical containment and does not confuse sibling prefixes with descendants', () => {
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling);
    registry.register(sibling);
    expect(nestedProjectWarning(root, registry)).toBeNull();
    child();
    const alias = path.join(temporary, 'alias');
    fs.symlinkSync(root, alias, 'dir');
    expect(nestedProjectWarning(alias, registry)).toContain('contains registered projects');
  });
  it('allows Git parent projects and Git worktrees even with registered descendants', () => {
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    child();
    expect(nestedProjectWarning(root, registry)).toBeNull();
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'initial'
      ],
      { stdio: 'ignore' }
    );
    const worktree = path.join(temporary, 'worktree');
    execFileSync('git', ['-C', root, 'worktree', 'add', '-b', 'other', worktree], {
      stdio: 'ignore'
    });
    const nested = path.join(worktree, 'nested');
    fs.mkdirSync(nested);
    // Register a separate nested Git repository, rather than rediscovering its parent.
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
    registry.register(nested, { name: 'worktree-child' });
    expect(nestedProjectWarning(worktree, registry)).toBeNull();
  });
});
