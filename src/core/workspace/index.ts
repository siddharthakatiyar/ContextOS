export { WorkspaceRegistry } from './registry.js';
export type { RepositorySource, Workspace, ScopeSelectors, RetrievalScope } from './registry.js';
export { RepositoryRuntime, WorkspaceRuntime } from './runtime.js';
export { retrieveWorkspace } from './retrieval.js';
export { entityRef, parseRef } from './identity.js';

export { GraphStore } from '../knowledge/graph-store.js';
export type { VerifiedLink, VerifiedFact, Evidence } from '../knowledge/graph-store.js';
export { discoverProject } from './discovery.js';
export { projectStateDirectory, viewStateDirectory } from './storage-paths.js';
