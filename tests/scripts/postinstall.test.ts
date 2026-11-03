import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const scriptPath = fileURLToPath(new URL('../../scripts/postinstall.mjs', import.meta.url));

describe('postinstall notice', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function makeHome(): string {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-postinstall-'));
    temporaryDirectories.push(home);
    return home;
  }

  it('writes only the informational notice to stderr and leaves user state untouched', () => {
    const home = makeHome();
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: home,
      encoding: 'utf8',
      env: { HOME: home, USERPROFILE: home, PATH: process.env.PATH ?? '' }
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'Disable automatic installs with `contextos updates policy notify`.'
    );
    expect(fs.existsSync(path.join(home, '.contextos'))).toBe(false);

    const source = fs.readFileSync(scriptPath, 'utf8');
    expect(source).not.toMatch(/^\s*import\b/m);
    expect(source).not.toMatch(
      /\b(?:fetch|spawn|exec|request|createServer|runDaemonClient|runAutoPatchBeforeServe)\s*\(/
    );
  });

  it('is silent when the staged auto-patch install sets its suppression flag', () => {
    const home = makeHome();
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: home,
      encoding: 'utf8',
      env: {
        HOME: home,
        USERPROFILE: home,
        PATH: process.env.PATH ?? '',
        CONTEXTOS_SUPPRESS_INSTALL_NOTICE: '1'
      }
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(fs.existsSync(path.join(home, '.contextos'))).toBe(false);
  });
});
