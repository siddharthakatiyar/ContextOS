import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTO_PATCH_DEFAULT_NOTICE,
  showAutoPatchDefaultNotice
} from '../../../src/core/updater/auto-patch-onboarding.js';
import {
  getAutoPatchNoticeMarkerPath,
  writeAutoPatchPolicy
} from '../../../src/core/updater/auto-patch-policy.js';

describe('auto-patch onboarding notice', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-auto-patch-onboarding-'));
    temporaryDirectories.push(home);
    return home;
  }

  it('announces the implicit default once and writes the private marker after the notice', () => {
    const home = makeHome();
    const writes: string[] = [];

    expect(showAutoPatchDefaultNotice((message) => writes.push(message), home)).toBe(true);
    expect(writes).toEqual([AUTO_PATCH_DEFAULT_NOTICE]);
    expect(fs.statSync(getAutoPatchNoticeMarkerPath(home)).mode & 0o777).toBe(0o600);

    expect(showAutoPatchDefaultNotice((message) => writes.push(message), home)).toBe(false);
    expect(writes).toEqual([AUTO_PATCH_DEFAULT_NOTICE]);
  });

  it('does not announce or mark an explicit notify opt-out', () => {
    const home = makeHome();
    writeAutoPatchPolicy('notify', home);
    const writes: string[] = [];

    expect(showAutoPatchDefaultNotice((message) => writes.push(message), home)).toBe(false);
    expect(writes).toEqual([]);
    expect(fs.existsSync(getAutoPatchNoticeMarkerPath(home))).toBe(false);
  });
});
