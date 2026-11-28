import { Worker } from 'node:worker_threads';

/** All scanning/deletion runs off the daemon's indexing and handshake event loop. */
export function startExpiryScheduler(
  home: string,
  viewIds?: string[]
): { stop: () => Promise<void> } {
  try {
    const worker = new Worker(new URL('./expiry-worker.js', import.meta.url), {
      workerData: { home, viewIds }
    });
    worker.unref();
    worker.on('error', (error) =>
      console.error(
        'Knowledge expiry sweep failed:',
        error instanceof Error ? error.message : String(error)
      )
    );
    return {
      async stop() {
        await worker.terminate();
      }
    };
  } catch (error) {
    console.error(
      'Knowledge expiry worker could not start:',
      error instanceof Error ? error.message : String(error)
    );
    return { async stop() {} };
  }
}
