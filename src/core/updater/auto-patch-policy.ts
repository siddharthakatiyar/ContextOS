import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoSymlinkInPath, writePrivateStateFile } from '../../utils/secure-state.js';

export type UpdatePolicyMode = 'notify' | 'auto-patch';
export type AutoPatchPolicySource = 'default' | 'user' | 'unsafe';

export interface AutoPatchPolicyResolution {
  mode: UpdatePolicyMode;
  source: AutoPatchPolicySource;
}

function getContextHome(homeDirectory: string): string {
  return path.join(homeDirectory, '.contextos');
}

export function getAutoPatchPolicyPath(homeDirectory = os.homedir()): string {
  return path.join(getContextHome(homeDirectory), 'update-policy.json');
}

export function getAutoPatchNoticeMarkerPath(homeDirectory = os.homedir()): string {
  return path.join(getContextHome(homeDirectory), 'update-policy-notice.json');
}

function isOwnerPrivateDirectory(directoryPath: string): boolean {
  const stat = fs.lstatSync(directoryPath);
  const userId = typeof process.getuid === 'function' ? process.getuid() : null;
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    (userId === null || stat.uid === userId) &&
    (stat.mode & 0o077) === 0
  );
}

/**
 * Resolve only the explicit per-user policy. A missing policy gets the new
 * default; malformed, inaccessible, or unsafe state always fails closed.
 */
export function resolveAutoPatchPolicy(homeDirectory = os.homedir()): AutoPatchPolicyResolution {
  const policyPath = getAutoPatchPolicyPath(homeDirectory);
  try {
    assertNoSymlinkInPath(policyPath);
    const directoryPath = getContextHome(homeDirectory);
    try {
      if (!isOwnerPrivateDirectory(directoryPath)) return { mode: 'notify', source: 'unsafe' };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        return { mode: 'notify', source: 'unsafe' };
      }
    }
  } catch {
    return { mode: 'notify', source: 'unsafe' };
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(policyPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { mode: 'auto-patch', source: 'default' };
    }
    return { mode: 'notify', source: 'unsafe' };
  }

  try {
    const userId = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (userId !== null && stat.uid !== userId) ||
      (stat.mode & 0o077) !== 0
    ) {
      return { mode: 'notify', source: 'unsafe' };
    }
    const value: unknown = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length === 1 &&
      'mode' in value &&
      (value.mode === 'notify' || value.mode === 'auto-patch')
    ) {
      return { mode: value.mode, source: 'user' };
    }
    return { mode: 'notify', source: 'unsafe' };
  } catch {
    return { mode: 'notify', source: 'unsafe' };
  }
}

/** Return just the effective mode for existing updater callers. */
export function readAutoPatchPolicy(homeDirectory = os.homedir()): UpdatePolicyMode {
  return resolveAutoPatchPolicy(homeDirectory).mode;
}

function hasSafeOwnerPrivateMarker(homeDirectory: string): boolean {
  const markerPath = getAutoPatchNoticeMarkerPath(homeDirectory);
  try {
    assertNoSymlinkInPath(markerPath);
    const directoryPath = getContextHome(homeDirectory);
    const markerStat = fs.lstatSync(markerPath);
    const userId = typeof process.getuid === 'function' ? process.getuid() : null;
    return (
      isOwnerPrivateDirectory(directoryPath) &&
      markerStat.isFile() &&
      !markerStat.isSymbolicLink() &&
      (userId === null || markerStat.uid === userId) &&
      (markerStat.mode & 0o077) === 0 &&
      JSON.parse(fs.readFileSync(markerPath, 'utf8'))?.shown === true
    );
  } catch {
    return false;
  }
}

/**
 * Show the opt-out onboarding only for the implicit default. Unsafe marker
 * state is treated as not shown; it never changes the update policy.
 */
export function shouldShowAutoPatchDefaultNotice(homeDirectory = os.homedir()): boolean {
  const policy = resolveAutoPatchPolicy(homeDirectory);
  if (policy.source !== 'default') return false;
  return !hasSafeOwnerPrivateMarker(homeDirectory);
}

/** Store a private, per-user marker after the notice has been written to stderr. */
export function markAutoPatchDefaultNoticeShown(homeDirectory = os.homedir()): void {
  if (resolveAutoPatchPolicy(homeDirectory).source !== 'default') return;
  writePrivateStateFile(
    getAutoPatchNoticeMarkerPath(homeDirectory),
    `${JSON.stringify({ shown: true }, null, 2)}\n`
  );
}

/** Persist a choice made through the CLI in an owner-private file. */
export function writeAutoPatchPolicy(mode: UpdatePolicyMode, homeDirectory = os.homedir()): void {
  if (mode !== 'notify' && mode !== 'auto-patch') {
    throw new Error('Update policy must be either "notify" or "auto-patch".');
  }
  writePrivateStateFile(
    getAutoPatchPolicyPath(homeDirectory),
    `${JSON.stringify({ mode }, null, 2)}\n`
  );
}
