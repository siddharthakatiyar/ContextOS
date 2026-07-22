import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWithinWorkspace } from '../../src/utils/fs-guard.js';

describe('resolveWithinWorkspace (MCP filesystem boundary)', () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxos-fsguard-'));
    root = path.join(base, 'workspace');
    outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, 'inside.txt'), 'ok');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  });

  it('allows a file inside the workspace', () => {
    expect(resolveWithinWorkspace(root, 'inside.txt')).toBe(path.join(root, 'inside.txt'));
  });

  it('allows a not-yet-existing path inside the workspace', () => {
    expect(resolveWithinWorkspace(root, 'sub/new-file.ts')).toBe(
      path.join(root, 'sub', 'new-file.ts')
    );
  });

  it('rejects an absolute path outside the workspace', () => {
    expect(resolveWithinWorkspace(root, path.join(outside, 'secret.txt'))).toBeNull();
  });

  it('rejects a ../ traversal', () => {
    expect(resolveWithinWorkspace(root, '../outside/secret.txt')).toBeNull();
  });

  it('rejects a bare ".." segment', () => {
    expect(resolveWithinWorkspace(root, '..')).toBeNull();
  });

  it('rejects a sibling directory that shares the root name prefix', () => {
    // Guards the missing-path.sep prefix bug: "<root>-evil" must not pass.
    expect(resolveWithinWorkspace(root, path.join(root + '-evil', 'x'))).toBeNull();
  });

  it('rejects a symlink that points outside the workspace', () => {
    const link = path.join(root, 'escape');
    try {
      fs.symlinkSync(outside, link);
    } catch {
      return; // filesystem does not permit symlinks — nothing to assert
    }
    // Lexically inside root, but realpath escapes → must be rejected.
    expect(resolveWithinWorkspace(root, 'escape/secret.txt')).toBeNull();
  });
});
