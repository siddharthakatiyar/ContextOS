import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  assertNoSymlinkInPath,
  ensurePrivateStateDir,
  removePrivateStateFile
} from '../../utils/secure-state.js';

interface UpgradeLockRecord {
  pid: number;
  token: string;
  startedAt: number;
}

export function getUpgradeLockPath(): string {
  return path.join(os.homedir(), '.contextos', 'upgrade.lock');
}

function readLockRecord(): UpgradeLockRecord | null {
  const lockPath = getUpgradeLockPath();
  try {
    assertNoSymlinkInPath(lockPath);
    const parsed: unknown = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      !('pid' in parsed) ||
      !Number.isSafeInteger(parsed.pid) ||
      !('token' in parsed) ||
      typeof parsed.token !== 'string' ||
      parsed.token.length < 32 ||
      !('startedAt' in parsed) ||
      typeof parsed.startedAt !== 'number'
    ) {
      return null;
    }
    return parsed as UpgradeLockRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Return the token only while the owner of the lock is still alive. */
export function getActiveUpgradeToken(): string | null {
  const record = readLockRecord();
  if (!record) return null;
  return isProcessAlive(record.pid) ? record.token : null;
}

export function isUpgradeInProgress(): boolean {
  const lockPath = getUpgradeLockPath();
  try {
    if (!fs.existsSync(lockPath)) return false;
    assertNoSymlinkInPath(lockPath);
  } catch {
    return true;
  }
  // Existing locks always block. In particular, do not unlink a stale lock
  // automatically: a path-based stale check and unlink have a TOCTOU window
  // where a second upgrader could remove a newly acquired live lock.
  return true;
}

export async function waitForUpgradeToFinish(timeoutMs = 120_000): Promise<void> {
  const startedAt = Date.now();
  while (isUpgradeInProgress()) {
    const token = getActiveUpgradeToken();
    if (token && process.env.CONTEXTOS_UPGRADE_TOKEN === token) return;
    const record = readLockRecord();
    if (record && !isProcessAlive(record.pid)) {
      throw new Error(
        `A stale ContextOS upgrade lock owned by PID ${record.pid} remains at ${getUpgradeLockPath()}. Confirm no upgrade is running, remove the lock file, then retry.`
      );
    }
    if (!record && Date.now() - startedAt >= 300) {
      throw new Error(
        `The ContextOS upgrade lock at ${getUpgradeLockPath()} is unreadable. Inspect it before retrying.`
      );
    }
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('A ContextOS upgrade is still in progress; retry after it finishes.');
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function createUpgradeLock(): { token: string; release: () => void } {
  const lockPath = getUpgradeLockPath();
  ensurePrivateStateDir(path.dirname(lockPath));
  assertNoSymlinkInPath(lockPath);

  const token = crypto.randomBytes(32).toString('hex');
  const record: UpgradeLockRecord = { pid: process.pid, token, startedAt: Date.now() };
  let fd: number;
  try {
    fd = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const stale = readLockRecord();
      if (stale && !isProcessAlive(stale.pid)) {
        throw new Error(
          `A stale ContextOS upgrade lock remains at ${lockPath}. Confirm no upgrade is running, then remove that file and retry.`
        );
      }
      throw new Error(
        'Another ContextOS upgrade is already in progress, or its lock is unreadable.'
      );
    } else {
      throw error;
    }
  }

  try {
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fchmodSync(fd, 0o600);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {}
    removePrivateStateFile(lockPath);
    throw error;
  }
  fs.closeSync(fd);

  let released = false;
  return {
    token,
    release: () => {
      if (released) return;
      released = true;
      const active = readLockRecord();
      if (active?.token === token && active.pid === process.pid) {
        removePrivateStateFile(lockPath);
      }
    }
  };
}
