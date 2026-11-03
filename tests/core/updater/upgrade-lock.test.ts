import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createUpgradeLock,
  getActiveUpgradeToken,
  getUpgradeLockPath,
  isUpgradeInProgress,
  waitForUpgradeToFinish
} from '../../../src/core/updater/upgrade-lock.js';

describe('upgrade lock', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-upgrade-lock-'));
    vi.spyOn(os, 'homedir').mockReturnValue(tempHome);
    vi.stubEnv('CONTEXTOS_UPGRADE_TOKEN', '');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('creates a private exclusive lock and removes it idempotently', () => {
    const lock = createUpgradeLock();
    const lockPath = getUpgradeLockPath();

    expect(fs.statSync(lockPath).mode & 0o777).toBe(0o600);
    expect(isUpgradeInProgress()).toBe(true);
    expect(getActiveUpgradeToken()).toBe(lock.token);
    expect(() => createUpgradeLock()).toThrow(/already in progress/i);

    lock.release();
    lock.release();

    expect(fs.existsSync(lockPath)).toBe(false);
    expect(isUpgradeInProgress()).toBe(false);
    expect(getActiveUpgradeToken()).toBeNull();
  });

  it('allows only the matching upgrade process to bypass the wait', async () => {
    const lock = createUpgradeLock();
    try {
      vi.stubEnv('CONTEXTOS_UPGRADE_TOKEN', lock.token);
      await expect(waitForUpgradeToFinish(0)).resolves.toBeUndefined();

      vi.stubEnv('CONTEXTOS_UPGRADE_TOKEN', 'wrong-token');
      await expect(waitForUpgradeToFinish(0)).rejects.toThrow(/still in progress/i);
    } finally {
      lock.release();
    }
  });

  it('fails closed on an unreadable lock rather than treating it as free', async () => {
    const lockPath = getUpgradeLockPath();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(lockPath, '{not-json', { mode: 0o600 });

    expect(isUpgradeInProgress()).toBe(true);
    expect(getActiveUpgradeToken()).toBeNull();
    expect(() => createUpgradeLock()).toThrow(/unreadable/i);
    await expect(waitForUpgradeToFinish(0)).rejects.toThrow(/still in progress/i);
  });

  it('does not remove a replacement lock when an older owner releases', () => {
    const oldLock = createUpgradeLock();
    const replacement = {
      pid: process.pid,
      token: 'b'.repeat(64),
      startedAt: Date.now()
    };
    fs.writeFileSync(getUpgradeLockPath(), JSON.stringify(replacement), { mode: 0o600 });

    oldLock.release();

    expect(JSON.parse(fs.readFileSync(getUpgradeLockPath(), 'utf8'))).toMatchObject(replacement);
    expect(getActiveUpgradeToken()).toBe(replacement.token);
  });
});
