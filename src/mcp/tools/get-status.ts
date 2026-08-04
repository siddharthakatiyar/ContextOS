import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import fs from 'fs';
import { DB } from '../../core/storage/database.js';
import { ChunksRepo } from '../../core/storage/chunks-repo.js';
import { getErrorMessage } from '../../utils/errors.js';

/** Cap stale-file mtime checks so status stays fast on large indexes. */
const STALE_CHECK_LIMIT = 500;

function formatAge(ms: number): string {
  if (ms < 0) return 'unknown';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function getIndexFreshness(db: ReturnType<DB['getInstance']>): {
  lastIndexedAt: number | null;
  ageLabel: string;
  fileCount: number;
  staleCount: number;
  staleChecked: number;
} {
  const maxRow = db.prepare('SELECT MAX(last_indexed) as m, COUNT(*) as c FROM files').get() as
    { m: number | null; c: number } | undefined;
  const lastIndexedAt = maxRow?.m ?? null;
  const fileCount = maxRow?.c ?? 0;
  const ageLabel = lastIndexedAt == null ? 'never indexed' : formatAge(Date.now() - lastIndexedAt);

  // Best-effort stale heuristic: files whose on-disk mtime is newer than last_indexed.
  let staleCount = 0;
  let staleChecked = 0;
  if (fileCount > 0) {
    const rows = db
      .prepare('SELECT path, last_indexed FROM files LIMIT ?')
      .all(STALE_CHECK_LIMIT) as Array<{ path: string; last_indexed: number }>;
    for (const row of rows) {
      staleChecked++;
      try {
        if (!fs.existsSync(row.path)) continue;
        const mtimeMs = fs.statSync(row.path).mtimeMs;
        if (mtimeMs > row.last_indexed) {
          staleCount++;
        }
      } catch {
        // Skip unreadable paths
      }
    }
  }

  return { lastIndexedAt, ageLabel, fileCount, staleCount, staleChecked };
}

export function registerGetStatusTool(server: McpServer, db: DB) {
  const chunksRepo = new ChunksRepo(db.getInstance());

  server.tool(
    'contextos_status',
    'Show the current status of the ContextOS index — chunk counts, layer breakdown, index freshness, and stale-file heuristic.',
    {},
    async () => {
      try {
        const stats = chunksRepo.getStats();
        const freshness = getIndexFreshness(db.getInstance());

        let output = `## ContextOS Index Status\n\n`;
        output += `- **Total Chunks**: ${stats.totalChunks}\n`;
        output += `- **Total Tokens**: ${stats.totalTokens}\n`;
        output += `- **Files Indexed**: ${freshness.fileCount}\n`;
        output += `- **Index Freshness**: ${
          freshness.lastIndexedAt == null
            ? 'never indexed'
            : `${new Date(freshness.lastIndexedAt).toISOString()} (${freshness.ageLabel})`
        }\n`;
        if (freshness.staleChecked > 0) {
          const sampleNote =
            freshness.staleChecked < freshness.fileCount
              ? ` (checked ${freshness.staleChecked}/${freshness.fileCount})`
              : '';
          output += `- **Stale Files** (mtime > last_indexed): ${freshness.staleCount}${sampleNote}\n`;
        }
        output += `\n### By Layer\n`;
        output += `- Session: ${stats.byLayer.session}\n`;
        output += `- Repo: ${stats.byLayer.repo}\n`;
        output += `- Workspace: ${stats.byLayer.workspace}\n`;
        output += `- Global: ${stats.byLayer.global}\n`;

        return {
          content: [
            {
              type: 'text',
              text: output
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error getting status: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );
}
