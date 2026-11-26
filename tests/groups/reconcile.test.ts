import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import * as discovery from '../../src/core/workspace/discovery.js';

let temp: string;
let registry: WorkspaceRegistry;
function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
}
function repository(name: string): string {
  const root = path.join(temp, name);
  fs.mkdirSync(root);
  git(root, 'init', '-b', 'main');
  git(
    root,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-m',
    'initial'
  );
  return root;
}
beforeEach(() => {
  temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-reconcile-')));
  registry = new WorkspaceRegistry(path.join(temp, 'state'));
});
afterEach(() => {
  vi.restoreAllMocks();
  registry.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe('repository identity reconciliation', () => {
  it.each([['project', 'list'], ['project', 'status'], ['status']])(
    'refreshes persisted availability in %s %s',
    (...command) => {
      const home = path.join(temp, 'cli-home');
      const cliRegistry = new WorkspaceRegistry(path.join(home, '.contextos'));
      try {
        const source = cliRegistry.register(repository('cli-backend'));
        cliRegistry.update(source.repoId, {
          state: 'unavailable',
          lastError: 'Registered Git repository identity changed'
        });
        const output = JSON.parse(
          execFileSync(
            process.execPath,
            [
              '--import',
              import.meta.resolve('tsx'),
              path.resolve('bin/contextos.ts'),
              ...command,
              '--json'
            ],
            {
              cwd: temp,
              env: {
                ...process.env,
                HOME: home,
                USERPROFILE: home,
                CONTEXTOS_SKIP_SETUP: '1',
                CONTEXTOS_EMBEDDINGS: '0'
              },
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
              timeout: 30_000
            }
          )
        );
        expect((output.repositories ?? output.views)[0]).toMatchObject({
          state: 'registered',
          lastError: null
        });
        expect(cliRegistry.resolve(source.repoId)).toMatchObject({
          state: 'registered',
          lastError: null
        });
      } finally {
        cliRegistry.close();
      }
    },
    40_000
  );

  it('retries a transient identity mismatch before changing any active view', () => {
    const root = repository('backend');
    git(root, 'worktree', 'add', '-b', 'feature', path.join(temp, 'feature'));
    const source = registry.register(root);
    const found = discovery.discoverProject(root);
    const verify = vi.spyOn(discovery, 'gitCommonDirectory');
    const spy = vi
      .spyOn(discovery, 'discoverProject')
      .mockReturnValueOnce({ ...found, commonDir: null });
    registry.reconcile();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledWith(root);
    expect(
      registry
        .views(source.projectId)
        .every((v) => v.state === 'registered' && v.lastError === null)
    ).toBe(true);
  });

  it('backs off unavailable identity checks without blocking, and retries on expiry, force or fingerprint change', () => {
    const root = repository('backend');
    const source = registry.register(root);
    const found = discovery.discoverProject(root);
    const spy = vi
      .spyOn(discovery, 'discoverProject')
      .mockReturnValue({ ...found, commonDir: null });
    const sleep = vi.spyOn(Atomics, 'wait');
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    registry.reconcile();
    expect(registry.resolve(source.repoId).state).toBe('unavailable');
    const calls = spy.mock.calls.length;
    registry.reconcile();
    registry.reconcile();
    expect(spy).toHaveBeenCalledTimes(calls);
    expect(sleep).not.toHaveBeenCalled();
    now.mockReturnValue(130_001);
    registry.reconcile();
    expect(spy).toHaveBeenCalledTimes(calls * 2);
    registry.reconcile(undefined, { force: true });
    expect(spy).toHaveBeenCalledTimes(calls * 3);
    fs.writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/changed\n');
    registry.reconcile();
    expect(spy).toHaveBeenCalledTimes(calls * 4);
    spy.mockReturnValue(found);
    registry.reconcile(source.projectId, { force: true });
    expect(registry.resolve(source.repoId)).toMatchObject({ state: 'registered', lastError: null });
  });

  it('keeps the registered identity for equivalent common-directory aliases', () => {
    const root = repository('backend');
    const source = registry.register(root);
    const found = discovery.discoverProject(root);
    const alias = path.join(temp, 'git-alias');
    fs.symlinkSync(found.commonDir!, alias, 'dir');
    vi.spyOn(discovery, 'discoverProject').mockReturnValue({
      ...found,
      commonDir: alias + path.sep,
      worktrees: found.worktrees.map((tree) => ({ ...tree, commonDir: alias + path.sep }))
    });
    registry.reconcile();
    expect(registry.projects()).toHaveLength(1);
    expect(registry.resolve(source.repoId)).toMatchObject({
      state: 'registered',
      lastError: null,
      commonDir: found.commonDir
    });
  });

  it('reports expected, actual and root paths and heals after a root is restored', () => {
    const root = repository('backend');
    const other = repository('other');
    const source = registry.register(root);
    const saved = path.join(temp, 'saved-git');
    fs.renameSync(path.join(root, '.git'), saved);
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    registry.reconcile();
    const failed = registry.resolve(source.repoId);
    expect(failed.state).toBe('unavailable');
    expect(failed.lastError).toContain('Registered Git repository identity changed');
    expect(failed.lastError).toContain(path.join(root, '.git'));
    expect(failed.lastError).toContain(path.join(other, '.git'));
    expect(failed.lastError).toContain(`root=${JSON.stringify(root)}`);
    fs.unlinkSync(path.join(root, '.git'));
    fs.renameSync(saved, path.join(root, '.git'));
    registry.reconcile();
    expect(registry.resolve(source.repoId)).toMatchObject({ state: 'registered', lastError: null });
  });

  it('keeps a healthy worktree available without adopting a mismatched primary root', () => {
    const root = repository('backend');
    git(root, 'init', '--separate-git-dir', path.join(temp, 'shared-git'));
    const feature = path.join(temp, 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', feature);
    const source = registry.register(root);
    registry.reconcile(); // Cache discovery before editing only the existing gitdir pointer.
    const other = repository('other');
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(other, '.git')}\n`);
    registry.reconcile();
    expect(registry.active(feature)).toMatchObject({ state: 'registered', lastError: null });
    expect(registry.resolve(source.repoId).state).toBe('unavailable');
    expect(registry.worktrees()).toHaveLength(2);
    expect(registry.projects()).toHaveLength(1);
    fs.writeFileSync(path.join(root, '.git'), `gitdir: ${path.join(temp, 'shared-git')}\n`);
    registry.reconcile();
    expect(registry.resolve(source.repoId)).toMatchObject({ state: 'registered', lastError: null });
  });

  it('compares case aliases according to filesystem identity, preserving distinct directories', () => {
    const root = repository('case-test');
    const upper = path.join(temp, 'CASE-TEST');
    if (fs.existsSync(upper)) {
      expect(discovery.sameDirectory(root, upper)).toBe(true);
    } else {
      fs.mkdirSync(upper);
      expect(discovery.sameDirectory(root, upper)).toBe(false);
    }
    expect(discovery.sameDirectory(root, root + path.sep)).toBe(true);
    expect(discovery.sameDirectory(root, null)).toBe(false);
  });

  it('resolves relative gitdir and commondir paths from a symlinked linked checkout', () => {
    const root = repository('backend');
    const feature = path.join(temp, 'feature');
    git(root, 'worktree', 'add', '-b', 'feature', feature);
    const gitDir = git(feature, 'rev-parse', '--absolute-git-dir');
    fs.writeFileSync(path.join(feature, '.git'), `gitdir: ${path.relative(feature, gitDir)}\n`);
    expect(fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()).toBe('../..');
    const aliasParent = path.join(temp, 'aliases');
    fs.mkdirSync(aliasParent);
    const alias = path.join(aliasParent, 'feature-alias');
    fs.symlinkSync(feature, alias, 'dir');
    const source = registry.register(alias + path.sep);
    registry.reconcile();
    expect(discovery.discoverProject(alias).commonDir).toBe(path.join(root, '.git'));
    expect(discovery.gitCommonDirectory(alias)).toBe(path.join(root, '.git'));
    expect(registry.resolve(source.repoId)).toMatchObject({ state: 'registered', lastError: null });
    expect(registry.projects()).toHaveLength(1);
  });

  it('does not falsely flag 52 repositories registered and reconciled by four concurrent processes', async () => {
    registry.ensureGroup('many');
    const roots = Array.from({ length: 52 }, (_, index) => repository(`repo-${index}`));
    const alias = path.join(temp, 'repo-alias');
    fs.symlinkSync(roots[0], alias, 'dir');
    roots[0] = alias + path.sep;
    const module = pathToFileURL(path.resolve('src/core/workspace/registry.ts')).href;
    const script = `import { WorkspaceRegistry } from ${JSON.stringify(module)};
      const registry = new WorkspaceRegistry(process.argv[1]);
      try {
        for (const root of JSON.parse(process.argv[2])) registry.register(root, { group: 'many' });
        registry.reconcile();
        console.log(JSON.stringify(registry.listAll()));
      } finally { registry.close(); }`;
    await Promise.all(
      Array.from(
        { length: 4 },
        (_, worker) =>
          new Promise<void>((resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                '--import',
                'tsx',
                '--input-type=module',
                '-e',
                script,
                registry.home,
                JSON.stringify(roots.filter((_, index) => index % 4 === worker))
              ],
              {
                env: {
                  ...process.env,
                  HOME: temp,
                  CONTEXTOS_SKIP_SETUP: '1',
                  CONTEXTOS_EMBEDDINGS: '0'
                }
              }
            );
            let stdout = '',
              stderr = '';
            child.stdout.on('data', (data) => {
              stdout += data.toString();
            });
            child.stderr.on('data', (data) => {
              stderr += data.toString();
            });
            child.on('error', reject);
            child.on('close', (code) => {
              if (code !== 0) return reject(new Error(`child exited ${code}: ${stderr}`));
              try {
                const views = JSON.parse(stdout.trim().split('\n').at(-1)!);
                expect(views.some((view: { state: string }) => view.state === 'unavailable')).toBe(
                  false
                );
                resolve();
              } catch (error) {
                reject(error);
              }
            });
          })
      )
    );
    registry.reconcile();
    expect(registry.list('many')).toHaveLength(52);
    expect(
      registry.listAll().every((view) => view.state === 'registered' && view.lastError === null)
    ).toBe(true);
  }, 120_000);

  it('recovers an unavailable view written by another connection despite an unchanged cached fingerprint', () => {
    const source = registry.register(repository('backend'));
    registry.reconcile();
    const other = new WorkspaceRegistry(registry.home);
    try {
      other.update(source.repoId, {
        state: 'unavailable',
        lastError: 'Registered Git repository identity changed'
      });
      registry.reconcile();
      expect(registry.resolve(source.repoId)).toMatchObject({
        state: 'registered',
        lastError: null
      });
    } finally {
      other.close();
    }
  });
});

describe('cold discovery caching and asynchronous refresh', () => {
  it('reuses persisted fingerprints after reopening, but retries unavailable views and checkout changes', async () => {
    const root = repository('persisted');
    const source = registry.register(root);
    await registry.reconcileAsync();
    registry.close();
    registry = new WorkspaceRegistry(path.join(temp, 'state'));
    const discover = vi.spyOn(discovery, 'discoverProjectAsync');
    await registry.reconcileAsync();
    expect(discover).not.toHaveBeenCalled();
    registry.update(source.repoId, { state: 'unavailable', lastError: 'transient' });
    await registry.reconcileAsync();
    expect(discover).toHaveBeenCalledTimes(1);
    expect(registry.resolve(source.repoId).state).toBe('registered');
    git(root, 'checkout', '-b', 'changed');
    await registry.reconcileAsync();
    expect(discover).toHaveBeenCalledTimes(2);
    expect(registry.active(root)?.branch).toBe('changed');
  });

  it('bounds async Git discovery to four projects and keeps timers responsive', async () => {
    for (let i = 0; i < 9; i++) registry.register(repository(`async-${i}`));
    let running = 0;
    let maximum = 0;
    let ticks = 0;
    const original = discovery.discoverProjectAsync;
    vi.spyOn(discovery, 'discoverProjectAsync').mockImplementation(async (root) => {
      running++;
      maximum = Math.max(maximum, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return await original(root);
      } finally {
        running--;
      }
    });
    const synchronous = vi.spyOn(discovery, 'discoverProject');
    const branches = vi.spyOn(discovery, 'localBranches');
    const timer = setInterval(() => ticks++, 5);
    try {
      await registry.reconcileAsync(undefined, { force: true });
      await registry.cleanupAsync();
    } finally {
      clearInterval(timer);
    }
    expect(maximum).toBe(4);
    expect(ticks).toBeGreaterThan(3);
    expect(synchronous).not.toHaveBeenCalled();
    expect(branches).not.toHaveBeenCalled();
  }, 15000);

  it('preserves unavailable-view backoff on the async path and recovers after expiry', async () => {
    const root = repository('async-retry');
    const source = registry.register(root);
    const found = discovery.discoverProject(root);
    const discover = vi
      .spyOn(discovery, 'discoverProjectAsync')
      .mockResolvedValue({ ...found, commonDir: null });
    vi.spyOn(discovery, 'gitCommonDirectoryAsync').mockResolvedValue('wrong');
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    await registry.reconcileAsync();
    const attempts = discover.mock.calls.length;
    expect(registry.resolve(source.repoId).state).toBe('unavailable');
    await registry.reconcileAsync();
    expect(discover).toHaveBeenCalledTimes(attempts);
    now.mockReturnValue(130_001);
    discover.mockResolvedValue(found);
    await registry.reconcileAsync();
    expect(discover).toHaveBeenCalledTimes(attempts + 1);
    expect(registry.resolve(source.repoId).lastError).toBeNull();
  });
});
