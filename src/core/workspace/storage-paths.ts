import path from 'node:path';
import { getContextOSHome } from '../storage/database.js';
import type { RepositorySource } from './registry.js';

function validateIdentity(id: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid storage identity.');
}

export function projectStateDirectory(projectId: string, home = getContextOSHome()): string {
  validateIdentity(projectId);
  return path.join(home, 'projects', projectId);
}
export function viewDatabasePath(
  projectId: string,
  viewId: string,
  home = getContextOSHome()
): string {
  validateIdentity(viewId);
  return path.join(projectStateDirectory(projectId, home), 'views', viewId, 'index.db');
}
export function viewStateDirectory(source: Pick<RepositorySource, 'dbPath'>): string {
  return path.dirname(source.dbPath);
}
