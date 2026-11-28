import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Debounce after the ready generation is committed; work never runs in the
 * indexing/handshake event loop and never holds an indexing lease. */
const pending = new Map<string, NodeJS.Timeout>();
const active = new Set<string>();
const rerun = new Map<string, () => void>();
export function scheduleInfraImport(home: string, viewId: string): void {
  const url = new URL('./worker.js', import.meta.url);
  if (!fs.existsSync(url)) return; // Source-only hosts have no built worker asset.
  const key = JSON.stringify([home, viewId]);
  const launch = () => {
    if (active.has(key)) {
      rerun.set(key, launch);
      return;
    }
    active.add(key);
    const worker = spawn(process.execPath, [fileURLToPath(url), home, viewId], {
      detached: true,
      stdio: 'ignore'
    });
    worker.unref();
    worker.on('error', (error) =>
      console.error(
        'Infrastructure import failed:',
        error instanceof Error ? error.message : String(error)
      )
    );
    worker.once('close', (code) => {
      if (code)
        console.error(
          `Infrastructure import process exited with code ${code}; retry with contextos infra import.`
        );
      active.delete(key);
      const next = rerun.get(key);
      rerun.delete(key);
      next?.();
    });
  };
  const previous = pending.get(key);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(() => {
    pending.delete(key);
    launch();
  }, 1500);
  // Keep short-lived CLI hosts alive until the detached process is launched.
  pending.set(key, timer);
}
