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
  const tracked = new Set(git(['ls-files', '-z', '--cached']).split('\0'));
  const canWrite = (file: string) => !tracked.has(relative(file));
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
