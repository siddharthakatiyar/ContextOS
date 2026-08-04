import fs from 'fs';
import path from 'path';

/**
 * Checks if a file is likely a binary file by looking for null bytes
 * in the first 8000 bytes. This avoids loading massive files into memory.
 */
export function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(8000);
    const bytesRead = fs.readSync(fd, buffer, 0, 8000, 0);
    fs.closeSync(fd);

    for (let i = 0; i < bytesRead; i++) {
      if (buffer[i] === 0) {
        return true;
      }
    }
  } catch {
    // If we can't read it, it's safer to skip it
    return true;
  }
  return false;
}

/**
 * Checks if a text file is likely auto-generated or minified.
 */
export function isGeneratedFile(filePath: string, content: string): boolean {
  const base = path.basename(filePath).toLowerCase();

  // 1. Check known generated/lockfile naming patterns
  if (
    base === 'package-lock.json' ||
    base === 'yarn.lock' ||
    base === 'pnpm-lock.yaml' ||
    base === 'bun.lockb' ||
    base === 'lazy-lock.json' ||
    base === 'cargo.lock'
  ) {
    return true;
  }
  if (base.endsWith('.min.js') || base.endsWith('-min.js') || base.endsWith('.min.css')) {
    return true;
  }

  // 2. Check header comments (e.g. // @generated, /* eslint-disable */)
  // We only look at the first 500 chars to save time
  const head = content.slice(0, 500).toLowerCase();
  if (
    head.includes('@generated') ||
    head.includes('auto-generated') ||
    head.includes('/* eslint-disable */') ||
    head.includes('do not edit')
  ) {
    return true;
  }

  // 3. Minification heuristics
  // Check average line length and max line length in the first 200 lines
  const lines = content.slice(0, 50000).split('\n').slice(0, 200);
  if (lines.length > 0) {
    let totalLength = 0;
    let maxLength = 0;
    for (const line of lines) {
      const len = line.length;
      totalLength += len;
      if (len > maxLength) maxLength = len;
    }
    const avgLength = totalLength / lines.length;

    if (avgLength > 500 || maxLength > 5000) {
      return true;
    }
  }

  return false;
}
