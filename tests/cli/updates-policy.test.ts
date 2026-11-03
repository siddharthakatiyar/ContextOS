import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { updatesCommand } from '../../src/cli/commands/updates.js';
import {
  getAutoPatchPolicyPath,
  readAutoPatchPolicy
} from '../../src/core/updater/auto-patch-policy.js';

describe('updates policy command', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('lets the user disable default auto-patching without writing to the real home', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-policy-command-'));
    temporaryDirectories.push(home);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await updatesCommand.parseAsync(['node', 'contextos', 'policy', 'notify']);

    expect(readAutoPatchPolicy(home)).toBe('notify');
    expect(fs.statSync(getAutoPatchPolicyPath(home)).mode & 0o777).toBe(0o600);
    expect(stdoutWrite).toHaveBeenCalledWith(expect.stringContaining('Update policy: notify'));
    expect(stdoutWrite).toHaveBeenCalledWith(
      expect.stringContaining('no package is installed automatically')
    );
  });
});
