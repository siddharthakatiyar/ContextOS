import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'path';
import { DB } from '../storage/database.js';
import { Indexer } from '../indexer/index.js';
import { loadConfig } from '../../config/index.js';

export function startWatcher(db: DB, workspace?: string): FSWatcher {
  const config = loadConfig();
  const indexer = new Indexer(db);
  const cwd = process.cwd();
  
  // Note: Initial sync is skipped here to let the server start instantly.
  // The MCP server handles its own initial indexing via ctx_index_files or assumes it's up to date.

  const watcher = chokidar.watch(cwd, {
    ignored: [
      /(^|[\/\\])\../, // ignore dotfiles
      (p: string) => {
        const normalized = p.replace(/\\/g, '/');
        return normalized.includes('/node_modules/') || normalized.endsWith('/node_modules') ||
               normalized.includes('/.git/') || normalized.endsWith('/.git') ||
               normalized.includes('/.next/') || normalized.endsWith('/.next') ||
               normalized.includes('/dist/') || normalized.endsWith('/dist') ||
               normalized.includes('/build/') || normalized.endsWith('/build') ||
               normalized.includes('/coverage/') || normalized.endsWith('/coverage');
      },
      ...config.ignorePatterns.map(p => `**/${p}`)
    ],
    persistent: true,
    ignoreInitial: true,
    ignorePermissionErrors: true,
  });

  watcher
    .on('add', async (filePath) => {
      const ext = path.extname(filePath);
      if (!ext) return;
      try {
        await indexer.indexFile(filePath, 'workspace', workspace);
      } catch (e: any) {
        // silently ignore or log to debug
      }
    })
    .on('change', async (filePath) => {
      const ext = path.extname(filePath);
      if (!ext) return;
      try {
        await indexer.indexFile(filePath, 'workspace', workspace);
      } catch (e: any) {
        // silently ignore
      }
    })
    .on('unlink', async (filePath) => {
      try {
        await indexer.removeFile(filePath);
      } catch (e: any) {
        // silently ignore
      }
    })
    .on('error', (error) => {
      // Silently ignore all watcher errors (like UNKNOWN or EPERM for sockets/protected files) to prevent the server from crashing
    });

  return watcher;
}
