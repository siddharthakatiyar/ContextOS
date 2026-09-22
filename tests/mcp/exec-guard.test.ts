import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildExecutionEnv,
  registerExecuteTool,
  repoScriptsAllowed,
  validateSymlinkFollowOptions
} from '../../src/mcp/tools/execute.js';
import { validateCommandArguments } from '../../src/utils/command-guard.js';

describe('ctx_execute repo-script gate (execAllowRepoScripts)', () => {
  const orig = process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
  afterEach(() => {
    if (orig === undefined) delete process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
    else process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = orig;
  });

  it('defaults to disabled when the env var is unset', () => {
    delete process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
    expect(repoScriptsAllowed()).toBe(false);
  });

  it('is disabled by CONTEXTOS_EXEC_ALLOW_SCRIPTS=0', () => {
    process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = '0';
    expect(repoScriptsAllowed()).toBe(false);
  });

  it('is disabled by CONTEXTOS_EXEC_ALLOW_SCRIPTS=false', () => {
    process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = 'false';
    expect(repoScriptsAllowed()).toBe(false);
  });

  it('is enabled by CONTEXTOS_EXEC_ALLOW_SCRIPTS=1', () => {
    process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = '1';
    expect(repoScriptsAllowed()).toBe(true);
  });

  it('loads the repository script policy from the workspace root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-exec-config-'));
    const previousRoot = process.env.CONTEXTOS_REPO_ROOT;
    try {
      fs.mkdirSync(path.join(root, '.contextos'));
      fs.writeFileSync(
        path.join(root, '.contextos', 'config.json'),
        JSON.stringify({ execAllowRepoScripts: true })
      );
      process.env.CONTEXTOS_REPO_ROOT = root;
      delete process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
      expect(repoScriptsAllowed()).toBe(true);
    } finally {
      if (previousRoot === undefined) delete process.env.CONTEXTOS_REPO_ROOT;
      else process.env.CONTEXTOS_REPO_ROOT = previousRoot;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('confines npm prefix values in equals and split forms', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-exec-root-'));
    fs.mkdirSync(path.join(root, 'inside'));
    try {
      expect(validateCommandArguments(root, root, ['test', '--prefix=../outside'])).toContain(
        'traversal'
      );
      expect(validateCommandArguments(root, root, ['test', '--prefix', '../outside'])).toContain(
        'traversal'
      );
      expect(validateCommandArguments(root, root, ['test', '--runner-root=..'])).toContain(
        'traversal'
      );
      expect(validateCommandArguments(root, root, ['test', '-p../outside'])).toContain('traversal');
      expect(validateCommandArguments(root, root, ['test', '-C../outside'])).toContain('traversal');
      expect(validateCommandArguments(root, root, ['test', '--prefix=inside'])).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects global/script-shell execution switches', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-exec-root-'));
    try {
      expect(validateCommandArguments(root, root, ['test', '--global'])).toContain('not allowed');
      expect(validateCommandArguments(root, root, ['test', '--script-shell=sh'])).toContain(
        'not allowed'
      );
      expect(validateCommandArguments(root, root, ['test', '--', '--run'])).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects recursive symlink-follow options, including combined short flags', () => {
    expect(validateSymlinkFollowOptions('find', ['-L', '.'])).toMatch(/symlink/i);
    expect(validateSymlinkFollowOptions('find', ['-follow', '.'])).toMatch(/symlink/i);
    expect(validateSymlinkFollowOptions('grep', ['-nR', 'needle', '.'])).toMatch(/symlink/i);
    expect(
      validateSymlinkFollowOptions('grep', ['--dereference-recursive', 'needle', '.'])
    ).toMatch(/symlink/i);
    expect(validateSymlinkFollowOptions('ls', ['-aL', '.'])).toMatch(/symlink/i);
    expect(validateSymlinkFollowOptions('tree', ['-al', '.'])).toMatch(/symlink/i);
    expect(validateSymlinkFollowOptions('ls', ['-la', '.'])).toBeNull();
    expect(validateSymlinkFollowOptions('grep', ['-r', 'needle', '.'])).toBeNull();
  });

  it('enforces prefix and symlink confinement through the registered handler', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-exec-handler-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-exec-handler-outside-'));
    const previousRoot = process.env.CONTEXTOS_REPO_ROOT;
    const previousScripts = process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
    try {
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside');
      fs.symlinkSync(outside, path.join(root, 'linked'), 'dir');
      process.env.CONTEXTOS_REPO_ROOT = root;
      process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = '1';

      let handler:
        | ((input: {
            command: string;
            cwd?: string;
          }) => Promise<{ isError?: boolean; content: Array<{ text?: string }> }>)
        | undefined;
      const server = {
        tool: (...args: unknown[]) => {
          handler = args[3] as typeof handler;
        }
      };
      registerExecuteTool(server as never);
      expect(handler).toBeDefined();

      const outsidePrefix = await handler!({ command: 'npm test --prefix=../outside', cwd: root });
      expect(outsidePrefix.isError).toBe(true);
      expect(outsidePrefix.content[0]?.text).toContain('traversal');

      const symlinkPath = await handler!({ command: 'cat linked/secret.txt', cwd: root });
      expect(symlinkPath.isError).toBe(true);
      expect(symlinkPath.content[0]?.text).toContain('traversal');
    } finally {
      if (previousRoot === undefined) delete process.env.CONTEXTOS_REPO_ROOT;
      else process.env.CONTEXTOS_REPO_ROOT = previousRoot;
      if (previousScripts === undefined) delete process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
      else process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = previousScripts;
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  describe('execution environment', () => {
    const previous = new Map<string, string | undefined>();
    const keys = ['NODE_OPTIONS', 'npm_config_prefix', 'AWS_SECRET_ACCESS_KEY', 'PATH'];

    beforeEach(() => {
      for (const key of keys) previous.set(key, process.env[key]);
    });

    afterEach(() => {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it('removes ambient runtime and secret variables while pinning npm paths', () => {
      process.env.NODE_OPTIONS = '--require=outside.js';
      process.env.npm_config_prefix = '/outside';
      process.env.AWS_SECRET_ACCESS_KEY = 'secret';
      const env = buildExecutionEnv('/workspace');

      expect(env.NODE_OPTIONS).toBeUndefined();
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.npm_config_prefix).toBe('/workspace');
      expect(env.npm_config_global).toBe('false');
      expect(env.npm_config_userconfig).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null');
    });
  });
});
