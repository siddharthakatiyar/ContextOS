import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatAutoPatchNotice, upgradeCommand } from '../../src/cli/commands/upgrade.js';

const execute = promisify(execFile);
const cli = path.resolve('dist/bin/contextos.js');
const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root: string;
let home: string;
let env: NodeJS.ProcessEnv;

async function run(...args: string[]): Promise<string> {
  return (
    await execute(process.execPath, [cli, ...args], {
      cwd: root,
      env,
      timeout: 30_000
    })
  ).stdout;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-polish-')));
  home = path.join(root, 'home');
  fs.mkdirSync(home);
  env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CONTEXTOS_SKIP_SETUP: '1',
    CONTEXTOS_EMBEDDINGS: '0',
    CONTEXTOS_REPO_ROOT: '',
    CONTEXTOS_AUTO_PATCH: '0'
  };
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  // Always stop a detached child before deleting its isolated state.
  await run('daemon', 'stop').catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI polish', () => {
  it('accepts both group selectors, prefers --group, and reports worktree checkout counts', async () => {
    const project = path.join(root, 'backend');
    fs.mkdirSync(project);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', project, ...args], { env, stdio: 'pipe' });
    git('init', '-b', 'main');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    );
    git('worktree', 'add', '-b', 'feature', path.join(root, 'feature'));
    await run('group', 'create', 'payments');
    await run(
      'project',
      'add',
      project,
      '--group',
      'payments',
      '--workspace',
      'default',
      '--no-index'
    );
    const selected = JSON.parse(await run('project', 'list', '--group', 'payments', '--json'));
    expect(selected).toMatchObject({
      group: 'payments',
      workspace: 'payments',
      repositories: [{ name: 'backend', checkoutCount: 2 }]
    });
    expect(JSON.parse(await run('project', 'list', '--workspace', 'payments', '--json'))).toEqual(
      selected
    );
    expect(JSON.parse(await run('project', 'list', '--json')).repositories).toEqual([]);
    expect(await run('project', 'list', '--group', 'payments')).toContain('2 checkouts');
    expect(await run('group', 'list')).toContain('payments\t1 projects\t2 checkouts');
    expect(
      JSON.parse(await run('project', 'status', 'backend', '--group', 'payments', '--json'))
        .repositories
    ).toHaveLength(1);
    expect(JSON.parse(await run('status', '--workspace', 'payments', '--json')).views).toHaveLength(
      2
    );
    expect(await run('reindex', '--workspace', 'payments')).toContain('Reindexed backend');
    await run('project', 'remove', 'backend', '--group', 'payments');
    expect(
      JSON.parse(await run('project', 'list', '--group', 'payments', '--json')).repositories
    ).toEqual([]);
    await run('project', 'add', project, '--workspace', 'payments', '--no-index');
    await run('project', 'remove', 'backend', '--workspace', 'payments');
  }, 90_000);

  it.each(['--detach', '--background'])(
    'starts with %s, returns readiness, PID and a private log, and reports live metadata',
    async (flag) => {
      const group = flag === '--detach' ? 'payments' : 'default';
      if (group !== 'default') await run('group', 'create', group);
      const output = await run(
        'daemon',
        'start',
        flag,
        flag === '--detach' ? '--group' : '--workspace',
        group
      );
      expect(output).toMatch(/RUNNING \(PID \d+, version 1\.2\.1, group /);
      expect(output).toContain(`group ${group})`);
      const log = output.match(/Log: (.+)/)?.[1];
      expect(log).toBe(path.join(home, '.contextos', 'runtime', 'daemon.log'));
      expect(fs.existsSync(log!)).toBe(true);
      if (process.platform !== 'win32') expect(fs.statSync(log!).mode & 0o777).toBe(0o600);
      expect(await run('daemon', 'status')).toContain(output.split('\n')[0]);
      expect(await run('daemon', 'status', '--workspace', group)).toContain(`group ${group})`);
      await expect(run('daemon', 'start', flag, '--group', group)).rejects.toThrow('Log:');
      expect(await run('daemon', 'status')).toContain(output.split('\n')[0]);
      await run('daemon', 'stop');
      expect(await run('daemon', 'status')).toContain('NOT RUNNING');
    },
    45_000
  );

  it('identifies the stale config file and server and suggests repair in human doctor output', async () => {
    const config = path.join(root, '.codex');
    fs.mkdirSync(config);
    const stale = path.join(root, 'missing', 'contextos.js');
    fs.writeFileSync(
      path.join(config, 'config.toml'),
      `[mcp_servers.contextos-stale]\ncommand = "node"\nargs = [${JSON.stringify(stale)}, "serve"]\n`
    );
    let output = '';
    try {
      await run('doctor');
    } catch (error) {
      output = (error as { stdout: string }).stdout;
    }
    expect(output).toContain(stale);
    expect(output).toContain(path.join(config, 'config.toml'));
    expect(output).toContain('server: contextos-stale');
    expect(output).toContain('Update this server entry');
    expect(output).toContain('contextos init');
  });

  it('suggests an executable group-add command for the actual empty group', async () => {
    await run('group', 'create', 'empty payments');
    await expect(run('query', 'test', '--group', 'empty payments')).rejects.toThrow(
      `contextos group add "empty payments" ${JSON.stringify(root)}`
    );
  });

  it('names the actual project and group in serve membership errors', async () => {
    const project = path.join(root, 'backend');
    fs.mkdirSync(project);
    await run('project', 'add', project, '--no-index');
    await run('group', 'create', 'payments');
    env.CONTEXTOS_REPO_ROOT = project;
    await expect(run('serve', '--group', 'payments')).rejects.toThrow(
      `contextos group add "payments" ${JSON.stringify(project)} --name "backend"`
    );
  });

  it('silences only the unsupported-platform patch notice unless verbose logging is enabled', () => {
    vi.stubEnv('DEBUG', '');
    const result = {
      status: 'skipped' as const,
      reason: 'Automatic package installation is supported on Linux only.'
    };
    expect(formatAutoPatchNotice(result)).toBe('');
    vi.stubEnv('DEBUG', '1');
    expect(formatAutoPatchNotice(result)).toContain(result.reason);
    vi.stubEnv('DEBUG', '');
    expect(formatAutoPatchNotice({ status: 'skipped', reason: 'Download failed' })).toContain(
      'Download failed'
    );
  });

  it.each([undefined, '1.2.2'])(
    'prints a concrete manual upgrade command on macOS (version %s)',
    async (version) => {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'darwin' });
      await expect(
        upgradeCommand.parseAsync(['node', 'contextos', ...(version ? ['--version', version] : [])])
      ).rejects.toThrow(
        `Run this command manually:\n  npm install -g @siddharthakatiyar/contextos@${version ?? 'latest'}`
      );
    }
  );
});
