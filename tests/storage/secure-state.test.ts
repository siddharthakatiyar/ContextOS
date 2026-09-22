import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ensurePrivateStateDir,
  preparePrivateStateFile,
  removePrivateStateFile,
  writePrivateStateFile,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE
} from '../../src/utils/secure-state.js';

const mode = (filePath: string) => fs.statSync(filePath).mode & 0o777;

describe('private ContextOS state paths', () => {
  it('creates owner-only directories and files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-state-'));
    try {
      const stateDir = ensurePrivateStateDir(path.join(root, '.contextos'));
      const stateFile = path.join(stateDir, 'status.json');
      writePrivateStateFile(stateFile, '{"ok":true}');

      expect(mode(stateDir)).toBe(PRIVATE_DIR_MODE);
      expect(mode(stateFile)).toBe(PRIVATE_FILE_MODE);
      expect(fs.readFileSync(stateFile, 'utf8')).toBe('{"ok":true}');
      expect(preparePrivateStateFile(stateFile)).toBe(stateFile);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked state directory without touching its target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-state-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-target-'));
    try {
      const stateDir = path.join(root, '.contextos');
      fs.symlinkSync(outside, stateDir, 'dir');
      expect(() => ensurePrivateStateDir(stateDir)).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a symlinked state file instead of following it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-state-'));
    const outside = path.join(root, 'outside.txt');
    try {
      const stateDir = ensurePrivateStateDir(path.join(root, '.contextos'));
      fs.writeFileSync(outside, 'original');
      fs.symlinkSync(outside, path.join(stateDir, 'status.json'));

      expect(() => writePrivateStateFile(path.join(stateDir, 'status.json'), 'changed')).toThrow(
        /symlink/
      );
      expect(fs.readFileSync(outside, 'utf8')).toBe('original');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects deleting a symlinked state file instead of touching its target', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-state-'));
    const outside = path.join(root, 'outside.txt');
    try {
      const stateDir = ensurePrivateStateDir(path.join(root, '.contextos'));
      fs.writeFileSync(outside, 'original');
      fs.symlinkSync(outside, path.join(stateDir, 'status.json'));

      expect(() => removePrivateStateFile(path.join(stateDir, 'status.json'))).toThrow(/symlink/);
      expect(fs.readFileSync(outside, 'utf8')).toBe('original');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
