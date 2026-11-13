import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface DiscoveredWorktree {
  rootPath: string;
  gitDir: string | null;
  commonDir: string | null;
  branch: string | null;
  head: string | null;
  locked: boolean;
  prunable: boolean;
  available: boolean;
}
export interface DiscoveredProject {
  rootPath: string;
  commonDir: string | null;
  worktrees: DiscoveredWorktree[];
}
function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 15000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  }).trimEnd();
}
function canonical(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
export function discoverProject(input: string): DiscoveredProject {
  const directory = fs.realpathSync(input);
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Not a directory: ${input}`);
  let root: string;
  let commonDir: string;
  try {
    root = canonical(git(directory, ['rev-parse', '--show-toplevel']));
    commonDir = canonical(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  } catch {
    return {
      rootPath: directory,
      commonDir: null,
      worktrees: [
        {
          rootPath: directory,
          gitDir: null,
          commonDir: null,
          branch: null,
          head: null,
          locked: false,
          prunable: false,
          available: true
        }
      ]
    };
  }
  // NUL-delimited output handles spaces, quotes, tabs and newlines in paths.
  const records = git(root, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0\0')
    .filter(Boolean);
  const worktrees: DiscoveredWorktree[] = [];
  for (const record of records) {
    const fields = record.split('\0');
    const rawRoot = fields.find((f) => f.startsWith('worktree '))?.slice(9);
    if (!rawRoot || fields.includes('bare')) continue;
    const checkout = canonical(rawRoot);
    const available = fs.existsSync(checkout);
    let gitDir: string | null = null;
    if (available) {
      try {
        gitDir = canonical(git(checkout, ['rev-parse', '--absolute-git-dir']));
      } catch {
        /* unavailable checkout */
      }
    }
    worktrees.push({
      rootPath: checkout,
      gitDir,
      commonDir,
      branch:
        fields
          .find((f) => f.startsWith('branch '))
          ?.slice(7)
          .replace(/^refs\/heads\//, '') ?? null,
      head: (() => {
        const head = fields.find((f) => f.startsWith('HEAD '))?.slice(5);
        return head && !/^0+$/.test(head) ? head : null;
      })(),
      locked: fields.some((f) => f === 'locked' || f.startsWith('locked ')),
      prunable: fields.some((f) => f === 'prunable' || f.startsWith('prunable ')),
      available
    });
  }
  // An unborn primary checkout is valid, even before the first commit.
  if (!worktrees.some((w) => w.rootPath === root)) {
    let branch: string | null = null;
    try {
      branch = git(root, ['symbolic-ref', '--short', 'HEAD']);
    } catch {
      /* detached */
    }
    worktrees.push({
      rootPath: root,
      gitDir: canonical(git(root, ['rev-parse', '--absolute-git-dir'])),
      commonDir,
      branch,
      head: null,
      locked: false,
      prunable: false,
      available: true
    });
  }
  const primary =
    worktrees.find((w) => w.gitDir === commonDir)?.rootPath ?? worktrees[0]?.rootPath ?? root;
  return { rootPath: primary, commonDir, worktrees };
}
export function localBranches(root: string): Set<string> {
  return new Set(
    git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'])
      .split('\n')
      .filter(Boolean)
  );
}
