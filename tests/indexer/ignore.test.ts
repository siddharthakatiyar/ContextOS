import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIndexIgnore } from '../../src/core/indexer/ignore.js';

describe('shared index ignore policy', () => {
  it('applies root gitignore, contextosignore, configured rules, and safety rules', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ignore-'));
    try {
      fs.writeFileSync(root + '/.gitignore', 'secrets.json\nignored-dir/*\n!ignored-dir/keep.ts\n');
      fs.writeFileSync(root + '/.contextosignore', 'generated/**\n');
      const policy = createIndexIgnore(root, ['configured/**']);

      expect(policy.ignores(path.join(root, 'secrets.json'))).toBe(true);
      expect(policy.ignores(path.join(root, 'ignored-dir/drop.ts'))).toBe(true);
      expect(policy.ignores(path.join(root, 'ignored-dir/keep.ts'))).toBe(false);
      expect(policy.ignores(path.join(root, 'generated/out.ts'))).toBe(true);
      expect(policy.ignores(path.join(root, 'configured/out.ts'))).toBe(true);
      expect(policy.ignores(path.join(root, 'node_modules/pkg/index.js'))).toBe(true);
      expect(policy.globIgnore).toContain('**/node_modules/**');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('cannot re-enable built-in safety exclusions with negation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ignore-'));
    try {
      fs.writeFileSync(root + '/.gitignore', '!node_modules/visible.js\n');
      const policy = createIndexIgnore(root, ['!dist/visible.js']);
      expect(policy.ignores(path.join(root, 'node_modules/visible.js'))).toBe(true);
      expect(policy.ignores(path.join(root, 'dist/visible.js'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps configured ignorePatterns on glob semantics, including braces and negation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ignore-'));
    try {
      const policy = createIndexIgnore(root, [
        'generated/{a,b}/**',
        'generated/**',
        '!generated/keep.ts'
      ]);
      expect(policy.ignores(path.join(root, 'generated/a/out.ts'))).toBe(true);
      expect(policy.ignores(path.join(root, 'generated/b/out.ts'))).toBe(true);
      expect(policy.ignores(path.join(root, 'generated/other.ts'))).toBe(true);
      expect(policy.ignores(path.join(root, 'generated/keep.ts'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('treats paths outside the configured root as ignored', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ignore-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-ignore-outside-'));
    try {
      const policy = createIndexIgnore(root);
      expect(policy.ignores(path.join(outside, 'secret.txt'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
