import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { RetrievalEngine } from '../../core/retrieval/index.js';
import { ChunksRepo } from '../../core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../core/storage/relationships-repo.js';
import { PromptsRepo } from '../../core/storage/prompts-repo.js';
import { SessionStore } from '../../core/session/session-store.js';
import { SessionManager } from '../../core/session/index.js';
import { KnowledgeStore } from '../../core/memory/knowledge-store.js';
import { loadConfig } from '../../config/index.js';
import { executeGetContext } from './get-context-core.js';

const PROMPT_CACHE_TTL_MS = 30_000;
const PROMPT_CACHE_SIZE = 8;

type CacheEntry = { at: number; text: string };
const promptCache = new Map<string, CacheEntry>();

function cacheGet(key: string): string | null {
  const e = promptCache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > PROMPT_CACHE_TTL_MS) {
    promptCache.delete(key);
    return null;
  }
  // LRU touch
  promptCache.delete(key);
  promptCache.set(key, e);
  return e.text;
}

function cacheSet(key: string, text: string): void {
  if (promptCache.has(key)) promptCache.delete(key);
  promptCache.set(key, { at: Date.now(), text });
  while (promptCache.size > PROMPT_CACHE_SIZE) {
    const oldest = promptCache.keys().next().value;
    if (oldest === undefined) break;
    promptCache.delete(oldest);
  }
}

export function registerGetContextTool(server: McpServer, dbs: DB[]) {
  const chunksRepos = dbs.map((db) => new ChunksRepo(db.getInstance()));
  const relsRepos = dbs.map((db) => new RelationshipsRepo(db.getInstance()));

  // Session tracking strictly uses the primary DB
  const primaryDb = dbs[0];
  const promptsRepo = new PromptsRepo(primaryDb.getInstance());
  const sessionStore = new SessionStore(primaryDb);
  // B21: single SessionManager — do not reconstruct per request
  const sessionManager = new SessionManager(promptsRepo, sessionStore);

  const engine = new RetrievalEngine(chunksRepos, relsRepos);
  const knowledgeStore = new KnowledgeStore(primaryDb);
  const repoRoot = process.env.CONTEXTOS_REPO_ROOT || process.cwd();

  const deps = { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore };

  server.tool(
    'get_context',
    "Retrieve relevant engineering context for a coding task from this workspace's indexed codebase, " +
      'including conventions, service relationships, and implementation patterns. Call this FIRST — before ' +
      'grep, broad file search, or spawning a search/explore subagent — for any question about where or how ' +
      'something is implemented in this repo; it is faster and more precise than ad-hoc search. Only fall back ' +
      'to file search or an explore agent if this returns no relevant results or the task needs broad, ' +
      "unindexed discovery (e.g. renaming across files, running commands). When output includes '### Also' " +
      'stubs with path:line ranges, expand with ctx_expand, ctx_symbol, or read_file.',
    {
      prompt: z.string().describe("The user's coding question or task description"),
      max_tokens: z
        .number()
        .max(8000)
        .optional()
        .default(loadConfig().maxTokenBudget)
        .describe(
          'Maximum tokens for returned context. Capped at 8000 to prevent context overflow.'
        ),
      layers: z
        .array(z.enum(['global', 'workspace', 'repo', 'session']))
        .optional()
        .default(['session', 'workspace', 'repo'])
        .describe(
          "Which context layers to search. By default searches local code only. Include 'global' if you explicitly need shared third-party or dependency context."
        ),
      output_format: z.enum(['markdown', 'xml']).optional().describe('Legacy parameter (ignored).')
    },
    async ({ prompt, max_tokens, layers, output_format }) => {
      try {
        const cacheKey = `${output_format}|${max_tokens}|${(layers || []).join(',')}|${prompt}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
          return {
            content: [{ type: 'text', text: cached }]
          };
        }

        const { text } = await executeGetContext(
          prompt,
          {
            maxTokens: max_tokens,
            layers: layers as string[],
            outputFormat: output_format as any,
            repoRoot
          },
          deps
        );

        cacheSet(cacheKey, text);

        return {
          content: [
            {
              type: 'text',
              text
            }
          ]
        };
      } catch (error: any) {
        sessionStore.addEvent({
          sessionId: sessionManager.getSessionId(),
          eventType: 'error',
          content: `Error: ${error.message}`,
          relatedFiles: null
        });

        return {
          content: [{ type: 'text', text: `Error retrieving context: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}
