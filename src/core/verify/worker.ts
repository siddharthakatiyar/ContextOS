import { parentPort, workerData } from 'node:worker_threads';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { verifyKnowledge } from './index.js';
import { createSweepScheduler, verificationInterval } from './scheduler.js';

if (parentPort) {
  const { home, viewIds: selectedViews } = workerData as { home: string; viewIds?: string[] };
  const registry = new WorkspaceRegistry(home);
  registry.deferReconciliation = true;
  createSweepScheduler({
    interval: verificationInterval(),
    initialSweep: true,
    generations: () =>
      registry
        .listAll()
        .filter((source) => !selectedViews || selectedViews.includes(source.repoId))
        .map((source) => ({
          viewId: source.repoId,
          generation: source.generation,
          ready: source.active && source.state === 'ready'
        })),
    run: (viewIds) => verifyKnowledge({ scope: { home, viewIds: viewIds ?? selectedViews } }),
    onError: (error) => console.error('Knowledge verification sweep failed:', error)
  });
  // Keep this worker alive without keeping its owning daemon alive.
  parentPort.on('message', () => {});
}
