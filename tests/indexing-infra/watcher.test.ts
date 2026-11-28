import fs from 'node:fs';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import chokidar from 'chokidar';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { startWatcher } from '../../src/core/watcher/index.js';

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockImplementation(() => ({ on: vi.fn().mockReturnThis(), close: vi.fn() }))
  }
}));

it('watches and persists safe Dockerfile and env-example updates while excluding live env files', async () => {
  const group = await createFixtureGroup();
  try {
    const source = group.sources[0];
    const runtime = group.runtime.get(source);
    const watcher = startWatcher(runtime.db, source.rootPath);
    const call = vi.mocked(chokidar.watch).mock.calls.at(-1)!;
    const ignored = call[1]!.ignored as (file: string) => boolean;
    const nativeWatcher = vi.mocked(chokidar.watch).mock.results.at(-1)!.value as {
      on: ReturnType<typeof vi.fn>;
    };
    const change = nativeWatcher.on.mock.calls.find(([event]) => event === 'change')![1] as (
      file: string
    ) => void;
    for (const [name, content, language] of [
      ['Dockerfile', 'FROM alpine:3\nENV NORMAL=watcherHiddenDocker', 'dockerfile'],
      ['.env.example', 'NORMAL=watcherHiddenEnv', 'env-example']
    ]) {
      const file = path.join(source.rootPath, name);
      fs.writeFileSync(file, content);
      expect(ignored(file)).toBe(false);
      change(file);
      await watcher.waitForIdle!();
      const chunks = runtime.db
        .getInstance()
        .prepare('SELECT * FROM chunks WHERE source_file=?')
        .all(file);
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks).toEqual(expect.arrayContaining([expect.objectContaining({ language })]));
      expect(JSON.stringify(chunks)).not.toContain('watcherHidden');
    }
    expect(ignored(path.join(source.rootPath, '.env'))).toBe(true);
    expect(ignored(path.join(source.rootPath, '.env.production'))).toBe(true);
    await watcher.close();
  } finally {
    await group.cleanup();
  }
});
