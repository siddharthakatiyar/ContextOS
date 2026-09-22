import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

/**
 * Read the package version from the source tree or the compiled package.
 *
 * The CLI can run from tsx during development or from `dist/` after publish,
 * so the package file is intentionally located relative to this module rather
 * than the caller's working directory. A missing or malformed package file is
 * reported as `unknown` instead of advertising a stale release version.
 */
export function getPackageVersion(): string {
  const candidates = [
    path.join(moduleDirectory, '../../package.json'),
    path.join(moduleDirectory, '../../../package.json'),
    path.join(moduleDirectory, '../../../../package.json')
  ];

  for (const packagePath of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        return parsed.version;
      }
    } catch {
      // Try the next package location; source and compiled layouts differ.
    }
  }

  return 'unknown';
}
