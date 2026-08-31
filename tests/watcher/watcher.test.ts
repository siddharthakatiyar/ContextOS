import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { startWatcher } from '../../src/core/watcher/index.js';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { BackgroundIndexer } from '../../src/core/daemon/background-indexer.js';
import chokidar from 'chokidar';

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn().mockReturnValue({
      on: vi.fn().mockReturnThis(),
      close: vi.fn()
    })
  }
}));

describe('Watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('instantiates chokidar with followSymlinks set to false', () => {
    // We just need a dummy db instance to pass in
    const db = {
      getInstance: () => ({})
    } as unknown as DB;

    startWatcher(db);

    expect(chokidar.watch).toHaveBeenCalled();
    const callArgs = vi.mocked(chokidar.watch).mock.calls[0];
    const options = callArgs[1] as { followSymlinks?: boolean };

    expect(options).toBeDefined();
    expect(options.followSymlinks).toBe(false);
  });

  it('replays burst events and changes received while a bulk index is active', async () => {
    const db = {
      getInstance: () => ({})
    } as unknown as DB;
    const stats = {
      filesProcessed: 1,
      chunksCreated: 1,
      relationshipsFound: 0,
      durationMs: 1
    };
    const indexFile = vi.spyOn(Indexer.prototype, 'indexFile').mockResolvedValue(stats);

    let finishBulk: (() => void) | undefined;
    const bulkRun = new Promise<void>((resolve) => {
      finishBulk = resolve;
    });
    const startFullIndex = vi
      .spyOn(BackgroundIndexer.prototype, 'startFullIndex')
      .mockReturnValue(bulkRun);

    startWatcher(db, '/repo');
    const watcher = vi.mocked(chokidar.watch).mock.results[0].value as {
      on: ReturnType<typeof vi.fn>;
    };
    const changeHandler = watcher.on.mock.calls.find(([event]) => event === 'change')?.[1] as
      ((filePath: string) => void) | undefined;
    expect(changeHandler).toBeDefined();

    for (let i = 0; i < 100; i++) changeHandler?.(`/repo/file-${i}.ts`);
    expect(startFullIndex).toHaveBeenCalledOnce();

    const duringBulk = '/repo/edited-during-bulk.ts';
    changeHandler?.(duringBulk);
    expect(indexFile).not.toHaveBeenCalledWith(duringBulk, 'repo');

    finishBulk?.();
    await vi.waitFor(() => {
      expect(indexFile).toHaveBeenCalledWith(duringBulk, 'repo');
      // The event that triggered the bulk pass is also reconciled afterward,
      // preventing pre-bulk queued/in-flight work from winning with stale data.
      expect(indexFile).toHaveBeenCalledWith('/repo/file-99.ts', 'repo');
    });
  });
});
