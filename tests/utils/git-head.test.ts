import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGitCommit } from '../../src/utils/git-head.js';

let base: string;
const OID = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const write = (file: string, value: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-git-head-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('readGitCommit', () => {
  it('reads real committed, unborn, loose, packed and detached checkouts', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', base, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    git('init', '-b', 'main');
    const gitDir = path.join(base, '.git');
    const read = () =>
      readGitCommit(gitDir, gitDir, fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8'));
    expect(read()).toBeNull();
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    );
    const commit = git('rev-parse', 'HEAD');
    expect(read()).toBe(commit);
    git('pack-refs', '--all');
    expect(fs.existsSync(path.join(gitDir, 'refs', 'heads', 'main'))).toBe(false);
    expect(read()).toBe(commit);
    git('checkout', '--detach');
    expect(read()).toBe(commit);
  });
  it('uses the linked worktree common directory for branch refs', () => {
    const common = path.join(base, 'common');
    const worktree = path.join(common, 'worktrees', 'feature');
    write(path.join(common, 'refs', 'heads', 'main'), OID);
    write(path.join(worktree, 'refs', 'heads', 'main'), OTHER);
    expect(readGitCommit(worktree, common, 'ref: refs/heads/main')).toBe(OID);
    write(path.join(worktree, 'refs', 'worktree', 'private'), OTHER);
    expect(readGitCommit(worktree, common, 'ref: refs/worktree/private')).toBe(OTHER);
    fs.rmSync(path.join(common, 'refs', 'heads', 'main'));
    write(path.join(common, 'packed-refs'), `${OID} refs/heads/main\n`);
    expect(readGitCommit(worktree, common, 'ref: refs/heads/main')).toBe(OID);
  });
  it('follows symbolic refs and prefers loose refs to packed refs', () => {
    write(path.join(base, 'refs', 'heads', 'alias'), 'ref: refs/heads/main\n');
    write(path.join(base, 'refs', 'heads', 'main'), OID);
    write(path.join(base, 'packed-refs'), `${OTHER} refs/heads/main\n`);
    expect(readGitCommit(base, base, 'ref: refs/heads/alias')).toBe(OID);
  });
  it('rejects cycles and excessive symref depth', () => {
    write(path.join(base, 'refs', 'heads', 'a'), 'ref: refs/heads/b');
    write(path.join(base, 'refs', 'heads', 'b'), 'ref: refs/heads/a');
    expect(() => readGitCommit(base, base, 'ref: refs/heads/a')).toThrow('Cyclic');
    for (let index = 0; index < 10; index++)
      write(path.join(base, 'refs', 'heads', String(index)), `ref: refs/heads/${index + 1}`);
    expect(() => readGitCommit(base, base, 'ref: refs/heads/0')).toThrow('too deep');
  });
  it.each([
    'ref: ../escape',
    'ref: refs/heads/../main',
    'ref: refs/heads/.private',
    'ref: refs/heads/main.lock',
    'ref: refs/heads/main\nextra',
    'garbage',
    'f'.repeat(39)
  ])('fails closed for malformed HEAD/ref %j', (head) => {
    expect(() => readGitCommit(base, base, head)).toThrow();
  });
  it('fails closed for loose and packed ref read errors rather than claiming unborn HEAD', () => {
    const actual = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...args: unknown[]
    ) => {
      if (String(file).endsWith(path.join('refs', 'heads', 'main')))
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return Reflect.apply(actual, fs, [file, ...args]);
    }) as typeof fs.readFileSync);
    expect(() => readGitCommit(base, base, 'ref: refs/heads/main')).toThrow('denied');
    vi.restoreAllMocks();
    fs.mkdirSync(path.join(base, 'packed-refs'));
    expect(() => readGitCommit(base, base, 'ref: refs/heads/main')).toThrow();
  });
  it('fails closed on malformed loose refs, duplicate packed refs and unsupported ref storage', () => {
    write(path.join(base, 'refs', 'heads', 'main'), 'not-a-commit');
    expect(() => readGitCommit(base, base, 'ref: refs/heads/main')).toThrow('Malformed');
    fs.rmSync(path.join(base, 'refs', 'heads', 'main'));
    write(path.join(base, 'packed-refs'), `${OID} refs/heads/main\n${OTHER} refs/heads/main\n`);
    expect(() => readGitCommit(base, base, 'ref: refs/heads/main')).toThrow('duplicate');
    fs.mkdirSync(path.join(base, 'reftable'));
    expect(() => readGitCommit(base, base, 'ref: refs/heads/missing')).toThrow('Unsupported');
  });
  it('accepts SHA-256 object IDs', () => {
    expect(readGitCommit(base, base, 'a'.repeat(64))).toBe('a'.repeat(64));
  });
});
