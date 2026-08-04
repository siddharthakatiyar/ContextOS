import { describe, it, expect, vi } from 'vitest';
import { startWatcher } from '../../src/core/watcher/index.js';
import { DB } from '../../src/core/storage/database.js';
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
});
