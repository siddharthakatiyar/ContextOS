import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'path';
import { minimatch } from 'minimatch';
import { DB } from '../storage/database.js';
import { Indexer } from '../indexer/index.js';
import { loadConfig } from '../../config/index.js';
import { pLimit } from '../../utils/async.js';
import { BackgroundIndexer } from '../daemon/background-indexer.js';

/** Dotfile/dir paths that should still be watched (B8). */
const ALLOWED_DOT_SEGMENTS = new Set(['.cursor']);

/**
 * Ignore most dotfiles/dirs, but allow `.cursor/rules` and similar indexable paths.
 */
function isIgnoredDotPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  for (const part of parts) {
    if (!part.startsWith('.') || part === '.' || part === '..') continue;
    // Internal state directory: status.json writes during a full index used to
    // trigger parse/embed work on our own progress file.
    if (part === '.contextos') return true;
    if (!ALLOWED_DOT_SEGMENTS.has(part)) return true; // e.g. .git, .env, .DS_Store
  }
  return false;
}

function matchesIndexablePatterns(filePath: string, patterns: string[], cwd: string): boolean {
  const relative = path.relative(cwd, filePath).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) return false;
  return patterns.some((pattern) =>
    minimatch(relative, pattern, { dot: true, nocase: process.platform === 'win32' })
  );
}

export interface WatcherOptions {
  /**
   * Buffer incoming events instead of indexing immediately. Call the returned
   * watcher's flushBufferedEvents() once the initial full index completes so
   * edits made during indexing are replayed (hash-skipping makes replays cheap)
   * instead of being lost until restart.
   */
  buffered?: boolean;
}

export type ContextOSWatcher = FSWatcher & { flushBufferedEvents?: () => void };

interface BufferedEvent {
  filePath: string;
  type: 'add' | 'change' | 'unlink';
}

const BUFFER_CAP = 10_000;

export function startWatcher(
  db: DB,
  projectDir?: string,
  options?: WatcherOptions
): ContextOSWatcher {
  const config = loadConfig();
  // Watch and index against the daemon's project directory explicitly — using
  // process.cwd() here broke every path when the daemon was started elsewhere
  // (e.g. CONTEXTOS_REPO_ROOT set by an MCP client).
  const root = projectDir ? path.resolve(projectDir) : process.cwd();
  const indexer = new Indexer(db, root);
  const limit = pLimit(5); // Throttle concurrent parses during massive file changes

  // Note: Initial sync is intentionally NOT done here (the background full index
  // owns initial state); with options.buffered we collect events meanwhile.

  let buffering = !!options?.buffered;
  const buffer: BufferedEvent[] = [];

  let eventCount = 0;
  let windowStart = 0;
  const BURST_THRESHOLD = 100;
  const BURST_WINDOW_MS = 5000;

  let bulkActive = false;

  const triggerBulkReindex = (reason: string) => {
    if (bulkActive || buffering) return;
    bulkActive = true;
    limit.clearQueue();
    console.log(`\n[Watcher] ${reason} Triggering bulk background reindex...`);
    eventCount = 0;

    // BackgroundIndexer is single-flight per process, so this safely no-ops if
    // another full index is already running.
    const bgIndexer = new BackgroundIndexer(db, root);
    bgIndexer
      .startFullIndex(config)
      .catch(console.error)
      .finally(() => {
        bulkActive = false;
      });
  };

  const schedule = (filePath: string, type: 'add' | 'change' | 'unlink') => {
    void limit(async () => {
      try {
        // Layer 'repo' matches the bulk/full-index path so scores don't flip-flop
        // depending on whether a file arrived via watch events or full indexing.
        if (type === 'add' || type === 'change') {
          await indexer.indexFile(filePath, 'repo');
        } else if (type === 'unlink') {
          await indexer.removeFile(filePath);
        }
      } catch {
        // silently ignore
      }
    });
  };

  const handleEvent = (filePath: string, type: 'add' | 'change' | 'unlink') => {
    const ext = path.extname(filePath);
    if (type !== 'unlink' && !ext && !filePath.includes('.cursor/rules')) return;

    if (type !== 'unlink' && !matchesIndexablePatterns(filePath, config.indexablePatterns, root)) {
      return;
    }

    if (buffering) {
      if (buffer.length >= BUFFER_CAP) {
        // Overflow: cheaper and more correct to rebuild than to drain 10k+ events
        buffer.length = 0;
        buffering = false;
        triggerBulkReindex(`Watch buffer overflowed (> ${BUFFER_CAP} pending events).`);
        return;
      }
      buffer.push({ filePath, type });
      return;
    }

    if (bulkActive) return; // A full reindex owns the index state right now

    // Literal rolling window: ">=100 events within 5s" — the previous reset-timer
    // approach accumulated counts across unrelated periods under steady churn
    // and tripped spurious full reindexes.
    const now = Date.now();
    if (now - windowStart > BURST_WINDOW_MS) {
      windowStart = now;
      eventCount = 0;
    }
    eventCount++;

    if (eventCount >= BURST_THRESHOLD) {
      triggerBulkReindex(`Massive burst detected (${eventCount} changes in ${BURST_WINDOW_MS}ms).`);
      return;
    }

    schedule(filePath, type);
  };

  const watcher = chokidar.watch(root, {
    ignored: [
      (p: string) => isIgnoredDotPath(p),
      (p: string) => {
        const normalized = p.replace(/\\/g, '/');
        return (
          normalized.includes('/node_modules/') ||
          normalized.endsWith('/node_modules') ||
          normalized.includes('/.git/') ||
          normalized.endsWith('/.git') ||
          normalized.includes('/.next/') ||
          normalized.endsWith('/.next') ||
          normalized.includes('/dist/') ||
          normalized.endsWith('/dist') ||
          normalized.includes('/build/') ||
          normalized.endsWith('/build') ||
          normalized.includes('/coverage/') ||
          normalized.endsWith('/coverage')
        );
      },
      ...config.ignorePatterns.map((p) => `**/${p}`)
    ],
    persistent: true,
    ignoreInitial: true,
    ignorePermissionErrors: true,
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: 400,
      pollInterval: 100
    }
  }) as ContextOSWatcher;

  watcher.flushBufferedEvents = () => {
    if (!buffering) return;
    buffering = false;
    const drained = buffer.splice(0);
    console.log(`[Watcher] Replaying ${drained.length} buffered change(s) from initial index.`);
    for (const e of drained) schedule(e.filePath, e.type);
  };

  watcher
    .on('add', (filePath) => handleEvent(filePath, 'add'))
    .on('change', (filePath) => handleEvent(filePath, 'change'))
    .on('unlink', (filePath) => handleEvent(filePath, 'unlink'))
    .on('error', (err) => {
      // Log (but don't crash) — previously these were fully discarded, which hid
      // cases where the watch tree silently stopped (EMFILE/ENOSPC/EPERM). Kept
      // non-fatal to avoid taking down the daemon on transient/socket errors.
      console.error(`[contextos] watcher error: ${(err as Error)?.message ?? err}`);
    });

  return watcher;
}
