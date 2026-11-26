import fs from 'node:fs';
import path from 'node:path';
import { discoverProject } from './discovery.js';
import type { WorkspaceRegistry } from './registry.js';

/** Registry evidence only: do not crawl or register nested repositories. */
export function nestedProjectWarning(root: string, registry: WorkspaceRegistry): string | null {
  const canonical = fs.realpathSync(root);
  const descendants = registry.listAll().filter((source) => {
    let registeredRoot = path.resolve(source.rootPath);
    try {
      registeredRoot = fs.realpathSync(registeredRoot);
    } catch {
      // Unavailable registered checkouts still establish an overlapping boundary.
    }
    return registeredRoot.startsWith(canonical + path.sep);
  });
  if (!descendants.length || discoverProject(canonical).commonDir) return null;
  return `Non-Git directory ${canonical} contains registered projects. Select --group <group> and --project <project>, or run from a child project, to avoid indexing overlapping content.`;
}
