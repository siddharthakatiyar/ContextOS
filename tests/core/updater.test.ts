import { describe, expect, it, vi } from 'vitest';
import {
  checkForUpdates,
  compareVersions,
  formatUpdateNotice
} from '../../src/core/updater/index.js';

const REGISTRY_URL = 'https://registry.npmjs.org/@siddharthakatiyar%2Fcontextos/latest';

function registryResponse(version: string): Response {
  return new Response(JSON.stringify({ version }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  });
}

describe('semantic version comparison', () => {
  it('compares numeric version components instead of lexicographic strings', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2.0', '1.2.1')).toBe(-1);
  });

  it('uses semver prerelease ordering and ignores build metadata', () => {
    expect(compareVersions('2.0.0', '2.0.0-rc.99')).toBe(1);
    expect(compareVersions('2.0.0-rc.10', '2.0.0-rc.2')).toBe(1);
    expect(compareVersions('2.0.0+build.2', '2.0.0+build.1')).toBe(0);
  });

  it('rejects invalid versions including numeric prerelease leading zeroes', () => {
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0.0-01', '1.0.0')).toBeNull();
    expect(compareVersions('1.0', '1.0.0')).toBeNull();
  });
});

describe('checkForUpdates', () => {
  it('returns the latest version and same-major upgrade command', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe(REGISTRY_URL);
      return registryResponse('1.4.0');
    });

    const status = await checkForUpdates({
      currentVersion: '1.3.2',
      fetchImpl: fetchMock as unknown as typeof fetch
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(status).toMatchObject({
      status: 'update_available',
      packageName: '@siddharthakatiyar/contextos',
      currentVersion: '1.3.2',
      latestVersion: '1.4.0',
      updateAvailable: true,
      compatible: true,
      upgradeCommand: 'contextos upgrade'
    });
    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });

  it('requires the explicit major-version flag for a newer major', async () => {
    const status = await checkForUpdates({
      currentVersion: '1.9.9',
      fetchImpl: vi.fn(async () => registryResponse('2.0.0')) as unknown as typeof fetch
    });

    expect(status).toMatchObject({
      status: 'update_available',
      updateAvailable: true,
      compatible: false,
      upgradeCommand: 'contextos upgrade --allow-major'
    });
  });

  it('returns current with no command when no newer release exists', async () => {
    const status = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: vi.fn(async () => registryResponse('1.0.0-beta.2')) as unknown as typeof fetch
    });

    expect(status).toMatchObject({
      status: 'current',
      updateAvailable: false,
      compatible: true,
      upgradeCommand: null
    });
  });

  it('returns unknown when the registry fails or returns invalid metadata', async () => {
    const rejects = vi.fn(async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const failure = await checkForUpdates({ currentVersion: '1.0.0', fetchImpl: rejects });
    expect(failure).toMatchObject({
      status: 'unknown',
      latestVersion: null,
      updateAvailable: null,
      compatible: null,
      upgradeCommand: null
    });

    const invalid = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: vi.fn(async () => registryResponse('latest')) as unknown as typeof fetch
    });
    expect(invalid.status).toBe('unknown');
    expect(invalid.latestVersion).toBeNull();
  });

  it('enforces a timeout even when fetch ignores abort', async () => {
    const fetchNeverSettles = vi.fn(
      () => new Promise<Response>(() => {})
    ) as unknown as typeof fetch;
    const startedAt = Date.now();

    const status = await checkForUpdates({
      currentVersion: '1.0.0',
      timeoutMs: 10,
      fetchImpl: fetchNeverSettles
    });

    expect(status.status).toBe('unknown');
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});

describe('formatUpdateNotice', () => {
  it('includes the exact command and release notes for a known update', async () => {
    const status = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: vi.fn(async () => registryResponse('1.0.1')) as unknown as typeof fetch
    });

    expect(formatUpdateNotice(status)).toContain('contextos upgrade');
    expect(formatUpdateNotice(status)).toContain(status.releasesUrl);
  });

  it('stays quiet when the registry result is unavailable or current', async () => {
    const unavailable = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: vi.fn(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch
    });
    const current = await checkForUpdates({
      currentVersion: '1.0.0',
      fetchImpl: vi.fn(async () => registryResponse('1.0.0')) as unknown as typeof fetch
    });

    expect(formatUpdateNotice(unavailable)).toBe('');
    expect(formatUpdateNotice(current)).toBe('');
  });
});
