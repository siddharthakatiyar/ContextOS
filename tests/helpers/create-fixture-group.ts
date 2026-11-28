import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { vi } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { WorkspaceRuntime } from '../../src/core/workspace/runtime.js';

/** Construct three real Git repositories, register a group and index in an isolated HOME.
 * Call cleanup in finally; like other HOME fixtures this is for non-concurrent tests.
 */
export async function createFixtureGroup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-130-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  const previous = {
    HOME: process.env.HOME,
    CONTEXTOS_EMBEDDINGS: process.env.CONTEXTOS_EMBEDDINGS
  };
  process.env.HOME = home;
  process.env.CONTEXTOS_EMBEDDINGS = '0';
  const registry = new WorkspaceRegistry();
  registry.ensureGroup('foundation-130');
  const runtime = new WorkspaceRuntime(registry, 'foundation-130');
  const cleanup = async () => {
    try {
      await runtime.close();
    } finally {
      registry.close();
      homedir.mockRestore();
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  try {
    const sources = [];
    for (const name of ['service-a', 'service-b', 'shared']) {
      const repo = path.join(root, name);
      fs.cpSync(
        fileURLToPath(new URL(`../fixtures/multi-repo-130/${name}`, import.meta.url)),
        repo,
        { recursive: true }
      );
      const git = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      git(['init', '-b', 'main']);
      git(['add', '.']);
      git([
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-m',
        'fixture'
      ]);
      const source = registry.register(repo, { name, group: 'foundation-130' });
      await runtime.get(source).index();
      sources.push(registry.resolve(source.repoId));
    }
    return {
      root,
      home,
      registry,
      runtime,
      sources,
      group: registry.group('foundation-130'),
      cleanup
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
