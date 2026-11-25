import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
const execute = promisify(execFile);
async function gitAsync(root: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', ['-C', root, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
  });
  return stdout.trimEnd();
}
function canonical(input: string): string {
  try {
    return fs.realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}
/** Compare filesystem identity without folding distinct paths on case-sensitive volumes. */
export function sameDirectory(expected: string | null, actual: string | null): boolean {
  if (expected === null || actual === null) return expected === actual;
  if (canonical(expected) === canonical(actual)) return true;
  try {
    const a = fs.statSync(expected);
    const b = fs.statSync(actual);
    return a.isDirectory() && b.isDirectory() && a.ino !== 0 && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/** Resolve Git's potentially relative common directory against the checkout, not process.cwd(). */
export function gitCommonDirectory(root: string): string {
  const directory = canonical(root);
  return canonical(path.resolve(directory, git(directory, ['rev-parse', '--git-common-dir'])));
}

function* discover(
  input: string
): Generator<{ root: string; args: string[] }, DiscoveredProject, string> {
  const directory = fs.realpathSync(input);
  if (!fs.statSync(directory).isDirectory()) throw new Error(`Not a directory: ${input}`);
  let root: string;
  let commonDir: string;
  try {
    root = canonical(yield { root: directory, args: ['rev-parse', '--show-toplevel'] });
    commonDir = canonical(
      yield { root, args: ['rev-parse', '--path-format=absolute', '--git-common-dir'] }
    );
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
  const records = (yield { root, args: ['worktree', 'list', '--porcelain', '-z'] })
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
        gitDir = canonical(yield { root: checkout, args: ['rev-parse', '--absolute-git-dir'] });
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
      branch = yield { root, args: ['symbolic-ref', '--short', 'HEAD'] };
    } catch {
      /* detached */
    }
    worktrees.push({
      rootPath: root,
      gitDir: canonical(yield { root, args: ['rev-parse', '--absolute-git-dir'] }),
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

export function discoverProject(input: string): DiscoveredProject {
  const job = discover(input);
  let step = job.next();
  while (!step.done) {
    let value: string;
    try {
      value = git(step.value.root, step.value.args);
    } catch (error) {
      step = job.throw(error);
      continue;
    }
    step = job.next(value);
  }
  return step.value;
}
export async function discoverProjectAsync(input: string): Promise<DiscoveredProject> {
  const job = discover(input);
  let step = job.next();
  while (!step.done) {
    let value: string;
    try {
      value = await gitAsync(step.value.root, step.value.args);
    } catch (error) {
      step = job.throw(error);
      continue;
    }
    step = job.next(value);
  }
  return step.value;
}
export async function gitCommonDirectoryAsync(root: string): Promise<string> {
  const directory = canonical(root);
  return canonical(
    path.resolve(directory, await gitAsync(directory, ['rev-parse', '--git-common-dir']))
  );
}
export async function localBranchesAsync(root: string): Promise<Set<string>> {
  return new Set(
    (await gitAsync(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']))
      .split('\n')
      .filter(Boolean)
  );
}
