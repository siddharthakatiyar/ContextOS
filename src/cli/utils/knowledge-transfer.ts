import type Database from 'better-sqlite3';
import { GraphStore } from '../../core/knowledge/graph-store.js';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { DB } from '../../core/storage/database.js';

export function withTransferGraph<T>(
  repoId: string | undefined,
  action: (graph: GraphStore, registry: WorkspaceRegistry) => T,
  primaryDb?: Database.Database
): T | undefined {
  if (!repoId) return undefined;
  const registry = new WorkspaceRegistry();
  const dbs: DB[] = [];
  const graph = new GraphStore({
    resolve: (id) => {
      const source = registry.resolve(id);
      if (id === repoId && primaryDb) return { source, db: primaryDb };
      const db = new DB(source.dbPath);
      dbs.push(db);
      return { source, db: db.getInstance() };
    }
  });
  try {
    return action(graph, registry);
  } finally {
    graph.close();
    for (const db of dbs) db.close();
    registry.close();
  }
}
