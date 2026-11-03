import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  createUpgradeInstallPlan,
  formatUpgradeInstallPlan,
  parseStableVersion,
  processReferencesPackage,
  runUpgradeWorkflow,
  selectUpgradeVersion,
  type UpgradeDaemon,
  type UpgradeWorkflowAdapters,
  type UpgradeWorkflowPlan
} from '../../src/cli/commands/upgrade.js';

const packageName = '@siddharthakatiyar/contextos';

function makeLocalPlanFixture(
  manager: 'npm' | 'pnpm' | 'yarn',
  dependencyBucket:
    | 'dependencies'
    | 'devDependencies'
    | 'optionalDependencies'
    | 'peerDependencies' = 'dependencies',
  dependencySpec = '^1.0.0'
) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-upgrade-plan-'));
  const projectRoot = path.join(tempRoot, 'project');
  const packagePath = path.join(projectRoot, 'node_modules', '@siddharthakatiyar', 'contextos');
  const packageManager = `${manager}@10.0.0`;
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      packageManager,
      [dependencyBucket]: { [packageName]: dependencySpec }
    })
  );

  let packageRoot = packagePath;
  if (manager === 'pnpm') {
    const storePath = path.join(
      projectRoot,
      'node_modules',
      '.pnpm',
      '@siddharthakatiyar+contextos@1.0.2',
      'node_modules',
      '@siddharthakatiyar',
      'contextos'
    );
    fs.mkdirSync(storePath, { recursive: true });
    fs.mkdirSync(path.dirname(packagePath), { recursive: true });
    fs.symlinkSync(storePath, packagePath, process.platform === 'win32' ? 'junction' : 'dir');
    packageRoot = storePath;
  } else {
    fs.mkdirSync(packagePath, { recursive: true });
  }
  fs.writeFileSync(
    path.join(packageRoot, 'package.json'),
    JSON.stringify({ name: packageName, version: '1.0.2' })
  );
  const lockfile =
    manager === 'npm' ? 'package-lock.json' : manager === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock';
  fs.writeFileSync(
    path.join(projectRoot, lockfile),
    manager === 'npm' ? '{}' : 'lockfileVersion: 9'
  );

  return {
    tempRoot,
    projectRoot,
    packageRoot: fs.realpathSync(packageRoot),
    cleanup: () => fs.rmSync(tempRoot, { recursive: true, force: true })
  };
}

const daemon: UpgradeDaemon = {
  pid: 1234,
  projectDir: '/workspace/project',
  version: '1.2.3'
};

function makePlan(overrides: Partial<UpgradeWorkflowPlan> = {}): UpgradeWorkflowPlan {
  return {
    packageRoot: '/global/node_modules/@scope/contextos',
    stagedPackageRoot: '/global/node_modules/@scope/.stage/contextos',
    backupPackageRoot: '/global/node_modules/@scope/contextos.backup',
    targetVersion: '1.3.0',
    currentVersion: '1.2.3',
    token: 'a'.repeat(64),
    daemons: [daemon],
    ...overrides
  };
}

function makeAdapters(
  plan: UpgradeWorkflowPlan,
  overrides: Partial<UpgradeWorkflowAdapters> = {}
): UpgradeWorkflowAdapters {
  return {
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    verifyCli: vi.fn(async () => true),
    requestDaemon: vi.fn(async (_daemon, action, _token, expectedVersion) => ({
      ok: true,
      version: action === 'get-version' ? plan.currentVersion : expectedVersion
    })),
    waitForExit: vi.fn(async () => true),
    startDaemon: vi.fn(async () => 5678),
    waitForDaemonVersion: vi.fn(async () => true),
    processAlive: vi.fn(() => false),
    ...overrides
  };
}

describe('upgrade version selection', () => {
  it('accepts only exact stable semantic versions', () => {
    expect(parseStableVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseStableVersion('v1.2.3')).toBeNull();
    expect(parseStableVersion('01.2.3')).toBeNull();
    expect(parseStableVersion('1.2.3-rc.1')).toBeNull();
    expect(parseStableVersion('1.2.9007199254740992')).toBeNull();
  });

  it('selects the newest newer stable release in the installed major by default', () => {
    expect(selectUpgradeVersion('1.2.3', ['1.4.0', '2.0.0', '1.5.0-rc.1', '1.3.0', '1.4.0'])).toBe(
      '1.4.0'
    );
  });

  it('requires explicit permission for a major version or an unavailable target', () => {
    expect(() => selectUpgradeVersion('1.2.3', ['2.0.0'])).toThrow(/no newer compatible/i);
    expect(selectUpgradeVersion('1.2.3', ['2.0.0'], undefined, true)).toBe('2.0.0');
    expect(() => selectUpgradeVersion('1.2.3', ['2.0.0'], '2.0.0')).toThrow(/--allow-major/i);
    expect(selectUpgradeVersion('1.2.3', ['2.0.0'], '2.0.0', true)).toBe('2.0.0');
    expect(() => selectUpgradeVersion('1.2.3', ['1.4.0'], '1.3.9')).toThrow(/not a published/i);
    expect(() => selectUpgradeVersion('1.2.3', ['1.2.0'])).toThrow(/no newer compatible/i);
  });
});

describe('package process detection', () => {
  it('detects relative package scripts and a working directory inside the package', () => {
    const packageRoot = '/global/node_modules/@scope/contextos';

    expect(
      processReferencesPackage(['node', 'dist/bin/contextos.js'], packageRoot, packageRoot)
    ).toBe(true);
    expect(
      processReferencesPackage(['node', 'server.js'], `${packageRoot}/dist`, packageRoot)
    ).toBe(true);
  });

  it('ignores unrelated arguments and working directories', () => {
    expect(
      processReferencesPackage(
        ['node', '/workspace/app/server.js'],
        '/workspace/app',
        '/global/node_modules/@scope/contextos'
      )
    ).toBe(false);
  });
});

describe('portable upgrade planning', () => {
  it.each([
    ['npm', 'local-npm', 'npm install --save-exact @siddharthakatiyar/contextos@1.4.0'],
    ['pnpm', 'local-pnpm', 'pnpm add --save-exact @siddharthakatiyar/contextos@1.4.0'],
    ['yarn', 'local-yarn', 'yarn add --exact @siddharthakatiyar/contextos@1.4.0']
  ] as const)(
    'uses the %s lockfile command for a declared local dependency',
    (manager, kind, command) => {
      const fixture = makeLocalPlanFixture(manager);
      try {
        const plan = createUpgradeInstallPlan(
          fixture.packageRoot,
          null,
          '1.4.0',
          fixture.projectRoot
        );

        expect(plan.kind).toBe(kind);
        expect(plan.projectRoot).toBe(fixture.projectRoot);
        expect(plan.command).toBe(command);
        expect(formatUpgradeInstallPlan(plan, '1.4.0')).toContain(
          'This is a read-only plan; no package files or daemons were changed.'
        );
      } finally {
        fixture.cleanup();
      }
    }
  );

  it.each([
    ['npm', 'local-npm', 'npm install --save-dev --save-exact @siddharthakatiyar/contextos@1.4.0'],
    ['pnpm', 'local-pnpm', 'pnpm add --save-dev --save-exact @siddharthakatiyar/contextos@1.4.0'],
    ['yarn', 'local-yarn', 'yarn add --dev --exact @siddharthakatiyar/contextos@1.4.0']
  ] as const)('preserves a local %s devDependency bucket', (manager, kind, command) => {
    const fixture = makeLocalPlanFixture(manager, 'devDependencies');
    try {
      const plan = createUpgradeInstallPlan(
        fixture.packageRoot,
        null,
        '1.4.0',
        fixture.projectRoot
      );

      expect(plan.kind).toBe(kind);
      expect(plan.command).toBe(command);
    } finally {
      fixture.cleanup();
    }
  });

  it.each(['optionalDependencies', 'peerDependencies'] as const)(
    'refuses to infer a command for %s',
    (bucket) => {
      const fixture = makeLocalPlanFixture('npm', bucket);
      try {
        const plan = createUpgradeInstallPlan(
          fixture.packageRoot,
          null,
          '1.4.0',
          fixture.projectRoot
        );

        expect(plan.kind).toBe('unknown');
        expect(plan.command).toBeNull();
        expect(plan.guidance).toContain(bucket);
      } finally {
        fixture.cleanup();
      }
    }
  );

  it('refuses to infer a command when a package is declared in multiple buckets', () => {
    const fixture = makeLocalPlanFixture('npm');
    try {
      const manifestPath = path.join(fixture.projectRoot, 'package.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      manifest.devDependencies = { [packageName]: '^1.0.0' };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest));

      const plan = createUpgradeInstallPlan(
        fixture.packageRoot,
        null,
        '1.4.0',
        fixture.projectRoot
      );
      expect(plan.kind).toBe('unknown');
      expect(plan.command).toBeNull();
      expect(plan.guidance).toContain('multiple dependency buckets');
    } finally {
      fixture.cleanup();
    }
  });

  it.each(['1.2.3', '^1.2.3', '~1.2.3', '>=1.2.3 <2.0.0', 'latest', 'next'])(
    'accepts simple registry spec %s',
    (dependencySpec) => {
      const fixture = makeLocalPlanFixture('npm', 'dependencies', dependencySpec);
      try {
        const plan = createUpgradeInstallPlan(
          fixture.packageRoot,
          null,
          '1.4.0',
          fixture.projectRoot
        );
        expect(plan.kind).toBe('local-npm');
        expect(plan.command).toBe('npm install --save-exact @siddharthakatiyar/contextos@1.4.0');
      } finally {
        fixture.cleanup();
      }
    }
  );

  it.each([
    'patch:^1.0.0',
    'catalog:default',
    'git+ssh://git@github.com/example/contextos.git',
    'github:example/contextos',
    'example/contextos',
    'npm:@example/contextos@^1.0.0'
  ])('refuses to infer a command for non-registry spec %s', (dependencySpec) => {
    const fixture = makeLocalPlanFixture('npm', 'dependencies', dependencySpec);
    try {
      const plan = createUpgradeInstallPlan(
        fixture.packageRoot,
        null,
        '1.4.0',
        fixture.projectRoot
      );
      expect(plan.kind).toBe('unknown');
      expect(plan.command).toBeNull();
      expect(plan.guidance).toContain('simple semver range or bare npm dist-tag');
    } finally {
      fixture.cleanup();
    }
  });

  it('recognizes a direct global npm package directory', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-global-plan-'));
    try {
      const globalRoot = path.join(tempRoot, 'node_modules');
      const packageRoot = path.join(globalRoot, '@siddharthakatiyar', 'contextos');
      fs.mkdirSync(packageRoot, { recursive: true });
      const plan = createUpgradeInstallPlan(packageRoot, globalRoot, '1.4.0');

      expect(plan.kind).toBe('global-npm');
      expect(plan.command).toBe('npm install -g @siddharthakatiyar/contextos@1.4.0');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('recognizes a global npm package reached through a symlinked parent', () => {
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-global-link-'));
    try {
      const physicalRoot = path.join(tempParent, 'physical');
      const linkedRoot = path.join(tempParent, 'linked');
      fs.mkdirSync(physicalRoot);
      fs.symlinkSync(physicalRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');

      const globalRoot = path.join(physicalRoot, 'node_modules');
      const packageRoot = path.join(linkedRoot, 'node_modules', '@siddharthakatiyar', 'contextos');
      fs.mkdirSync(packageRoot, { recursive: true });
      const plan = createUpgradeInstallPlan(packageRoot, fs.realpathSync(globalRoot), '1.4.0');

      expect(plan.kind).toBe('global-npm');
      expect(plan.command).toBe('npm install -g @siddharthakatiyar/contextos@1.4.0');
    } finally {
      fs.rmSync(tempParent, { recursive: true, force: true });
    }
  });

  it('keeps source checkouts and ambiguous installs on their own workflow', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-source-plan-'));
    try {
      const sourceRoot = path.join(tempRoot, 'source');
      fs.mkdirSync(path.join(sourceRoot, '.git'), { recursive: true });
      const sourcePlan = createUpgradeInstallPlan(sourceRoot, null, '1.4.0');
      expect(sourcePlan.kind).toBe('source-checkout');
      expect(sourcePlan.guidance).toContain('git show v1.4.0');

      const fixture = makeLocalPlanFixture('npm');
      try {
        fs.writeFileSync(path.join(fixture.projectRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9');
        const ambiguousPlan = createUpgradeInstallPlan(
          fixture.packageRoot,
          null,
          '1.4.0',
          fixture.projectRoot
        );
        expect(ambiguousPlan.kind).toBe('unknown');
        expect(ambiguousPlan.command).toBeNull();
      } finally {
        fixture.cleanup();
      }
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('upgrade staging and rollback workflow', () => {
  it('stops, swaps, verifies, and restarts each daemon once', async () => {
    const plan = makePlan();
    const adapters = makeAdapters(plan);

    await expect(runUpgradeWorkflow(plan, adapters)).resolves.toEqual({
      upgraded: true,
      rolledBack: false
    });

    expect(adapters.requestDaemon).toHaveBeenCalledTimes(2);
    expect(adapters.waitForExit).toHaveBeenCalledOnce();
    expect(adapters.startDaemon).toHaveBeenCalledOnce();
    expect(adapters.waitForDaemonVersion).toHaveBeenCalledOnce();
    expect(adapters.remove).toHaveBeenCalledWith(plan.backupPackageRoot);
  });

  it('restores the package and restarts stopped daemons if the staged rename fails', async () => {
    const plan = makePlan();
    const rename = vi.fn(async (from: string) => {
      if (from === plan.stagedPackageRoot) throw new Error('staged rename failed');
    });
    const adapters = makeAdapters(plan, { rename });

    await expect(runUpgradeWorkflow(plan, adapters)).rejects.toThrow('staged rename failed');

    expect(rename).toHaveBeenNthCalledWith(1, plan.packageRoot, plan.backupPackageRoot);
    expect(rename).toHaveBeenNthCalledWith(2, plan.stagedPackageRoot, plan.packageRoot);
    expect(rename).toHaveBeenNthCalledWith(3, plan.backupPackageRoot, plan.packageRoot);
    expect(adapters.startDaemon).toHaveBeenCalledOnce();
    expect(adapters.waitForDaemonVersion).toHaveBeenCalledWith(
      plan.daemons[0]!.projectDir,
      5678,
      plan.currentVersion,
      plan.token
    );
  });

  it('restores the previous package if the installed target fails verification', async () => {
    const plan = makePlan({ daemons: [] });
    const verifyCli = vi.fn(
      async (_root: string, version: string) => version === plan.currentVersion
    );
    const rename = vi.fn(async () => {});
    const remove = vi.fn(async () => {});
    const adapters = makeAdapters(plan, { verifyCli, rename, remove });

    await expect(runUpgradeWorkflow(plan, adapters)).rejects.toThrow(
      /previous package was restored/i
    );

    expect(verifyCli).toHaveBeenNthCalledWith(1, plan.packageRoot, plan.targetVersion);
    expect(rename).toHaveBeenNthCalledWith(1, plan.packageRoot, plan.backupPackageRoot);
    expect(rename).toHaveBeenNthCalledWith(2, plan.stagedPackageRoot, plan.packageRoot);
    expect(rename).toHaveBeenNthCalledWith(
      3,
      plan.packageRoot,
      `${plan.packageRoot}.failed-${process.pid}`
    );
    expect(rename).toHaveBeenNthCalledWith(4, plan.backupPackageRoot, plan.packageRoot);
    expect(verifyCli).toHaveBeenNthCalledWith(2, plan.packageRoot, plan.currentVersion);
    expect(remove).toHaveBeenCalledWith(`${plan.packageRoot}.failed-${process.pid}`);
  });
});
