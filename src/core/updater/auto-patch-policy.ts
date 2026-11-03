import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertNoSymlinkInPath, writePrivateStateFile } from '../../utils/secure-state.js';

export type UpdatePolicyMode = 'notify' | 'auto-patch';

export function getAutoPatchPolicyPath(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, '.contextos', 'update-policy.json');
}

/** Read only the explicit per-user policy. Missing or unsafe data always disables installs. */
export function readAutoPatchPolicy(homeDirectory = os.homedir()): UpdatePolicyMode {
  const policyPath = getAutoPatchPolicyPath(homeDirectory);
  try {
    assertNoSymlinkInPath(policyPath);
    const stat = fs.lstatSync(policyPath);
    const userId = typeof process.getuid === 'function' ? process.getuid() : null;
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (userId !== null && stat.uid !== userId) ||
      (stat.mode & 0o077) !== 0
    ) {
      return 'notify';
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
      return value.mode;
    }
  } catch {
    // Missing, malformed, or unsafe policy data always means notify-only.
  }
  return 'notify';
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
