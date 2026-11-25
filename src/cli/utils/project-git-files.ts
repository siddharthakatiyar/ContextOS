import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertNoSymlinkInPath } from '../../utils/secure-state.js';

/** Keep generated checkout files local, including in linked Git worktrees. */
export function projectGitFiles(root: string): {
  canWrite: (file: string) => boolean;
  exclude: (files: string[]) => void;
} {
  const git = (args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    });
  let excludeFile: string;
  try {
    excludeFile = path.resolve(root, git(['rev-parse', '--git-path', 'info/exclude']).trim());
  } catch {
    // Plain directories have no local Git metadata to update.
    return { canWrite: () => true, exclude: () => {} };
  }
  const relative = (file: string) => path.relative(root, file).split(path.sep).join('/');
  const writable = new Map<string, boolean>();
  const canWrite = (file: string) => {
    const candidate = relative(file);
    if (!writable.has(candidate)) {
      try {
        // Query only the candidate, never buffer the entire repository's index.
        const tracked = git(['--literal-pathspecs', 'ls-files', '-z', '--cached', '--', candidate]);
        writable.set(candidate, tracked.length === 0);
      } catch {
        // On an unreadable index, preserve the checkout rather than overwrite a tracked file.
        writable.set(candidate, false);
      }
    }
    return writable.get(candidate)!;
  };
  return {
    canWrite,
    exclude(files) {
      const patterns = [...new Set(files.filter(canWrite).map((file) => `/${relative(file)}`))];
      if (!patterns.length) return;
      assertNoSymlinkInPath(excludeFile);
      const previous = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf8') : '';
      const existing = new Set(previous.split(/\r?\n/));
      const missing = patterns.filter((pattern) => !existing.has(pattern));
      if (!missing.length) return;
      fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
      fs.appendFileSync(
        excludeFile,
        `${previous && !previous.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`
      );
    }
  };
}
