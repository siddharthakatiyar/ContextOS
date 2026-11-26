import { execFileSync } from 'node:child_process';
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectGitFiles } from '../../src/cli/utils/project-git-files.js';

afterEach(() => vi.resetAllMocks());

describe('project Git file queries', () => {
  it('queries literal candidate paths instead of buffering the entire Git index', () => {
    const root = path.resolve('scratch', 'large-repo');
    const exec = vi.mocked(execFileSync).mockImplementation(((
      _command: string,
      args?: readonly string[]
    ) => {
      if (args?.includes('rev-parse')) return '.git/info/exclude\n';
      if (args?.at(-1) === 'AGENTS.md') return 'AGENTS.md\0';
      return '';
    }) as typeof execFileSync);
    const git = projectGitFiles(root);
    expect(git.canWrite(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(git.canWrite(path.join(root, 'CLAUDE.md'))).toBe(true);
    expect(exec.mock.calls.slice(1).map((call) => call[1])).toEqual([
      ['-C', root, '--literal-pathspecs', 'ls-files', '-z', '--cached', '--', 'AGENTS.md'],
      ['-C', root, '--literal-pathspecs', 'ls-files', '-z', '--cached', '--', 'CLAUDE.md']
    ]);
  });

  it('safely refuses checkout writes when Git index queries fail', () => {
    vi.mocked(execFileSync).mockImplementation(((_command: string, args?: readonly string[]) => {
      if (args?.includes('rev-parse')) return '.git/info/exclude\n';
      throw Object.assign(new Error('index unavailable'), { code: 'ENOBUFS' });
    }) as typeof execFileSync);
    const root = path.resolve('scratch', 'broken-index');
    const git = projectGitFiles(root);
    expect(git.canWrite(path.join(root, 'AGENTS.md'))).toBe(false);
    expect(() => git.exclude([path.join(root, 'AGENTS.md')])).not.toThrow();
  });
});
