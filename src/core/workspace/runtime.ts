import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DB } from '../storage/database.js';
import { loadConfig } from '../../config/index.js';
import { BackgroundIndexer, INDEXER_VERSION } from '../daemon/background-indexer.js';
import { startWatcher, type ContextOSWatcher } from '../watcher/index.js';
import { Indexer } from '../indexer/index.js';
import { backfillAllEmbeddings } from '../embeddings/index.js';
import {
  WorkspaceRegistry,
  type RepositorySource,
  type ScopeSelectors,
  type RetrievalScope
} from './registry.js';
import { bindRepository } from './identity.js';
import {
  assertNoSymlinkInPath,
  secureBoundSocket,
  removePrivateStateFile,
  getDaemonControlSocketPath,
  writePrivateStateFile
} from '../../utils/secure-state.js';
import { resolveWithinWorkspace } from '../../utils/fs-guard.js';
import { getErrorMessage } from '../../utils/errors.js';

type Owner = { pid: number; token: string; endpoint: string; protocol: number };
export type IndexRequest = {
  action: 'index' | 'file' | 'status' | 'embeddings';
  file?: string;
  force?: boolean;
  layer?: import('../storage/types.js').Layer;
  workspaceName?: string;
};
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
export function configFingerprint(root: string): string {
  const config = loadConfig({ cwd: root, forceReload: true });
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        patterns: config.indexablePatterns,
        ignore: config.ignorePatterns,
        chunk: config.maxChunkTokens,
        symbol: config.maxSymbolChunkTokens,
        embeddings: config.embeddingsEnabled,
        indexer: INDEXER_VERSION
      })
    )
    .digest('hex');
}

export class RepositoryRuntime {
  readonly config;
  readonly db: DB;
  private watcher?: ContextOSWatcher;
  private server?: net.Server;
  private owner?: Owner;
  private pending = new Set<Promise<unknown>>();
  private closing = false;
  private scan?: Promise<void>;
  private acquisition?: Promise<Owner>;
  private leaseFile: string;
  private fingerprint: string;
  constructor(
    readonly source: RepositorySource,
    private registry: WorkspaceRegistry
  ) {
    if (!fs.existsSync(source.rootPath) || !fs.existsSync(source.dbPath))
      throw new Error(`Repository unavailable: ${source.rootPath}`);
    this.config = loadConfig({ cwd: source.rootPath, forceReload: true });
    this.fingerprint = configFingerprint(source.rootPath);
    this.db = new DB(source.dbPath);
    bindRepository(this.db.getInstance(), source.repoId, source.rootPath);
    this.leaseFile = path.join(source.rootPath, '.contextos', 'index-owner.json');
  }
  private readOwner(): Owner | undefined {
    const owner = this.registry.lease(this.source.repoId);
    if (!owner) return undefined;
    if (!alive(owner.pid)) return undefined;
    return owner;
  }

  private acquire(): Promise<Owner> {
    if (this.closing) return Promise.reject(new Error('Repository runtime is closing'));
    return (this.acquisition ??= this.acquireNow().finally(() => {
      this.acquisition = undefined;
    }));
  }
  private async acquireNow(): Promise<Owner> {
    const existing = this.readOwner();
    if (existing) return existing;
    // An older daemon has no lease; do not race its writer.
    const legacy = path.join(this.source.rootPath, '.contextos', 'daemon.pid');
    if (fs.existsSync(legacy)) {
      const pid = Number(fs.readFileSync(legacy, 'utf8').trim());
      if (pid > 0 && pid !== process.pid && alive(pid))
        throw new Error(
          `A legacy daemon owns ${this.source.name}. Stop it and restart using ContextOS 1.1.1.`
        );
    }
    const token = crypto.randomUUID();
    const endpoint = getDaemonControlSocketPath(this.source.rootPath) + '.index';
    const owner: Owner = { pid: process.pid, token, endpoint, protocol: 1 };
    const winner = this.registry.takeLease(this.source.repoId, owner);
    if (winner.token !== token) return winner;
    writePrivateStateFile(this.leaseFile, JSON.stringify(owner));
    this.owner = owner;
    this.server = net.createServer((socket) => {
      let buffer = '';
      socket.setTimeout(30 * 60 * 1000, () => socket.destroy());
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        if (buffer.length > 8192) {
          socket.destroy();
          return;
        }
        if (!buffer.includes('\n')) return;
        socket.removeListener('data', onData);
        try {
          const request = JSON.parse(buffer.split('\n')[0]) as IndexRequest & { token: string };
          if (
            request.token !== token ||
            !['index', 'file', 'status', 'embeddings'].includes(request.action)
          )
            throw new Error('Invalid index request');
          const job = this.request(request);
          this.pending.add(job);
          void job
            .then(
              (result) => socket.end(JSON.stringify({ ok: true, result }) + '\n'),
              (error) =>
                socket.end(JSON.stringify({ ok: false, error: getErrorMessage(error) }) + '\n')
            )
            .finally(() => this.pending.delete(job));
        } catch (error) {
          socket.end(JSON.stringify({ ok: false, error: getErrorMessage(error) }) + '\n');
        }
      };
      socket.on('error', () => {});
      socket.on('data', onData);
    });
    try {
      if (process.platform !== 'win32' && fs.existsSync(endpoint)) {
        assertNoSymlinkInPath(endpoint);
        fs.unlinkSync(endpoint);
      }
      await new Promise<void>((resolve, reject) => {
        this.server!.once('error', reject);
        this.server!.listen(endpoint, resolve);
      });
      secureBoundSocket(endpoint);
    } catch (error) {
      this.owner = undefined;
      this.registry.releaseLease(this.source.repoId, token);
      removePrivateStateFile(this.leaseFile);
      throw error;
    }
    return owner;
  }
  private async remote(owner: Owner, request: IndexRequest): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.remoteOnce(owner, request);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 10 || (code !== 'ENOENT' && code !== 'ECONNREFUSED') || !alive(owner.pid))
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  private remoteOnce(owner: Owner, request: IndexRequest): Promise<unknown> {
    if (owner.protocol !== 1)
      return Promise.reject(
        new Error('Incompatible indexing owner; restart it using ContextOS 1.1.1.')
      );
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(owner.endpoint);
      let buffer = '';
      socket.setTimeout(30 * 60 * 1000, () => socket.destroy(new Error('Index owner timed out')));
      socket.once('connect', () =>
        socket.write(JSON.stringify({ ...request, token: owner.token }) + '\n')
      );
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        if (!buffer.includes('\n')) return;
        socket.end();
        try {
          const response = JSON.parse(buffer.split('\n')[0]);
          if (!response.ok) throw new Error(response.error);
          resolve(response.result);
        } catch (error) {
          reject(error);
        }
      });
      socket.once('error', reject);
      socket.once('end', () => {
        if (!buffer.includes('\n')) reject(new Error('Index owner disconnected before responding'));
      });
    });
  }
  async request(request: IndexRequest): Promise<unknown> {
    if (this.closing) throw new Error('Repository runtime is closing');
    const owner = await this.acquire();
    if (owner.token !== this.owner?.token) return this.remote(owner, request);
    if (request.action === 'status') return this.status();
    if (request.action === 'embeddings') {
      const result = await backfillAllEmbeddings(this.db.getInstance(), undefined, this.config);
      this.changed();
      return result;
    }
    if (request.action === 'file') {
      if (typeof request.file !== 'string') throw new Error('A file path is required');
      const file = resolveWithinWorkspace(this.source.rootPath, request.file);
      if (!file) throw new Error('File is outside the selected repository');
      const indexer = new Indexer(this.db, this.source.rootPath, this.config.ignorePatterns);
      const result = fs.existsSync(file)
        ? await indexer.indexFile(file, request.layer ?? 'repo', request.workspaceName)
        : await indexer.removeFile(file);
      this.changed();
      return result;
    }
    if (request.force && !this.scan)
      this.db.getInstance().prepare("UPDATE files SET hash='' WHERE layer='repo'").run();
    await this.index(request.force);
    return this.status();
  }
  private changed(): void {
    this.registry.update(this.source.repoId, { incrementGeneration: true });
  }
  async index(force = false): Promise<void> {
    if (this.scan) return this.scan;
    const owner = await this.acquire();
    if (owner.token !== this.owner?.token) {
      await this.remote(owner, { action: 'index', force });
      return;
    }
    if (this.scan) return this.scan;
    const current = this.registry.resolve(this.source.repoId);
    if (!force && current.state === 'ready' && current.configFingerprint === this.fingerprint)
      return;
    this.scan = (async () => {
      this.registry.update(this.source.repoId, { state: 'indexing', lastError: null });
      if (current.configFingerprint !== this.fingerprint)
        this.db.getInstance().prepare("UPDATE files SET hash='' WHERE layer='repo'").run();
      const indexer = new BackgroundIndexer(this.db, this.source.rootPath);
      await indexer.startFullIndex(this.config);
      if (indexer.lastError) throw new Error(indexer.lastError);
      const status = JSON.parse(
        fs.readFileSync(path.join(this.source.rootPath, '.contextos', 'status.json'), 'utf8')
      );
      if (!status.fullIndexCompleted) throw new Error(status.error ?? 'Indexing did not complete');
      this.watcher?.flushBufferedEvents?.();
      await this.watcher?.waitForIdle?.();
      this.db
        .getInstance()
        .prepare("DELETE FROM repository_metadata WHERE key='needs_reindex'")
        .run();
      this.registry.update(this.source.repoId, {
        state: 'ready',
        lastError: null,
        lastSuccess: Date.now(),
        configFingerprint: this.fingerprint,
        indexerVersion: INDEXER_VERSION,
        incrementGeneration: true,
        progress: indexer.getStatus()
      });
    })()
      .catch((error) => {
        this.registry.update(this.source.repoId, {
          state: 'failed',
          lastError: getErrorMessage(error)
        });
        this.watcher?.flushBufferedEvents?.();
        throw error;
      })
      .finally(() => {
        this.scan = undefined;
      });
    return this.scan;
  }
  async watch(): Promise<void> {
    if (this.watcher) return;
    const owner = await this.acquire();
    if (owner.token !== this.owner?.token) {
      await this.remote(owner, { action: 'index' });
      return;
    }
    if (!this.watcher)
      this.watcher = startWatcher(this.db, this.source.rootPath, {
        buffered: true,
        onIndexed: () => this.changed(),
        onError: (error) =>
          this.registry.update(this.source.repoId, {
            state: 'failed',
            lastError: getErrorMessage(error)
          })
      });
    // Reconcile on every watcher startup: files may have changed while no owner was running.
    await this.index(true);
    this.watcher.flushBufferedEvents?.();
  }
  status(): Record<string, unknown> {
    const db = this.db.getInstance();
    let progress: unknown;
    try {
      progress = JSON.parse(
        fs.readFileSync(path.join(this.source.rootPath, '.contextos', 'status.json'), 'utf8')
      );
    } catch {
      /* no scan yet */
    }
    return {
      ...this.registry.resolve(this.source.repoId),
      progress,
      files: (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n,
      chunks: (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n,
      owner: this.readOwner() ? { pid: this.readOwner()!.pid } : null
    };
  }
  async close(): Promise<void> {
    this.closing = true;
    await this.acquisition?.catch(() => {});
    await this.watcher?.close();
    await this.scan?.catch(() => {});
    await this.watcher?.waitForIdle?.();
    await Promise.allSettled([...this.pending]);
    if (this.server?.listening)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    if (this.owner && this.readOwner()?.token === this.owner.token) {
      removePrivateStateFile(this.leaseFile);
      this.registry.releaseLease(this.source.repoId, this.owner.token);
    }
    this.db.close();
  }
}

export class WorkspaceRuntime {
  private repositories = new Map<string, RepositoryRuntime>();
  private retired = new Set<RepositoryRuntime>();
  private requests = 0;
  private retireJobs = new Set<Promise<void>>();
  async withSnapshot<T>(action: () => Promise<T>): Promise<T> {
    this.requests++;
    try {
      return await action();
    } finally {
      this.requests--;
      if (!this.requests) await this.drainRetired();
    }
  }
  private async drainRetired(): Promise<void> {
    const retired = [...this.retired];
    this.retired.clear();
    const jobs = retired.map((repo) => {
      const job = repo.close();
      this.retireJobs.add(job);
      void job.finally(() => this.retireJobs.delete(job)).catch(() => {});
      return job;
    });
    await Promise.allSettled(jobs);
  }
  constructor(
    readonly registry: WorkspaceRegistry,
    readonly workspace?: string
  ) {}
  get(source: RepositorySource): RepositoryRuntime {
    if (!fs.existsSync(source.rootPath) || !fs.existsSync(source.dbPath))
      throw new Error(`Repository unavailable: ${source.rootPath}`);
    let runtime = this.repositories.get(source.repoId);
    if (!runtime) {
      runtime = new RepositoryRuntime(source, this.registry);
      this.repositories.set(source.repoId, runtime);
    }
    return runtime;
  }
  select(selectors: ScopeSelectors, cwd: string, activeRepoId?: string): RetrievalScope {
    if (
      this.workspace &&
      selectors.workspace &&
      this.registry.workspace(selectors.workspace).id !== this.registry.workspace(this.workspace).id
    )
      throw new Error('The requested workspace is outside this server scope.');
    const scope = this.registry.select(selectors, cwd, this.workspace, activeRepoId);
    if (this.workspace) {
      scope.workspaceId ??= this.registry.workspace(this.workspace).id;
      const members = new Set(this.registry.list(this.workspace).map((r) => r.repoId));
      if (scope.sources.some((r) => !members.has(r.repoId)))
        throw new Error('Repository is outside this server workspace.');
    }
    return scope;
  }
  async refreshWatchers(): Promise<void> {
    if (!this.workspace) return;
    const sources = this.registry.list(this.workspace);
    const members = new Set(sources.map((r) => r.repoId));
    for (const [id, runtime] of this.repositories) {
      if (!members.has(id)) {
        this.repositories.delete(id);
        // Keep handles alive until requests using the previous membership finish.
        this.retired.add(runtime);
      }
    }
    if (!this.requests) await this.drainRetired();
    await Promise.allSettled(
      sources.map(async (source) => {
        try {
          await this.get(source).watch();
        } catch (error) {
          const message = getErrorMessage(error);
          const current = this.registry.resolve(source.repoId);
          if (current.lastError !== message)
            this.registry.update(source.repoId, { state: 'unavailable', lastError: message });
        }
      })
    );
  }
  async waitForIdle(): Promise<void> {
    while (this.requests > 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await this.drainRetired();
    await Promise.allSettled([...this.retireJobs]);
  }
  async close(): Promise<void> {
    while (this.requests > 0) await new Promise((resolve) => setTimeout(resolve, 20));
    await Promise.allSettled(
      [...this.repositories.values(), ...this.retired].map((runtime) => runtime.close())
    );
    await Promise.allSettled([...this.retireJobs]);
    this.repositories.clear();
    this.retired.clear();
  }
}
