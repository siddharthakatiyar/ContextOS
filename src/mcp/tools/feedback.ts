import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { FeedbackTracker } from '../../core/feedback/tracker.js';
import path from 'path';

/** Recent get_context chunk IDs keyed by normalized source file (B7 implicit feedback). */
let lastRetrievedByFile: Map<string, string[]> = new Map();
let lastRetrievedAt = 0;
const IMPLICIT_TTL_MS = 5 * 60 * 1000;

let trackerRef: FeedbackTracker | null = null;

function normalizeFileKey(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  return path.basename(norm).toLowerCase();
}

/** Called by get_context after retrieval — stores chunk IDs for implicit read feedback. */
export function recordRetrievedChunks(chunks: Array<{ id: string; sourceFile: string }>): void {
  const byFile = new Map<string, string[]>();
  for (const c of chunks) {
    if (!c?.id || !c.sourceFile) continue;
    if (c.sourceFile === 'session' || c.sourceFile === 'memory.fact') continue;
    const key = normalizeFileKey(c.sourceFile);
    const full = c.sourceFile.replace(/\\/g, '/').toLowerCase();
    for (const k of [key, full]) {
      if (!byFile.has(k)) byFile.set(k, []);
      const list = byFile.get(k)!;
      if (!list.includes(c.id)) list.push(c.id);
    }
  }
  lastRetrievedByFile = byFile;
  lastRetrievedAt = Date.now();
}

/**
 * Implicit positive feedback when ctx_read_file follows a recent get_context
 * that returned chunks from the same file. Does not print chunk IDs.
 */
export function onFileRead(filePath: string): void {
  if (!trackerRef) return;
  if (!lastRetrievedAt || Date.now() - lastRetrievedAt > IMPLICIT_TTL_MS) return;

  const norm = filePath.replace(/\\/g, '/');
  const keys = [normalizeFileKey(norm), norm.toLowerCase()];
  const ids = new Set<string>();
  for (const k of keys) {
    const list = lastRetrievedByFile.get(k);
    if (list) for (const id of list) ids.add(id);
  }
  // Also match by suffix (relative vs absolute)
  const base = normalizeFileKey(norm);
  for (const [k, list] of lastRetrievedByFile) {
    if (k.endsWith('/' + base) || k === base) {
      for (const id of list) ids.add(id);
    }
  }

  for (const id of ids) {
    try {
      trackerRef.recordFeedback(id, 1, 'implicit:ctx_read_file');
    } catch {
      // ignore feedback write failures
    }
  }
}

export function registerFeedbackTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const tracker = new FeedbackTracker(primaryDb);
  trackerRef = tracker;
  // Implicit feedback only (no rate_chunk tool)
}

export function registerLegacyFeedbackTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const tracker = new FeedbackTracker(primaryDb);
  trackerRef = tracker;

  server.tool(
    'rate_chunk',
    'Provide feedback on a retrieved context chunk. Use this if a chunk was exceptionally useful (+1) or completely irrelevant (-1) to your task. This helps ContextOS learn and improve future retrievals.',
    {
      chunk_id: z.string().describe('The ID of the chunk to rate'),
      adjustment: z.number().describe('The score adjustment: 1 for useful, -1 for irrelevant'),
      reason: z.string().optional().describe('Optional reason for this rating')
    },
    async ({ chunk_id, adjustment, reason }) => {
      try {
        if (adjustment < -5 || adjustment > 5) {
          throw new Error('Adjustment must be between -5 and 5');
        }

        const id = tracker.recordFeedback(chunk_id, adjustment, reason);
        return {
          content: [{ type: 'text', text: `Successfully recorded feedback. ID: ${id}` }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error recording feedback: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}
