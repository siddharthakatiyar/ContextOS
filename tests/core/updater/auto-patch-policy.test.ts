import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoPatchNoticeMarkerPath,
  getAutoPatchPolicyPath,
  markAutoPatchDefaultNoticeShown,
  readAutoPatchPolicy,
  resolveAutoPatchPolicy,
  shouldShowAutoPatchDefaultNotice,
  writeAutoPatchPolicy,
  type UpdatePolicyMode
} from '../../../src/core/updater/auto-patch-policy.js';

describe('per-user auto-patch policy', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-update-policy-home-'));
    temporaryDirectories.push(home);
    return home;
  }

  it('defaults to auto-patch and ignores project configuration and environment opt-ins', () => {
    const home = makeHome();
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-update-policy-project-'));
    temporaryDirectories.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.contextos'));
    fs.writeFileSync(
      path.join(projectDir, '.contextos', 'config.json'),
      JSON.stringify({ updatePolicy: 'auto-patch' })
    );
    fs.writeFileSync(path.join(projectDir, '.env'), 'CONTEXTOS_UPDATE_POLICY=auto-patch\n');
    vi.stubEnv('CONTEXTOS_AUTO_PATCH', '1');
    vi.stubEnv('CONTEXTOS_UPDATE_POLICY', 'auto-patch');

    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'auto-patch', source: 'default' });
    expect(readAutoPatchPolicy(home)).toBe('auto-patch');
  });

  it('honors an explicit per-user notify opt-out in a private file', () => {
    const home = makeHome();
    writeAutoPatchPolicy('notify', home);

    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'user' });
    expect(readAutoPatchPolicy(home)).toBe('notify');
    expect(shouldShowAutoPatchDefaultNotice(home)).toBe(false);
    expect(fs.statSync(getAutoPatchPolicyPath(home)).mode & 0o777).toBe(0o600);
  });

  it('announces the implicit default once and records a private user-home marker', () => {
    const home = makeHome();
    const markerPath = getAutoPatchNoticeMarkerPath(home);

    expect(shouldShowAutoPatchDefaultNotice(home)).toBe(true);
    expect(fs.existsSync(markerPath)).toBe(false);

    markAutoPatchDefaultNoticeShown(home);

    expect(fs.statSync(markerPath).mode & 0o777).toBe(0o600);
    expect(shouldShowAutoPatchDefaultNotice(home)).toBe(false);
    markAutoPatchDefaultNoticeShown(home);
    expect(shouldShowAutoPatchDefaultNotice(home)).toBe(false);
  });

  it('does not create a default-on notice marker after an explicit notify opt-out', () => {
    const home = makeHome();
    writeAutoPatchPolicy('notify', home);

    expect(shouldShowAutoPatchDefaultNotice(home)).toBe(false);
    markAutoPatchDefaultNoticeShown(home);
    expect(fs.existsSync(getAutoPatchNoticeMarkerPath(home))).toBe(false);
  });

  it('fails closed when the per-user state directory is unsafe even if policy is absent', () => {
    const home = makeHome();
    const contextDirectory = path.join(home, '.contextos');
    fs.mkdirSync(contextDirectory, { mode: 0o777 });
    fs.chmodSync(contextDirectory, 0o777);

    expect(fs.existsSync(getAutoPatchPolicyPath(home))).toBe(false);
    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'unsafe' });
  });

  it('fails closed when the per-user state directory is a symlink and policy is absent', () => {
    const home = makeHome();
    const targetDirectory = path.join(home, 'state-target');
    fs.mkdirSync(targetDirectory, { mode: 0o700 });
    fs.symlinkSync(targetDirectory, path.join(home, '.contextos'));

    expect(fs.existsSync(getAutoPatchPolicyPath(home))).toBe(false);
    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'unsafe' });
  });

  it('fails closed to notify for malformed, extra-key, permissive, or symlinked policy data', () => {
    const home = makeHome();
    const policyPath = getAutoPatchPolicyPath(home);
    fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 });

    fs.writeFileSync(policyPath, '{broken', { mode: 0o600 });
    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'unsafe' });

    fs.writeFileSync(policyPath, JSON.stringify({ mode: 'auto-patch', project: '/untrusted' }), {
      mode: 0o600
    });
    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'unsafe' });

    fs.writeFileSync(policyPath, JSON.stringify({ mode: 'auto-patch' }), { mode: 0o644 });
    fs.chmodSync(policyPath, 0o644);
    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'unsafe' });

    fs.unlinkSync(policyPath);
    const target = path.join(home, 'untrusted-policy.json');
    fs.writeFileSync(target, JSON.stringify({ mode: 'auto-patch' }), { mode: 0o600 });
    fs.symlinkSync(target, policyPath);
    expect(resolveAutoPatchPolicy(home)).toEqual({ mode: 'notify', source: 'unsafe' });
  });

  it('rejects invalid policy modes instead of persisting them', () => {
    const home = makeHome();

    expect(() => writeAutoPatchPolicy('always' as UpdatePolicyMode, home)).toThrow(
      /either "notify" or "auto-patch"/
    );
    expect(fs.existsSync(getAutoPatchPolicyPath(home))).toBe(false);
  });
});
