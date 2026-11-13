import { Command } from 'commander';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { compareVersions } from '../../core/updater/index.js';
import { createUpgradeLock } from '../../core/updater/upgrade-lock.js';
import {
  getDaemonControlSocketPath,
  assertNoSymlinkInPath,
  ensurePrivateStateDir,
  unixSocketPath
} from '../../utils/secure-state.js';

const PACKAGE_NAME = '@siddharthakatiyar/contextos';
const PACKAGE_PARTS = ['@siddharthakatiyar', 'contextos'];
const PACKAGE_REGISTRY_URL = 'https://registry.npmjs.org/@siddharthakatiyar%2Fcontextos';
const DAEMON_STOP_TIMEOUT_MS = 30 * 60 * 1000;
const PLAN_FETCH_TIMEOUT_MS = 15_000;

export interface UpgradeDaemon {
  pid: number;
  projectDir: string;
  version: string;
  legacy?: boolean;
}

export interface UpgradeWorkflowPlan {
  packageRoot: string;
  stagedPackageRoot: string;
  backupPackageRoot: string;
  targetVersion: string;
  currentVersion: string;
  token: string;
  daemons: UpgradeDaemon[];
}

/** Narrow filesystem/process boundary so swap and rollback behavior can be tested without npm. */
export interface UpgradeWorkflowAdapters {
  rename(from: string, to: string): Promise<void>;
  remove(pathname: string): Promise<void>;
  verifyCli(packageRoot: string, expectedVersion: string): Promise<boolean>;
  requestDaemon(
    daemon: UpgradeDaemon,
    action: 'get-version' | 'prepare-upgrade',
    token: string,
    expectedVersion?: string
  ): Promise<{ ok: boolean; version?: string; error?: string }>;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  startDaemon(projectDir: string, packageRoot: string, token: string): Promise<number>;
  waitForDaemonVersion(
    projectDir: string,
    pid: number,
    version: string,
    token: string
  ): Promise<boolean>;
  processAlive(pid: number): boolean;
  beforeSwap?(): Promise<void>;
}

export interface UpgradeWorkflowResult {
  upgraded: boolean;
  rolledBack: boolean;
}

export type AutoPatchResult =
  | { status: 'current'; currentVersion: string }
  | {
      status: 'skipped';
      reason: string;
      currentVersion?: string;
      latestVersion?: string;
      /** True when this attempt already contacted the registry. */
      registryCheckAttempted?: boolean;
    }
  | { status: 'updated'; currentVersion: string; targetVersion: string };

export interface AutoPatchRuntime {
  platform: string;
  resolveInstalledPackage(): { packageRoot: string; currentVersion: string };
  resolveGlobalNpmRoot(): string | null;
  fetchPublishedVersions(): Promise<string[]>;
  hasActivePackageProcess(packageRoot: string): boolean;
  installVersion(packageRoot: string, currentVersion: string, targetVersion: string): Promise<void>;
}

export class UpgradeRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeRecoveryError';
  }
}

/**
 * Stop only daemons that have verified the private control protocol, swap the
 * staged package directory, then verify/restart. Any post-swap failure attempts
 * to restore the exact previous package tree before restarting old daemons.
 */
export async function runUpgradeWorkflow(
  plan: UpgradeWorkflowPlan,
  adapters: UpgradeWorkflowAdapters
): Promise<UpgradeWorkflowResult> {
  const stopped: UpgradeDaemon[] = [];
  const newDaemons = new Map<string, UpgradeDaemon>();
  let swapped = false;
  let originalMovedToBackup = false;
  const daemonKey = (daemon: UpgradeDaemon) => daemon.projectDir;

  const stopDaemon = async (daemon: UpgradeDaemon, expectedVersion: string) => {
    const response = await adapters.requestDaemon(
      daemon,
      'prepare-upgrade',
      plan.token,
      expectedVersion
    );
    if (!response.ok || response.version !== expectedVersion) {
      throw new Error(
        `Daemon ${daemon.pid} could not confirm a safe shutdown${response.error ? `: ${response.error}` : '.'}`
      );
    }
    if (!stopped.some((item) => item.pid === daemon.pid)) stopped.push(daemon);
    if (!(await adapters.waitForExit(daemon.pid, DAEMON_STOP_TIMEOUT_MS))) {
      throw new Error(`Daemon ${daemon.pid} did not exit after finishing active indexing.`);
    }
  };

  const restartOldDaemons = async () => {
    for (const daemon of stopped) {
      if (adapters.processAlive(daemon.pid)) {
        throw new Error(
          `Daemon ${daemon.pid} has not exited; refusing to start a duplicate or replace its package files.`
        );
      }
      const pid = await adapters.startDaemon(daemon.projectDir, plan.packageRoot, plan.token);
      if (
        !(await adapters.waitForDaemonVersion(
          daemon.projectDir,
          pid,
          plan.currentVersion,
          plan.token
        ))
      ) {
        throw new Error(`The previous daemon for ${daemon.projectDir} did not restart cleanly.`);
      }
    }
  };

  try {
    for (const daemon of plan.daemons) {
      const current = await adapters.requestDaemon(daemon, 'get-version', plan.token);
      if (!current.ok || current.version !== plan.currentVersion) {
        throw new Error(
          `Daemon ${daemon.pid} is not running the installed CLI version or lacks the safe-upgrade control protocol. Stop it manually, then retry.`
        );
      }
    }
    for (const daemon of plan.daemons) {
      await stopDaemon(daemon, plan.currentVersion);
    }

    await adapters.beforeSwap?.();

    await adapters.rename(plan.packageRoot, plan.backupPackageRoot);
    originalMovedToBackup = true;
    try {
      await adapters.rename(plan.stagedPackageRoot, plan.packageRoot);
      swapped = true;
    } catch (error) {
      await adapters.rename(plan.backupPackageRoot, plan.packageRoot);
      originalMovedToBackup = false;
      throw error;
    }

    if (!(await adapters.verifyCli(plan.packageRoot, plan.targetVersion))) {
      throw new Error(`Installed CLI did not report version ${plan.targetVersion}.`);
    }

    const upgradedDaemons = stopped.filter((daemon) => !daemon.legacy);
    if (
      stopped.some((daemon) => daemon.legacy) &&
      !upgradedDaemons.some(
        (daemon) => daemon.projectDir === path.join(os.homedir(), '.contextos', 'runtime')
      )
    ) {
      upgradedDaemons.push({
        ...stopped[0],
        projectDir: path.join(os.homedir(), '.contextos', 'runtime'),
        legacy: false
      });
    }
    for (const daemon of upgradedDaemons) {
      const pid = await adapters.startDaemon(daemon.projectDir, plan.packageRoot, plan.token);
      newDaemons.set(daemonKey(daemon), { ...daemon, pid, version: plan.targetVersion });
      if (
        !(await adapters.waitForDaemonVersion(
          daemon.projectDir,
          pid,
          plan.targetVersion,
          plan.token
        ))
      ) {
        throw new Error(
          `The upgraded daemon for ${daemon.projectDir} did not report ${plan.targetVersion}.`
        );
      }
    }

    await adapters.remove(plan.backupPackageRoot);
    return { upgraded: true, rolledBack: false };
  } catch (error) {
    if (!swapped) {
      if (originalMovedToBackup) {
        try {
          await adapters.rename(plan.backupPackageRoot, plan.packageRoot);
          originalMovedToBackup = false;
        } catch (restoreError) {
          throw new UpgradeRecoveryError(
            `${error instanceof Error ? error.message : String(error)} The previous package remains at ${plan.backupPackageRoot}; automatic restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}. No daemon restart was attempted.`
          );
        }
        if (!(await adapters.verifyCli(plan.packageRoot, plan.currentVersion))) {
          throw new UpgradeRecoveryError(
            `${error instanceof Error ? error.message : String(error)} The previous package was restored at ${plan.packageRoot}, but its CLI version could not be verified. No daemon restart was attempted.`
          );
        }
      }
      try {
        await restartOldDaemons();
      } catch (restartError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)} Previous package is intact, but a stopped daemon could not restart: ${restartError instanceof Error ? restartError.message : String(restartError)}`
        );
      }
      throw error;
    }

    // Never rename the installed tree away while a new-version daemon may still
    // be executing it. If it cannot be drained, preserve both trees for recovery.
    if (newDaemons.size > 0) {
      for (const daemon of newDaemons.values()) {
        if (!adapters.processAlive(daemon.pid)) continue;
        try {
          await adapters.requestDaemon(daemon, 'prepare-upgrade', plan.token, plan.targetVersion);
          await adapters.waitForExit(daemon.pid, DAEMON_STOP_TIMEOUT_MS);
        } catch {
          // The rollback guard below reports the preserved backup path.
        }
      }
    }
    if ([...newDaemons.values()].some((daemon) => adapters.processAlive(daemon.pid))) {
      throw new UpgradeRecoveryError(
        `${error instanceof Error ? error.message : String(error)} A daemon may still be using the upgraded files; rollback was withheld. Previous package backup: ${plan.backupPackageRoot}`
      );
    }

    const failedPackageRoot = `${plan.packageRoot}.failed-${process.pid}`;
    try {
      await adapters.rename(plan.packageRoot, failedPackageRoot);
      await adapters.rename(plan.backupPackageRoot, plan.packageRoot);
      if (!(await adapters.verifyCli(plan.packageRoot, plan.currentVersion))) {
        throw new Error('Restored CLI did not report the previous version.');
      }
      await adapters.remove(failedPackageRoot);
      await restartOldDaemons();
    } catch (rollbackError) {
      throw new UpgradeRecoveryError(
        `${error instanceof Error ? error.message : String(error)} Rollback needs attention: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}. Previous package backup: ${plan.backupPackageRoot}`
      );
    }
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} The previous package was restored and its daemons restarted.`
    );
  }
}

/** Parse only exact, stable semver versions suitable for an npm release selection. */
export function parseStableVersion(
  input: string
): { major: number; minor: number; patch: number } | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(input.trim());
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  return { major: values[0]!, minor: values[1]!, patch: values[2]! };
}

/** Select only a higher stable patch in the installed major and minor line. */
export function selectAutoPatchVersion(
  currentVersion: string,
  publishedVersions: string[]
): string | null {
  const current = parseStableVersion(currentVersion);
  if (!current) return null;
  const candidates = [...new Set(publishedVersions)].filter((version) => {
    const parsed = parseStableVersion(version);
    return (
      parsed !== null &&
      parsed.major === current.major &&
      parsed.minor === current.minor &&
      parsed.patch > current.patch
    );
  });
  candidates.sort((left, right) => compareVersions(left, right) ?? 0);
  return candidates.at(-1) ?? null;
}

function latestStableVersion(currentVersion: string, publishedVersions: string[]): string | null {
  const candidates = [...new Set(publishedVersions)].filter(
    (version) =>
      parseStableVersion(version) !== null && compareVersions(version, currentVersion)! > 0
  );
  candidates.sort((left, right) => compareVersions(left, right) ?? 0);
  return candidates.at(-1) ?? null;
}

export function selectUpgradeVersion(
  currentVersion: string,
  publishedVersions: string[],
  requestedVersion?: string,
  allowMajor = false
): string {
  const current = parseStableVersion(currentVersion);
  if (!current)
    throw new Error(`Installed version ${currentVersion} is not a stable semantic version.`);

  const stable = [
    ...new Set(publishedVersions.filter((version) => parseStableVersion(version)))
  ].sort((left, right) => compareVersions(left, right) ?? 0);
  const selected = requestedVersion
    ? parseStableVersion(requestedVersion)
      ? requestedVersion.trim()
      : null
    : [...stable].reverse().find((version) => {
        const parsed = parseStableVersion(version)!;
        return (
          (allowMajor || parsed.major === current.major) &&
          compareVersions(version, currentVersion)! > 0
        );
      });

  if (!selected || !stable.includes(selected)) {
    throw new Error(
      requestedVersion
        ? `Version ${requestedVersion} is not a published stable release.`
        : 'No newer compatible stable release was found.'
    );
  }
  const target = parseStableVersion(selected)!;
  if (compareVersions(selected, currentVersion)! <= 0) {
    throw new Error(
      `Version ${selected} is not newer than the installed version ${currentVersion}.`
    );
  }
  if (!allowMajor && target.major !== current.major) {
    throw new Error(
      `Version ${selected} changes the major version. Re-run with --allow-major to confirm.`
    );
  }
  return selected;
}

export type UpgradeInstallKind =
  'global-npm' | 'local-npm' | 'local-pnpm' | 'local-yarn' | 'source-checkout' | 'unknown';

export interface UpgradeInstallPlan {
  kind: UpgradeInstallKind;
  projectRoot: string | null;
  command: string | null;
  guidance: string;
}

interface ConsumerManifest {
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  packageManager?: unknown;
}

type DependencyDeclaration =
  | { status: 'supported'; bucket: 'dependencies' | 'devDependencies' }
  | { status: 'unsupported'; reason: string };

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === '';
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function isInsideNodeModules(directory: string): boolean {
  let current = path.resolve(directory);
  while (true) {
    if (path.basename(current).toLowerCase() === 'node_modules') return true;
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function readConsumerManifest(projectRoot: string): ConsumerManifest | null {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')
    ) as ConsumerManifest;
  } catch {
    return null;
  }
}

function isSimpleSemverTerm(term: string): boolean {
  const match = /^(?:<=|>=|<|>|=|\^|~)?(v?)([^\s]+)$/.exec(term);
  if (!match) return false;

  const hasVPrefix = match[1] === 'v';
  const components = match[2]!.split('.');
  if (components.length === 0 || components.length > 3) return false;

  let wildcardFound = false;
  for (let index = 0; index < components.length; index++) {
    const component = components[index]!;
    if (/^(?:x|\*)$/i.test(component)) {
      wildcardFound = true;
      continue;
    }
    if (wildcardFound || !/^(?:0|[1-9]\d*)$/.test(component)) return false;
    if (!Number.isSafeInteger(Number(component))) return false;
  }

  if (hasVPrefix && wildcardFound) return false;
  return true;
}

function isKnownRegistrySpecifier(spec: string): boolean {
  if (!spec || spec !== spec.trim() || spec.length > 128) return false;

  const rangeTerms = spec.split(/\s+/);
  if (rangeTerms.length <= 4 && rangeTerms.every(isSimpleSemverTerm)) return true;

  // Bare npm dist-tags may contain letters, digits, dots, underscores, and
  // hyphens. Protocols, aliases, host shorthands, and URL paths are excluded.
  return /^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(spec) && !isSimpleSemverTerm(spec);
}

function dependencyDeclaration(manifest: ConsumerManifest): DependencyDeclaration | null {
  const declarations = (
    [
      ['dependencies', manifest.dependencies],
      ['devDependencies', manifest.devDependencies],
      ['optionalDependencies', manifest.optionalDependencies],
      ['peerDependencies', manifest.peerDependencies]
    ] as const
  ).flatMap(([bucket, dependencies]) => {
    const spec = dependencies?.[PACKAGE_NAME];
    return spec === undefined ? [] : [{ bucket, spec }];
  });

  if (declarations.length === 0) return null;
  if (declarations.length > 1) {
    return {
      status: 'unsupported',
      reason:
        'The package is declared in multiple dependency buckets, so no update command was inferred.'
    };
  }

  const declaration = declarations[0]!;
  if (typeof declaration.spec !== 'string' || !isKnownRegistrySpecifier(declaration.spec)) {
    return {
      status: 'unsupported',
      reason:
        'The package spec is not a simple semver range or bare npm dist-tag; protocols, aliases, host shorthands, and complex ranges require its native update workflow.'
    };
  }
  if (declaration.bucket === 'optionalDependencies' || declaration.bucket === 'peerDependencies') {
    return {
      status: 'unsupported',
      reason: `The package is declared in ${declaration.bucket}; no update command was inferred because that bucket needs separate handling.`
    };
  }
  return { status: 'supported', bucket: declaration.bucket };
}

function lockfileManager(
  projectRoot: string,
  manifest: ConsumerManifest
): 'npm' | 'pnpm' | 'yarn' | null {
  const managers: Array<'npm' | 'pnpm' | 'yarn'> = [];
  if (
    fs.existsSync(path.join(projectRoot, 'package-lock.json')) ||
    fs.existsSync(path.join(projectRoot, 'npm-shrinkwrap.json'))
  ) {
    managers.push('npm');
  }
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) managers.push('pnpm');
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) managers.push('yarn');
  if (managers.length !== 1) return null;

  if (typeof manifest.packageManager === 'string') {
    const declaredManager = /^(npm|pnpm|yarn)@/.exec(manifest.packageManager)?.[1];
    if (!declaredManager || declaredManager !== managers[0]) return null;
  }
  return managers[0]!;
}

function consumerRoots(packageRoot: string, cwd: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  current = path.dirname(path.resolve(packageRoot));
  while (true) {
    if (path.basename(current).toLowerCase() === 'node_modules') {
      roots.push(path.dirname(current));
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...new Set(roots)];
}

function isGitCheckout(packageRoot: string): boolean {
  return fs.existsSync(path.join(packageRoot, '.git'));
}

/**
 * Describe an install without modifying it. Local plans are emitted only when
 * the consumer declares this package, its lockfile identifies one package
 * manager, and that manager's installed package path resolves to this CLI.
 */
export function createUpgradeInstallPlan(
  packageRoot: string,
  globalNpmRoot: string | null,
  targetVersion: string,
  cwd = process.cwd()
): UpgradeInstallPlan {
  let canonicalPackageRoot = path.resolve(packageRoot);
  try {
    canonicalPackageRoot = fs.realpathSync(canonicalPackageRoot);
  } catch {
    // Keep a resolved fallback so missing or unreadable paths still fail closed below.
  }
  const registrySpec = `${PACKAGE_NAME}@${targetVersion}`;

  if (isGitCheckout(canonicalPackageRoot)) {
    return {
      kind: 'source-checkout',
      projectRoot: canonicalPackageRoot,
      command: null,
      guidance: `Review the selected release before changing source: run \`git fetch --tags origin\`, inspect \`git show v${targetVersion}\`, then build from a separate clean checkout with \`npm ci\` and \`npm run build\`.`
    };
  }

  if (globalNpmRoot) {
    const globalPackageRoot = path.join(globalNpmRoot, ...PACKAGE_PARTS);
    try {
      if (
        !fs.lstatSync(globalPackageRoot).isSymbolicLink() &&
        samePath(fs.realpathSync(globalPackageRoot), canonicalPackageRoot)
      ) {
        return {
          kind: 'global-npm',
          projectRoot: null,
          command: `npm install -g ${registrySpec}`,
          guidance:
            'Run the command from a shell using the npm account that owns this global install.'
        };
      }
    } catch {
      // A missing or unreadable global package root is not enough to claim this is a global install.
    }
  }

  for (const projectRoot of consumerRoots(canonicalPackageRoot, cwd)) {
    if (isInsideNodeModules(projectRoot)) continue;
    const manifest = readConsumerManifest(projectRoot);
    if (!manifest) continue;
    const manager = lockfileManager(projectRoot, manifest);
    if (!manager) continue;

    const installedPath = path.join(projectRoot, 'node_modules', ...PACKAGE_PARTS);
    try {
      const installedStats = fs.lstatSync(installedPath);
      const canonicalInstalledPath = fs.realpathSync(installedPath);
      if (!samePath(canonicalInstalledPath, canonicalPackageRoot)) continue;

      if (installedStats.isSymbolicLink()) {
        if (manager !== 'pnpm') continue;
        const pnpmStore = fs.realpathSync(path.join(projectRoot, 'node_modules', '.pnpm'));
        if (!isPathWithin(pnpmStore, canonicalInstalledPath)) continue;
      }

      const declaration = dependencyDeclaration(manifest);
      if (!declaration) {
        return {
          kind: 'unknown',
          projectRoot,
          command: null,
          guidance:
            'The installed package is not declared in the consumer manifest, so no update command was inferred.'
        };
      }
      if (declaration.status === 'unsupported') {
        return {
          kind: 'unknown',
          projectRoot,
          command: null,
          guidance: declaration.reason
        };
      }

      const saveBucketFlag =
        declaration.bucket === 'devDependencies'
          ? manager === 'yarn'
            ? '--dev'
            : '--save-dev'
          : null;
      const exactFlag = manager === 'yarn' ? '--exact' : '--save-exact';
      const command = `${manager} ${manager === 'npm' ? 'install' : 'add'} ${[
        saveBucketFlag,
        exactFlag,
        registrySpec
      ]
        .filter(Boolean)
        .join(' ')}`;
      return {
        kind: `local-${manager}`,
        projectRoot,
        command,
        guidance:
          'Run the command from the listed project directory to update its manifest and lockfile together.'
      };
    } catch {
      // This path may be a workspace, link, or package-manager store entry; keep looking conservatively.
    }
  }

  return {
    kind: 'unknown',
    projectRoot: null,
    command: null,
    guidance:
      "The package path did not match a declared dependency and one supported lockfile. Use the installation's native update workflow; no manager command was inferred."
  };
}

export function formatUpgradeInstallPlan(plan: UpgradeInstallPlan, targetVersion: string): string {
  const labels: Record<UpgradeInstallKind, string> = {
    'global-npm': 'global npm install',
    'local-npm': 'local npm dependency',
    'local-pnpm': 'local pnpm dependency',
    'local-yarn': 'local Yarn dependency',
    'source-checkout': 'source checkout',
    unknown: 'unknown or linked installation'
  };
  const lines = [
    `Upgrade plan for ${PACKAGE_NAME}`,
    `Target version: ${targetVersion}`,
    `Install type: ${labels[plan.kind]}`
  ];
  if (plan.projectRoot) lines.push(`Working directory: ${JSON.stringify(plan.projectRoot)}`);
  if (plan.command) lines.push(`Command: ${plan.command}`);
  lines.push(
    plan.guidance,
    'Automatic package replacement remains limited to Linux global npm installs.',
    'This is a read-only plan; no package files or daemons were changed.'
  );
  return `${lines.join('\n')}\n`;
}

async function fetchPublishedVersions(timeoutMs = PLAN_FETCH_TIMEOUT_MS): Promise<string[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(PACKAGE_REGISTRY_URL, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('versions' in body) ||
      typeof body.versions !== 'object' ||
      body.versions === null ||
      Array.isArray(body.versions)
    ) {
      throw new Error('npm registry returned an invalid release list');
    }
    return Object.keys(body.versions);
  } finally {
    clearTimeout(timeout);
  }
}

function tryGetGlobalNpmRoot(): string | null {
  try {
    const root = childProcess
      .execSync('npm root -g', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 30_000
      })
      .trim();
    return root ? fs.realpathSync(root) : null;
  } catch {
    return null;
  }
}

function run(
  command: string,
  args: string[],
  timeout = 5 * 60 * 1000,
  env: NodeJS.ProcessEnv = process.env
): string {
  return childProcess
    .execFileSync(command, args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      env,
      maxBuffer: 16 * 1024 * 1024
    })
    .trim();
}

function findPackageRoot(start: string): string {
  let current = path.resolve(start);
  while (true) {
    const manifest = path.join(current, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')) as {
        name?: string;
        version?: string;
      };
      if (pkg.name === PACKAGE_NAME && typeof pkg.version === 'string')
        return fs.realpathSync(current);
    } catch {
      // Continue up through the compiled package layout.
    }
    const parent = path.dirname(current);
    if (parent === current)
      throw new Error(`Could not locate the installed ${PACKAGE_NAME} package.`);
    current = parent;
  }
}

interface ProcEntry {
  pid: number;
  projectDir: string;
  daemon: boolean;
}

function resolveArgPath(value: string, cwd: string): string | null {
  if (!path.isAbsolute(value) && !value.includes(path.sep)) return null;
  try {
    return fs.realpathSync(path.isAbsolute(value) ? value : path.resolve(cwd, value));
  } catch {
    return path.resolve(cwd, value);
  }
}

/** Detect argv references through absolute paths, relative script paths, and symlinks. */
export function processReferencesPackage(
  args: string[],
  cwd: string,
  packageRoot: string
): boolean {
  const root = path.resolve(packageRoot);
  const packagePrefix = `${root}${path.sep}`;
  let canonicalCwd: string;
  try {
    canonicalCwd = fs.realpathSync(cwd);
  } catch {
    canonicalCwd = path.resolve(cwd);
  }
  if (canonicalCwd === root || canonicalCwd.startsWith(packagePrefix)) return true;
  return args.some((arg) => {
    const resolved = resolveArgPath(arg, canonicalCwd);
    return resolved === root || (resolved?.startsWith(packagePrefix) ?? false);
  });
}

function scanPackageProcesses(packageRoot: string): ProcEntry[] {
  const entries: ProcEntry[] = [];
  const sharedDir = path.join(os.homedir(), '.contextos', 'runtime');
  let sharedPid = 0;
  try {
    sharedPid = Number(fs.readFileSync(path.join(sharedDir, 'daemon.pid'), 'utf8').trim());
  } catch {
    // A shared daemon is optional.
  }
  const procEntries = fs.readdirSync('/proc', { withFileTypes: true });
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid) continue;
    const procDir = path.join('/proc', entry.name);
    let args: string[];
    let cwd: string;
    try {
      args = fs
        .readFileSync(path.join(procDir, 'cmdline'))
        .toString('utf8')
        .split('\0')
        .filter(Boolean);
      cwd = fs.realpathSync(path.join(procDir, 'cwd'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(
        `Could not inspect process ${pid}; refusing to replace package files safely.`
      );
    }
    if (args.length === 0) continue;
    const referencesPackage = processReferencesPackage(args, cwd, packageRoot);
    if (!referencesPackage) continue;

    let projectDir: string;
    let daemon = false;
    try {
      const env = fs.readFileSync(path.join(procDir, 'environ')).toString('utf8').split('\0');
      const envRoot = env
        .find((value) => value.startsWith('CONTEXTOS_REPO_ROOT='))
        ?.slice('CONTEXTOS_REPO_ROOT='.length);
      projectDir = envRoot || cwd;
      daemon = args.some((arg, index) => arg === 'daemon' && args[index + 1] === 'start');
      if (daemon && pid === sharedPid) projectDir = sharedDir;
    } catch {
      projectDir = '';
    }
    entries.push({ pid, projectDir, daemon });
  }
  return entries;
}

function runVersion(packageRoot: string, expectedVersion: string): boolean {
  try {
    const cliPath = path.join(packageRoot, 'dist', 'bin', 'contextos.js');
    return run(process.execPath, [cliPath, '--version'], 30_000) === expectedVersion;
  } catch {
    return false;
  }
}

function requestDaemon(
  projectDir: string,
  action: 'get-version' | 'prepare-upgrade',
  token: string,
  expectedVersion?: string
): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    let response = '';
    const sharedDir = path.join(os.homedir(), '.contextos', 'runtime');
    const socketPath =
      projectDir === sharedDir && process.platform !== 'win32'
        ? unixSocketPath(sharedDir, 'daemon.sock')
        : getDaemonControlSocketPath(projectDir);
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      finish({ ok: false, error: 'daemon control request timed out' });
    }, DAEMON_STOP_TIMEOUT_MS);
    const finish = (result: { ok: boolean; version?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ action, token, expectedVersion })}\n`);
    });
    socket.on('data', (chunk) => {
      response += chunk.toString('utf8');
      const newline = response.indexOf('\n');
      if (newline < 0) return;
      try {
        finish(
          JSON.parse(response.slice(0, newline)) as {
            ok: boolean;
            version?: string;
            error?: string;
          }
        );
      } catch {
        finish({ ok: false, error: 'invalid daemon control response' });
      }
    });
    socket.once('error', (error) => finish({ ok: false, error: error.message }));
    socket.once('close', () => {
      if (!settled)
        finish({ ok: false, error: 'daemon closed the control connection without a response' });
    });
  });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

async function waitForDaemonVersion(
  projectDir: string,
  pid: number,
  expectedVersion: string,
  token: string
): Promise<boolean> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return false;
    const response = await requestDaemon(projectDir, 'get-version', token);
    if (response.ok) return response.version === expectedVersion;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function startDaemon(
  projectDir: string,
  packageRoot: string,
  token: string
): Promise<number> {
  if (projectDir === path.join(os.homedir(), '.contextos', 'runtime'))
    ensurePrivateStateDir(projectDir);
  const cliPath = path.join(packageRoot, 'dist', 'bin', 'contextos.js');
  const child = childProcess.spawn(process.execPath, [cliPath, 'daemon', 'start'], {
    cwd: projectDir,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CONTEXTOS_REPO_ROOT: projectDir, CONTEXTOS_UPGRADE_TOKEN: token }
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  if (!child.pid) throw new Error(`Could not start daemon for ${projectDir}.`);
  return child.pid;
}

function defaultAdapters(): UpgradeWorkflowAdapters {
  return {
    rename: async (from, to) => fs.promises.rename(from, to),
    remove: async (pathname) => fs.promises.rm(pathname, { recursive: true, force: true }),
    verifyCli: async (root, version) => runVersion(root, version),
    requestDaemon: async (daemon, action, token, expectedVersion) =>
      requestDaemon(daemon.projectDir, action, token, expectedVersion),
    waitForExit,
    startDaemon,
    waitForDaemonVersion,
    processAlive
  };
}

async function installSelectedVersion(
  packageRoot: string,
  currentVersion: string,
  targetVersion: string,
  automatic: boolean
): Promise<void> {
  const scopeRoot = path.dirname(packageRoot);
  const stagePrefix = fs.mkdtempSync(
    path.join(scopeRoot, `.contextos-upgrade-stage-${process.pid}-`)
  );
  const stagedPackageRoot = path.join(stagePrefix, 'lib', 'node_modules', ...PACKAGE_PARTS);
  const backupPackageRoot = `${packageRoot}.backup-${process.pid}-${Date.now()}`;
  let lock: ReturnType<typeof createUpgradeLock> | undefined;
  let workflowCompleted = false;
  let operationFailed = false;
  let operationError: unknown;
  try {
    const installTimeout = automatic ? 120_000 : 10 * 60 * 1000;
    try {
      run(
        'npm',
        [
          'install',
          '--global',
          '--prefix',
          stagePrefix,
          '--no-audit',
          '--no-fund',
          `${PACKAGE_NAME}@${targetVersion}`
        ],
        installTimeout,
        { ...process.env, CONTEXTOS_SUPPRESS_INSTALL_NOTICE: '1' }
      );
    } catch (error) {
      throw new Error(
        `Could not stage ${targetVersion}; the installed version was left unchanged. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const stagedManifest = JSON.parse(
      fs.readFileSync(path.join(stagedPackageRoot, 'package.json'), 'utf8')
    ) as { version?: string };
    if (stagedManifest.version !== targetVersion || !runVersion(stagedPackageRoot, targetVersion)) {
      throw new Error(
        `Staged package did not verify as ${targetVersion}; the installed version was left unchanged.`
      );
    }

    lock = createUpgradeLock();
    const processEntries = scanPackageProcesses(packageRoot);
    if (automatic && processEntries.length > 0) {
      throw new Error(
        `Another ContextOS process is using this package. Close active ContextOS clients and retry; no files were changed.`
      );
    }

    const daemons: UpgradeDaemon[] = [];
    if (!automatic) {
      for (const entry of processEntries) {
        if (!entry.daemon || !entry.projectDir) {
          throw new Error(
            `Process ${entry.pid} is using this ContextOS package but is not a verifiable daemon. Close active ContextOS clients and retry; no files were changed.`
          );
        }
        const sharedDir = path.join(os.homedir(), '.contextos', 'runtime');
        const pidPath =
          entry.projectDir === sharedDir
            ? path.join(sharedDir, 'daemon.pid')
            : path.join(entry.projectDir, '.contextos', 'daemon.pid');
        try {
          assertNoSymlinkInPath(pidPath);
          const recordedPid = Number(fs.readFileSync(pidPath, 'utf8').trim());
          if (recordedPid !== entry.pid) throw new Error('PID file does not identify this process');
        } catch {
          throw new Error(
            `Could not verify daemon process ${entry.pid} in ${entry.projectDir}; no files were changed.`
          );
        }
        daemons.push({
          pid: entry.pid,
          projectDir: entry.projectDir,
          version: currentVersion,
          legacy: entry.projectDir !== sharedDir
        });
      }
    }

    const adapters = defaultAdapters();
    if (automatic) {
      adapters.beforeSwap = async () => {
        if (scanPackageProcesses(packageRoot).length > 0) {
          throw new Error(
            'Another ContextOS process started before the package swap. No files were changed.'
          );
        }
      };
    }
    await runUpgradeWorkflow(
      {
        packageRoot,
        stagedPackageRoot,
        backupPackageRoot,
        targetVersion,
        currentVersion,
        token: lock.token,
        daemons
      },
      adapters
    );
    workflowCompleted = true;
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let lockReleaseError: unknown;
  try {
    lock?.release();
  } catch (error) {
    lockReleaseError = error;
  }
  let stageCleanupError: unknown;
  try {
    await fs.promises.rm(stagePrefix, { recursive: true, force: true });
  } catch (error) {
    stageCleanupError = error;
  }

  if (lockReleaseError) {
    throw new UpgradeRecoveryError(
      `${workflowCompleted ? 'The package update completed' : 'The upgrade stopped before commit'}, but its lock could not be released: ${lockReleaseError instanceof Error ? lockReleaseError.message : String(lockReleaseError)}. The lock may block other commands. No server was started; inspect the lock and remove it only after confirming no upgrade is running.`
    );
  }
  if (stageCleanupError) {
    process.stderr.write(
      `[ContextOS] Could not remove temporary upgrade files at ${stagePrefix}: ${stageCleanupError instanceof Error ? stageCleanupError.message : String(stageCleanupError)}\n`
    );
  }
  if (operationFailed) throw operationError;
}

const AUTO_FETCH_TIMEOUT_MS = 2_500;

function defaultAutoPatchRuntime(): AutoPatchRuntime {
  return {
    platform: process.platform,
    resolveInstalledPackage() {
      const modulePath = fileURLToPath(import.meta.url);
      const packageRoot = findPackageRoot(path.dirname(modulePath));
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
      ) as { version: string };
      return { packageRoot, currentVersion: manifest.version };
    },
    resolveGlobalNpmRoot: tryGetGlobalNpmRoot,
    fetchPublishedVersions: () => fetchPublishedVersions(AUTO_FETCH_TIMEOUT_MS),
    hasActivePackageProcess: (packageRoot) => scanPackageProcesses(packageRoot).length > 0,
    installVersion: (packageRoot, currentVersion, targetVersion) =>
      installSelectedVersion(packageRoot, currentVersion, targetVersion, true)
  };
}

export async function runAutoPatchBeforeServe(
  runtime: AutoPatchRuntime = defaultAutoPatchRuntime()
): Promise<AutoPatchResult> {
  if (runtime.platform !== 'linux') {
    return {
      status: 'skipped',
      reason: 'Automatic package installation is supported on Linux only.'
    };
  }

  let currentVersion: string | undefined;
  let latestVersion: string | undefined;
  let registryCheckAttempted = false;
  try {
    const installed = runtime.resolveInstalledPackage();
    currentVersion = installed.currentVersion;
    if (!parseStableVersion(currentVersion)) {
      return {
        status: 'skipped',
        currentVersion,
        reason: `Installed version ${currentVersion} is not a stable release.`
      };
    }

    const globalRoot = runtime.resolveGlobalNpmRoot();
    if (!globalRoot) {
      return {
        status: 'skipped',
        currentVersion,
        reason: 'This is not a recognized global npm installation.'
      };
    }
    const expectedRoot = path.join(globalRoot, ...PACKAGE_PARTS);
    if (!samePath(installed.packageRoot, expectedRoot)) {
      return {
        status: 'skipped',
        currentVersion,
        reason: 'This is not the active global npm installation.'
      };
    }
    try {
      assertNoSymlinkInPath(installed.packageRoot);
      if (fs.lstatSync(installed.packageRoot).isSymbolicLink()) {
        return {
          status: 'skipped',
          currentVersion,
          reason: 'The global package path is linked; automatic replacement is unsupported.'
        };
      }
    } catch {
      return {
        status: 'skipped',
        currentVersion,
        reason: 'The global package path is unavailable or unsafe.'
      };
    }

    if (runtime.hasActivePackageProcess(installed.packageRoot)) {
      return {
        status: 'skipped',
        currentVersion,
        reason: 'Another ContextOS process is using the package; automatic update was skipped.'
      };
    }

    registryCheckAttempted = true;
    const versions = await runtime.fetchPublishedVersions();
    latestVersion = latestStableVersion(currentVersion, versions) ?? undefined;
    const targetVersion = selectAutoPatchVersion(currentVersion, versions);
    if (!targetVersion) {
      if (latestVersion) {
        const current = parseStableVersion(currentVersion)!;
        const line = `${current.major}.${current.minor}.x`;
        return {
          status: 'skipped',
          currentVersion,
          latestVersion,
          reason: `Version ${latestVersion} is available; auto-patch only installs stable releases in ${line}. Run \`contextos upgrade\` for an explicit minor update, or \`contextos upgrade --allow-major\` for a major update.`
        };
      }
      return { status: 'current', currentVersion };
    }

    await runtime.installVersion(installed.packageRoot, currentVersion, targetVersion);
    return { status: 'updated', currentVersion, targetVersion };
  } catch (error) {
    if (error instanceof UpgradeRecoveryError) throw error;
    return {
      status: 'skipped',
      currentVersion,
      latestVersion,
      registryCheckAttempted,
      reason: `Automatic patch update failed; continuing with the installed version. ${error instanceof Error ? error.message : String(error)}`
    };
  }
}

export function formatAutoPatchNotice(result: AutoPatchResult): string {
  if (result.status === 'current') return '';
  if (result.status === 'updated') {
    return `[ContextOS] Updated from ${result.currentVersion} to ${result.targetVersion}; restarting before serving.\n`;
  }
  return `[ContextOS] Automatic patch update skipped: ${result.reason}\n`;
}

async function upgrade(options: {
  version?: string;
  allowMajor?: boolean;
  dryRun?: boolean;
}): Promise<void> {
  if (!options.dryRun && process.platform !== 'linux') {
    throw new Error(
      'Safe self-upgrade is currently supported on Linux only. Use npm install -g @siddharthakatiyar/contextos@<version> on this platform.'
    );
  }

  const modulePath = fileURLToPath(import.meta.url);
  const packageRoot = findPackageRoot(path.dirname(modulePath));
  const currentManifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')
  ) as { version: string };
  const currentVersion = currentManifest.version;

  if (options.dryRun) {
    let publishedVersions: string[];
    try {
      publishedVersions = await fetchPublishedVersions();
    } catch (error) {
      throw new Error(
        `Could not read published versions from npm; no files were changed. ${error instanceof Error ? error.message : String(error)}`
      );
    }
    const targetVersion = selectUpgradeVersion(
      currentVersion,
      publishedVersions,
      options.version,
      options.allowMajor
    );
    const plan = createUpgradeInstallPlan(packageRoot, tryGetGlobalNpmRoot(), targetVersion);
    process.stdout.write(formatUpgradeInstallPlan(plan, targetVersion));
    return;
  }

  const globalRoot = fs.realpathSync(run('npm', ['root', '-g']));
  const expectedRoot = path.join(globalRoot, ...PACKAGE_PARTS);
  if (packageRoot !== expectedRoot || fs.lstatSync(packageRoot).isSymbolicLink()) {
    throw new Error(
      `Self-upgrade supports global npm installs only; local, npx, and source-checkout installs are refused. Install globally with npm install -g ${PACKAGE_NAME} to use this command.`
    );
  }
  assertNoSymlinkInPath(packageRoot);

  let published: unknown;
  try {
    published = JSON.parse(run('npm', ['view', PACKAGE_NAME, 'versions', '--json'], 90_000));
  } catch (error) {
    throw new Error(
      `Could not read published versions from npm; the installed version was left unchanged. ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(published) || !published.every((item) => typeof item === 'string')) {
    throw new Error(
      'npm returned an invalid release list; the installed version was left unchanged.'
    );
  }
  const targetVersion = selectUpgradeVersion(
    currentVersion,
    published as string[],
    options.version,
    options.allowMajor
  );

  await installSelectedVersion(packageRoot, currentVersion, targetVersion, false);
  process.stdout.write(`ContextOS upgraded from ${currentVersion} to ${targetVersion}.\n`);
}

export const upgradeCommand = new Command('upgrade')
  .description('Safely upgrade a Linux global npm install or print a portable install plan')
  .option('--version <semver>', 'Install this exact published stable version')
  .option('--allow-major', 'Allow selecting a release with a newer major version')
  .option('--dry-run', 'Print a read-only install plan without staging files or stopping daemons')
  .addHelpText(
    'after',
    `\nAutomatic replacement supports Linux global npm installs only. --dry-run resolves a published release on any platform and prints a manual command for recognized global npm, local npm/pnpm/Yarn, or source-checkout installs. Unknown, linked, or workspace layouts require their native update workflow.`
  )
  .action(async (options: { version?: string; allowMajor?: boolean; dryRun?: boolean }) =>
    upgrade(options)
  );
