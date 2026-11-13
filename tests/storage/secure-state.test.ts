import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {
  ensurePrivateStateDir,
  preparePrivateStateFile,
  removePrivateStateFile,
  writePrivateStateFile,
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  getDaemonSocketPath,
  getDaemonControlSocketPath,
  secureBoundSocket
} from '../../src/utils/secure-state.js';

const mode = (filePath: string) => fs.statSync(filePath).mode & 0o777;

describe('private ContextOS state paths', () => {
  it.skipIf(process.platform === 'win32')(
    'binds private channels with a long home path',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-long-home-'));
      const home = path.join(root, 'nested-home-'.repeat(12));
      fs.mkdirSync(home);
      const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
      const addresses = [getDaemonSocketPath(root), getDaemonControlSocketPath(root, '.index')];
      try {
        expect(new Set(addresses).size).toBe(2);
        for (const address of addresses) {
          expect(Buffer.byteLength(address)).toBeLessThanOrEqual(100);
          expect(mode(path.dirname(address))).toBe(PRIVATE_DIR_MODE);
          const server = net.createServer((socket) => socket.end());
          try {
            await new Promise<void>((resolve, reject) => {
              server.once('error', reject);
              server.listen(address, resolve);
            });
            secureBoundSocket(address);
            expect(mode(address)).toBe(PRIVATE_FILE_MODE);
            await new Promise<void>((resolve, reject) => {
              const client = net.createConnection(address);
              client.once('error', reject);
              client.once('close', resolve);
            });
          } finally {
            if (server.listening)
              await new Promise<void>((resolve) => server.close(() => resolve()));
          }
        }
      } finally {
        homedir.mockRestore();
        fs.rmSync(root, { recursive: true, force: true });
        fs.rmSync(path.dirname(addresses[0]), { recursive: true, force: true });
      }
    }
  );

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

  it('allows the OS temp alias while rejecting a user-owned descendant symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-state-alias-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-private-target-'));
    try {
      // On macOS, root is commonly spelled through /var -> /private/var. That
      // system alias is safe to traverse; the state directory itself must still
      // be a real, owner-private directory.
      const stateDir = ensurePrivateStateDir(path.join(root, '.contextos'));
      expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(false);

      // A symlink introduced below the trusted OS alias remains untrusted and
      // must not redirect state creation into an arbitrary directory.
      const redirect = path.join(root, 'redirect');
      fs.symlinkSync(outside, redirect, 'dir');
      expect(() => ensurePrivateStateDir(path.join(redirect, 'state'))).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('accepts a state path rooted at macOS /tmp alias', () => {
    const root = fs.mkdtempSync('/tmp/contextos-private-state-tmp-alias-');
    try {
      const stateDir = ensurePrivateStateDir(path.join(root, '.contextos'));
      expect(fs.lstatSync(stateDir).isSymbolicLink()).toBe(false);
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
