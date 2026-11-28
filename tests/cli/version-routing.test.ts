import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')(
  'routes spaced and equals version options to update/upgrade while preserving top-level version flags',
  () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-version-'));
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    // Read-only dry-run dependency: use a deterministic published version list.
    fs.writeFileSync(
      path.join(bin, 'npm'),
      '#!/bin/sh\ncase "$1" in\nview) echo \'["1.2.0","1.2.3","1.2.4"]\';;\nroot) echo /fixture/global;;\n*) exit 1;;\nesac\n',
      { mode: 0o700 }
    );
    const preload = path.join(home, 'registry.mjs');
    fs.writeFileSync(
      preload,
      `globalThis.fetch = async () => new Response(JSON.stringify({versions: {'1.2.0': {}, '1.2.3': {}, '1.2.4': {}}}));`
    );
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      CONTEXTOS_AUTO_PATCH: 'off',
      CONTEXTOS_SKIP_SETUP: '1'
    };
    const run = (...args: string[]) => {
      try {
        return execFileSync(
          process.execPath,
          ['--import', preload, path.resolve('dist/bin/contextos.js'), ...args],
          {
            cwd: home,
            env,
            encoding: 'utf8',
            timeout: 10000
          }
        );
      } catch (error) {
        return String((error as { stderr: string }).stderr);
      }
    };
    try {
      const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
      for (const flag of ['--version', '-V', '--cli-version'])
        expect(run(flag).trim()).toBe(version);
      for (const command of ['update', 'upgrade']) {
        const spaced = run(command, '--dry-run', '--version', '1.2.3');
        const equals = run(command, '--dry-run', '--version=1.2.3');
        expect(spaced).toContain('Version 1.2.3 is not newer');
        expect(spaced.trim()).not.toBe(version);
        expect(spaced).toBe(equals);
      }
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
);
