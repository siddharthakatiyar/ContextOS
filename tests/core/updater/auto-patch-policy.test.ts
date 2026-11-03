import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getAutoPatchPolicyPath,
  readAutoPatchPolicy,
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

  it('defaults to notify and ignores project configuration and environment opt-ins', () => {
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

    expect(readAutoPatchPolicy(home)).toBe('notify');
  });

  it('enables auto-patch only from the explicit per-user policy file', () => {
    const home = makeHome();
    writeAutoPatchPolicy('auto-patch', home);

    expect(readAutoPatchPolicy(home)).toBe('auto-patch');
    expect(fs.statSync(getAutoPatchPolicyPath(home)).mode & 0o777).toBe(0o600);
  });

  it('fails closed to notify for malformed, extra-key, permissive, or symlinked policy data', () => {
    const home = makeHome();
    const policyPath = getAutoPatchPolicyPath(home);
    fs.mkdirSync(path.dirname(policyPath), { recursive: true, mode: 0o700 });

    fs.writeFileSync(policyPath, '{broken', { mode: 0o600 });
    expect(readAutoPatchPolicy(home)).toBe('notify');

    fs.writeFileSync(policyPath, JSON.stringify({ mode: 'auto-patch', project: '/untrusted' }), {
      mode: 0o600
    });
    expect(readAutoPatchPolicy(home)).toBe('notify');

    fs.writeFileSync(policyPath, JSON.stringify({ mode: 'auto-patch' }), { mode: 0o644 });
    fs.chmodSync(policyPath, 0o644);
    expect(readAutoPatchPolicy(home)).toBe('notify');

    fs.unlinkSync(policyPath);
    const target = path.join(home, 'untrusted-policy.json');
    fs.writeFileSync(target, JSON.stringify({ mode: 'auto-patch' }), { mode: 0o600 });
    fs.symlinkSync(target, policyPath);
    expect(readAutoPatchPolicy(home)).toBe('notify');
  });

  it('rejects invalid policy modes instead of persisting them', () => {
    const home = makeHome();

    expect(() => writeAutoPatchPolicy('always' as UpdatePolicyMode, home)).toThrow(
      /either "notify" or "auto-patch"/
    );
    expect(fs.existsSync(getAutoPatchPolicyPath(home))).toBe(false);
  });
});
