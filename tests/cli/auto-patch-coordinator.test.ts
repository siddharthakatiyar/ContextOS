import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAutoPatchBeforeServe, type AutoPatchRuntime } from '../../src/cli/commands/upgrade.js';

describe('automatic patch coordinator', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeRuntime(overrides: Partial<AutoPatchRuntime> = {}): AutoPatchRuntime {
    const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-auto-patch-global-'));
    temporaryDirectories.push(globalRoot);
    const packageRoot = path.join(globalRoot, '@siddharthakatiyar', 'contextos');
    fs.mkdirSync(packageRoot, { recursive: true, mode: 0o755 });

    return {
      platform: 'linux',
      resolveInstalledPackage: () => ({ packageRoot, currentVersion: '1.2.3' }),
      resolveGlobalNpmRoot: () => globalRoot,
      fetchPublishedVersions: vi.fn(async () => [
        '1.2.3',
        '1.2.4-beta.1',
        '1.2.4',
        '1.2.5',
        '1.3.0',
        '2.0.0'
      ]),
      hasActivePackageProcess: vi.fn(() => false),
      installVersion: vi.fn(async () => {}),
      ...overrides
    };
  }

  it('installs only the newest stable patch in the current major/minor line', async () => {
    const runtime = makeRuntime();

    await expect(runAutoPatchBeforeServe(runtime)).resolves.toEqual({
      status: 'updated',
      currentVersion: '1.2.3',
      targetVersion: '1.2.5'
    });

    expect(runtime.installVersion).toHaveBeenCalledOnce();
    expect(runtime.installVersion).toHaveBeenCalledWith(
      expect.stringContaining(path.join('@siddharthakatiyar', 'contextos')),
      '1.2.3',
      '1.2.5'
    );
  });

  it('does not install prereleases, minor releases, or major releases automatically', async () => {
    const runtime = makeRuntime({
      fetchPublishedVersions: vi.fn(async () => ['1.2.3', '1.2.4-beta.1', '1.3.0', '2.0.0'])
    });

    const result = await runAutoPatchBeforeServe(runtime);

    expect(result).toMatchObject({
      status: 'skipped',
      currentVersion: '1.2.3',
      latestVersion: '2.0.0'
    });
    expect(result.status === 'skipped' && result.reason).toContain('1.2.x');
    expect(runtime.installVersion).not.toHaveBeenCalled();
  });

  it('skips before fetching or installing when another process is using the package', async () => {
    const runtime = makeRuntime({ hasActivePackageProcess: vi.fn(() => true) });

    const result = await runAutoPatchBeforeServe(runtime);

    expect(result).toMatchObject({ status: 'skipped', currentVersion: '1.2.3' });
    expect(runtime.fetchPublishedVersions).not.toHaveBeenCalled();
    expect(runtime.installVersion).not.toHaveBeenCalled();
  });

  it('continues without patching when process-safety inspection is unavailable', async () => {
    const runtime = makeRuntime({
      hasActivePackageProcess: vi.fn(() => {
        throw new Error('process list is inaccessible');
      })
    });

    await expect(runAutoPatchBeforeServe(runtime)).resolves.toMatchObject({
      status: 'skipped',
      currentVersion: '1.2.3'
    });
    expect(runtime.fetchPublishedVersions).not.toHaveBeenCalled();
    expect(runtime.installVersion).not.toHaveBeenCalled();
  });

  it('skips unsupported platforms and non-global package provenance', async () => {
    const unsupportedPlatform = makeRuntime({ platform: 'darwin' });
    const localPackage = makeRuntime({ resolveGlobalNpmRoot: () => null });

    await expect(runAutoPatchBeforeServe(unsupportedPlatform)).resolves.toMatchObject({
      status: 'skipped'
    });
    await expect(runAutoPatchBeforeServe(localPackage)).resolves.toMatchObject({
      status: 'skipped',
      currentVersion: '1.2.3'
    });
    expect(unsupportedPlatform.fetchPublishedVersions).not.toHaveBeenCalled();
    expect(localPackage.fetchPublishedVersions).not.toHaveBeenCalled();
    expect(unsupportedPlatform.installVersion).not.toHaveBeenCalled();
    expect(localPackage.installVersion).not.toHaveBeenCalled();
  });

  it('continues with the installed version after registry or installer failures', async () => {
    const offline = makeRuntime({
      fetchPublishedVersions: vi.fn(async () => {
        throw new Error('registry offline');
      })
    });
    const failedInstall = makeRuntime({
      fetchPublishedVersions: vi.fn(async () => ['1.2.4']),
      installVersion: vi.fn(async () => {
        throw new Error('staging failed');
      })
    });

    await expect(runAutoPatchBeforeServe(offline)).resolves.toMatchObject({
      status: 'skipped',
      currentVersion: '1.2.3'
    });
    await expect(runAutoPatchBeforeServe(failedInstall)).resolves.toMatchObject({
      status: 'skipped',
      currentVersion: '1.2.3'
    });
    expect(offline.installVersion).not.toHaveBeenCalled();
    expect(failedInstall.installVersion).toHaveBeenCalledOnce();
  });
});
