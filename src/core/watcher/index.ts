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
const ALLOWED_DOT_SEGMENTS = new Set(['.cursor', '.contextos']);

/**
 * Ignore most dotfiles/dirs, but allow `.cursor/rules` and similar indexable paths.
 */
function isIgnoredDotPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/');
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.startsWith('.') || part === '.' || part === '..') continue;
    if (ALLOWED_DOT_SEGMENTS.has(part)) {
      // Allow .cursor/rules/** specifically; still ignore other .cursor children if desired
      if (part === '.cursor') {
        const next = parts[i + 1];
        if (next === 'rules' || next === undefined) continue; // allow
        // other .cursor/* (e.g. .cursor/mcp.json) — still allow if indexablePatterns match later
        continue;
      }
      continue;
    }
    return true; // e.g. .git, .env, .DS_Store
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

export function startWatcher(db: DB, workspace?: string): FSWatcher {
  const config = loadConfig();
  const indexer = new Indexer(db);
  const cwd = process.cwd();
  const limit = pLimit(5); // Throttle concurrent parses during massive file changes

  // Note: Initial sync is skipped here to let the server start instantly.
  // The MCP server handles its own initial indexing via ctx_index_files or assumes it's up to date.

  const watcher = chokidar.watch(cwd, {
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
  });

  let eventCount = 0;
  let debounceTimer: NodeJS.Timeout | null = null;
  const BURST_THRESHOLD = 100;
  const DEBOUNCE_MS = 5000;

  const handleEvent = (filePath: string, type: 'add' | 'change' | 'unlink') => {
    const ext = path.extname(filePath);
    if (type !== 'unlink' && !ext && !filePath.includes('.cursor/rules')) return;
    
    if (type !== 'unlink' && !matchesIndexablePatterns(filePath, config.indexablePatterns, cwd)) {
      return;
    }

    eventCount++;

    if (debounceTimer) clearTimeout(debounceTimer);

    if (eventCount >= BURST_THRESHOLD) {
      limit.clearQueue();
      console.log(`\n[Watcher] Massive burst detected (${eventCount} changes). Triggering bulk background reindex...`);
      eventCount = 0;
      
      const bgIndexer = new BackgroundIndexer(db, cwd);
      bgIndexer.startFullIndex(config).catch(console.error);
      return;
    }

    debounceTimer = setTimeout(() => {
      eventCount = 0;
    }, DEBOUNCE_MS);

    limit(async () => {
      try {
        if (type === 'add' || type === 'change') {
          await indexer.indexFile(filePath, 'workspace', workspace);
        } else if (type === 'unlink') {
          await indexer.removeFile(filePath);
        }
      } catch {
        // silently ignore
      }
    });
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
