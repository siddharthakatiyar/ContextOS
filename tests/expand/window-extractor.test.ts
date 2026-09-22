import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractTermWindows,
  MAX_EXPAND_FILE_BYTES,
  MAX_EXPAND_FILE_TOKENS,
  MAX_EXPAND_WINDOW_LINES,
  MAX_EXPAND_LINE_CHARS
} from '../../src/core/expand/window-extractor.js';

describe('ctx_expand input and file bounds', () => {
  it('rejects oversized files before reading their contents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-expand-'));
    const filePath = path.join(root, 'large.ts');
    try {
      fs.writeFileSync(filePath, Buffer.alloc(MAX_EXPAND_FILE_BYTES + 1, 'x'));
      expect(extractTermWindows(filePath, ['x'])).toContain('File too large');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('clamps direct callers to bounded windows and output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-expand-'));
    const filePath = path.join(root, 'source.ts');
    try {
      fs.writeFileSync(filePath, Array.from({ length: 5000 }, (_, i) => `needle ${i}`).join('\n'));
      const result = extractTermWindows(filePath, ['needle'], {
        linesBefore: MAX_EXPAND_WINDOW_LINES * 10,
        linesAfter: MAX_EXPAND_WINDOW_LINES * 10,
        maxTokens: MAX_EXPAND_FILE_TOKENS * 10
      });
      expect(result.length).toBeGreaterThan(0);
      expect(result).toContain('[Truncated]');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks a giant matching line before appending it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-expand-'));
    const filePath = path.join(root, 'giant.ts');
    try {
      fs.writeFileSync(filePath, `needle ${'x'.repeat(MAX_EXPAND_LINE_CHARS * 2)}\n`);
      const result = extractTermWindows(filePath, ['needle'], { maxTokens: 20 });
      expect(result).toContain('[Truncated]');
      expect(result.length).toBeLessThan(MAX_EXPAND_LINE_CHARS);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
