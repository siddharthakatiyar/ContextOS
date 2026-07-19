import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ContextOSDaemon } from '../../src/core/daemon/daemon.js';

vi.mock('../../src/core/watcher/index.js', () => ({
  startWatcher: vi.fn(() => ({ close: vi.fn() }))
}));

// Mock DB resolution to not attempt real schema migrations during this test
vi.mock('../../src/core/storage/database.js', () => ({
  DB: {
    resolveDatabases: vi.fn(() => [{ getInstance: vi.fn(() => ({ pragma: vi.fn() })), close: vi.fn() }])
  }
}));

// Mock net to avoid real socket binds throwing EPERM
vi.mock('net', () => ({
  default: {
    createServer: vi.fn(() => ({
      on: vi.fn(),
      once: vi.fn((event, cb) => {
        if (event === 'error') {
          // Do nothing
        }
      }),
      listen: vi.fn((path, cb) => {
        if (cb) cb();
      }),
      close: vi.fn()
    })),
    createConnection: vi.fn()
  }
}));

describe('ContextOSDaemon Lifecycle', () => {
  let tmpdir: string;
  let projectDir: string;
  
  beforeEach(() => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-test-daemon-'));
    projectDir = path.join(tmpdir, 'project');
    fs.mkdirSync(projectDir);
  });

  it('cleans up stale PID file on start', async () => {
    const ctxDir = path.join(projectDir, '.contextos');
    fs.mkdirSync(ctxDir);
    const pidPath = path.join(ctxDir, 'daemon.pid');
    
    // Write a fake PID that definitely does not exist
    const fakePid = 999999;
    fs.writeFileSync(pidPath, String(fakePid));
    
    const daemon = new ContextOSDaemon(projectDir);
    
    // Inject a short local socket path so it doesn't exceed macOS 104 char limit
    const shortSocket = path.join(os.tmpdir(), `d-test-${Date.now()}.sock`);
    (daemon as any).socketPath = shortSocket;
    
    // Since PID doesn't exist, process.kill(999999, 0) throws ESRCH
    // The daemon should catch this and delete the PID file
    // Note: on Windows process.kill behavior might differ, but ESRCH is standard in Node's shim
    let caughtESRCH = false;
    const originalKill = process.kill;
    process.kill = (pid, sig) => {
      if (pid === fakePid) {
        caughtESRCH = true;
        const err = new Error('No such process');
        (err as any).code = 'ESRCH';
        throw err;
      }
      return originalKill(pid, sig);
    };

    try {
      // We don't actually await start because it binds a server which makes the test hang if not stopped cleanly
      // Instead, we just execute it and immediately stop it once the socket is open
      const startPromise = daemon.start();
      
      // Wait for PID file to be rewritten by the new daemon process
      await new Promise(r => setTimeout(r, 200));
      
      expect(caughtESRCH).toBe(true);
      
      // It should have overwritten the PID file with our own PID
      const currentPidStr = fs.readFileSync(pidPath, 'utf-8');
      expect(parseInt(currentPidStr)).toBe(process.pid);
      
    } finally {
      process.kill = originalKill;
      daemon.stop();
      try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch {}
    }
  });
});
