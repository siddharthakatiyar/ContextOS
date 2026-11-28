import { parentPort, workerData } from 'node:worker_threads';
import { WorkspaceRegistry } from '../workspace/registry.js';
import { sweepExpiredKnowledge } from './review.js';
if (parentPort) {
  const { home, viewIds } = workerData as { home: string; viewIds?: string[] };
  const registry = new WorkspaceRegistry(home);
  registry.deferReconciliation = true;
  const run = () => {
    try {
      const sources = registry.listAll().filter((s) => !viewIds || viewIds.includes(s.repoId));
      // Separate groups keep group-scoped user facts within their own boundary.
      for (const source of sources) {
        const scope = registry.select({ repo: [source.repoId] }, source.rootPath);
        sweepExpiredKnowledge({ home, scope });
      }
      for (const group of registry.groups()) {
        const members = registry
          .list(group.id, true)
          .filter((s) => !viewIds || viewIds.includes(s.repoId));
        if (members.length)
          sweepExpiredKnowledge({
            home,
            scope: {
              groupId: group.id,
              workspaceId: group.id,
              sources: members,
              repoIds: members.map((s) => s.repoId)
            }
          });
      }
      // Cross-view records need all their evidence views selected together.
      if (sources.length)
        sweepExpiredKnowledge({ home, scope: { sources, repoIds: sources.map((s) => s.repoId) } });
    } catch (error) {
      console.error('Knowledge expiry sweep failed:', error);
    }
  };
  setTimeout(run, 5000).unref();
  setInterval(run, 60_000).unref();
  parentPort.on('message', () => {});
}
