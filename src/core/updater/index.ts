import { getPackageVersion } from '../../utils/version.js';

const PACKAGE_NAME = '@siddharthakatiyar/contextos';
const REGISTRY_URL = 'https://registry.npmjs.org/@siddharthakatiyar%2Fcontextos/latest';
const PACKAGE_URL = 'https://www.npmjs.com/package/@siddharthakatiyar/contextos';
const RELEASES_URL = 'https://github.com/siddharthakatiyar/ContextOS/releases';
const UPGRADE_NOTE =
  'Automatic self-upgrade supports Linux global npm installs only. Run contextos upgrade --dry-run for a read-only manual plan on recognized global npm, local npm/pnpm/Yarn, or source-checkout installs; unknown, linked, and workspace layouts require their native update workflow.';
const DEFAULT_TIMEOUT_MS = 1_500;

export interface UpdateStatus {
  status: 'current' | 'update_available' | 'unknown';
  packageName: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean | null;
  /** True means the latest release has the same major version under semver. */
  compatible: boolean | null;
  checkedAt: string;
  /** Null when versions could not be compared. */
  upgradeCommand: string | null;
  upgradeNote: string;
  packageUrl: string;
  releasesUrl: string;
}

export interface CheckForUpdatesOptions {
  currentVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface ParsedVersion {
  major: bigint;
  minor: bigint;
  patch: bigint;
  prerelease: string[] | null;
}

function parseVersion(version: string): ParsedVersion | null {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version.trim()
    );
  if (!match) return null;

  const prerelease = match[4]?.split('.') ?? null;
  if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) {
    return null;
  }

  return {
    major: BigInt(match[1]!),
    minor: BigInt(match[2]!),
    patch: BigInt(match[3]!),
    prerelease
  };
}

function comparePrerelease(left: string[] | null, right: string[] | null): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;

  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index++) {
    const leftPart = left[index]!;
    const rightPart = right[index]!;
    const leftIsNumeric = /^\d+$/.test(leftPart);
    const rightIsNumeric = /^\d+$/.test(rightPart);

    if (leftIsNumeric && rightIsNumeric) {
      const leftNumber = BigInt(leftPart);
      const rightNumber = BigInt(rightPart);
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
    } else if (leftIsNumeric !== rightIsNumeric) {
      return leftIsNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart > rightPart ? 1 : -1;
    }
  }

  if (left.length === right.length) return 0;
  return left.length > right.length ? 1 : -1;
}

/** Compare two semantic versions, including prerelease ordering. */
export function compareVersions(left: string, right: string): number | null {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) return null;

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (leftVersion[key] !== rightVersion[key]) {
      return leftVersion[key] > rightVersion[key] ? 1 : -1;
    }
  }

  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

function statusFor(
  currentVersion: string,
  latestVersion: string | null,
  checkedAt: string
): UpdateStatus {
  const comparison = latestVersion === null ? null : compareVersions(latestVersion, currentVersion);
  const current = parseVersion(currentVersion);
  const latest = latestVersion === null ? null : parseVersion(latestVersion);
  const updateAvailable = comparison === null ? null : comparison > 0;
  const compatible = current && latest ? current.major === latest.major : null;

  return {
    status: updateAvailable === null ? 'unknown' : updateAvailable ? 'update_available' : 'current',
    packageName: PACKAGE_NAME,
    currentVersion,
    latestVersion,
    updateAvailable,
    compatible,
    checkedAt,
    upgradeCommand:
      updateAvailable !== true
        ? null
        : compatible
          ? 'contextos upgrade'
          : 'contextos upgrade --allow-major',
    upgradeNote: UPGRADE_NOTE,
    packageUrl: PACKAGE_URL,
    releasesUrl: RELEASES_URL
  };
}

async function fetchLatestVersion(
  fetchImpl: typeof fetch,
  timeoutMs: number
): Promise<string | null> {
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const request = fetchImpl(REGISTRY_URL, {
    headers: { accept: 'application/vnd.npm.install-v1+json' },
    signal: controller.signal
  }).then(async (response) => {
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('version' in body)) return null;
    const version = (body as { version?: unknown }).version;
    return typeof version === 'string' && parseVersion(version) ? version : null;
  });

  const timeout = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });

  try {
    return await Promise.race([request, timeout]);
  } catch {
    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

/**
 * Query npm for the latest published release. The check is bounded, never
 * installs anything, and returns an unknown status if the registry is offline.
 */
export async function checkForUpdates(options: CheckForUpdatesOptions = {}): Promise<UpdateStatus> {
  const currentVersion = options.currentVersion ?? getPackageVersion();
  const checkedAt = new Date().toISOString();
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const latestVersion = await fetchLatestVersion(options.fetchImpl ?? fetch, timeoutMs);
    return statusFor(currentVersion, latestVersion, checkedAt);
  } catch {
    return statusFor(currentVersion, null, checkedAt);
  }
}

/** Return a user-facing update notice; unknown or current installs stay quiet. */
export function formatUpdateNotice(status: UpdateStatus): string {
  if (!status.updateAvailable || !status.latestVersion || !status.upgradeCommand) return '';

  const compatibility = status.compatible ? ' (same major version)' : ' (major version change)';
  return (
    `[ContextOS] Update available: ${status.currentVersion} → ${status.latestVersion}${compatibility}\n` +
    `Run \`${status.upgradeCommand}\` to upgrade. Release notes: ${status.releasesUrl}\n`
  );
}
