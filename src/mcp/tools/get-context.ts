import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DB } from "../../core/storage/database.js";
import { RetrievalEngine } from "../../core/retrieval/index.js";
import { compile } from "../../core/compiler/index.js";
import { ChunksRepo } from "../../core/storage/chunks-repo.js";
import { RelationshipsRepo } from "../../core/storage/relationships-repo.js";
import { PromptsRepo } from "../../core/storage/prompts-repo.js";
import { SessionStore } from "../../core/session/session-store.js";
import { SessionManager } from "../../core/session/index.js";
import { KnowledgeStore } from "../../core/memory/knowledge-store.js";
import { estimateTokens } from "../../utils/tokens.js";
import { recordRetrievedChunks } from "./feedback.js";
import crypto from "crypto";
import { loadConfig } from "../../config/index.js";
import type { ScoredChunk } from "../../core/retrieval/types.js";

const MEMORY_CHUNK_CAP = 3;
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

function contentHash(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Merge session + knowledge into retrieval chunks with real hashes/tokenCounts,
 * capped so memory cannot crowd out code (B2).
 */
function mergeMemoryPipeline(
  codeChunks: ScoredChunk[],
  sessionChunks: Array<{ id: string; content: string; layer: string; importance: number }>,
  knowledgeFacts: Array<{ id: string; fact: string; category: string; confidence: number }>,
): ScoredChunk[] {
  const memory: ScoredChunk[] = [];

  for (const sc of sessionChunks) {
    const content = sc.content;
    memory.push({
      id: sc.id,
      content,
      sourceFile: 'session',
      layer: 'session',
      workspaceName: null,
      sectionTitle: null,
      sectionDepth: 0,
      summary: null,
      keywords: null,
      hash: contentHash(content),
      importance: sc.importance,
      tokenCount: estimateTokens(content),
      score: sc.importance,
      fileType: 'text',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as ScoredChunk);
  }

  for (const fact of knowledgeFacts) {
    const content = `**[${fact.category.toUpperCase()}]**: ${fact.fact}`;
    memory.push({
      id: fact.id,
      content,
      sourceFile: 'memory.fact',
      layer: 'global',
      workspaceName: null,
      sectionTitle: 'Cross-Session Knowledge Fact',
      sectionDepth: 1,
      summary: null,
      keywords: null,
      hash: contentHash(content),
      importance: Math.round(fact.confidence * 10),
      tokenCount: estimateTokens(content),
      score: fact.confidence * 10,
      fileType: 'text',
      language: undefined,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as ScoredChunk);
  }

  // Cap memory so it cannot crowd out all code; keep highest-scoring memory
  const cappedMemory = memory
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MEMORY_CHUNK_CAP);

  // Ensure code stays in the candidate set: merge then re-sort by score
  return [...codeChunks, ...cappedMemory].sort(
    (a, b) => (b.score || 0) - (a.score || 0),
  );
}

export function registerGetContextTool(server: McpServer, dbs: DB[]) {
  const chunksRepos = dbs.map(db => new ChunksRepo(db.getInstance()));
  const relsRepos = dbs.map(db => new RelationshipsRepo(db.getInstance()));

  // Session tracking strictly uses the primary DB
  const primaryDb = dbs[0];
  const promptsRepo = new PromptsRepo(primaryDb.getInstance());
  const sessionStore = new SessionStore(primaryDb);
  // B21: single SessionManager — do not reconstruct per request
  const sessionManager = new SessionManager(promptsRepo, sessionStore);

  const engine = new RetrievalEngine(chunksRepos, relsRepos);
  const knowledgeStore = new KnowledgeStore(primaryDb);
  const repoRoot = process.env.CONTEXTOS_REPO_ROOT || process.cwd();

  server.tool(
    "get_context",
    "CRITICAL: You MUST use this tool to answer ANY question about the codebase, architecture, or how something works BEFORE using your built-in codebase search. ContextOS provides superior graph-based context. Retrieve relevant engineering context for a coding task, including conventions, service relationships, and implementation patterns. When output includes ### Also stubs with path:line ranges, expand with get_symbol (named symbol) or ctx_read_file(filePath, start_line, end_line) — do NOT whole-file Read. Only if you see [...truncated] without a usable range, use ctx_read_file. By default, this search is restricted to local code (session, workspace, repo). If you specifically need shared context, third-party libraries, or node_modules, you MUST explicitly include 'global' in the layers array.",
    {
      prompt: z.string().describe("The user's coding question or task description"),
      max_tokens: z.number().max(8000).optional().default(loadConfig().maxTokenBudget).describe("Maximum tokens for returned context. Capped at 8000 to prevent context overflow."),
      layers: z.array(z.enum(["global", "workspace", "repo", "session"]))
        .optional()
        .default(["session", "workspace", "repo"])
        .describe("Which context layers to search. By default searches local code only. Include 'global' if you explicitly need shared third-party or dependency context."),
      output_format: z.enum(["markdown", "xml"]).optional().default("markdown").describe("Format of the compiled context. Use XML if you are Claude or similar LLM that prefers XML."),
    },
    async ({ prompt, max_tokens, layers, output_format }) => {
      try {
        const cacheKey = `${output_format}|${max_tokens}|${(layers || []).join(',')}|${prompt}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
          return {
            content: [{ type: "text", text: cached }],
          };
        }

        // Record user prompt event
        sessionStore.addEvent({
          sessionId: sessionManager.getSessionId(),
          eventType: 'user_prompt',
          content: prompt.length > 2000 ? prompt.substring(0, 2000) + '... [truncated]' : prompt,
          relatedFiles: null
        });

        const result = await engine.retrieve(prompt, {
          maxChunks: loadConfig().maxRetrievalResults,
          layers: layers as string[],
          repoRoot,
        });

        // B2: memory pipeline — real hashes, tokenCounts, scores; capped; re-sorted
        const sessionChunks = await sessionManager.getSessionContext();
        const knowledgeFacts = knowledgeStore.searchFacts(prompt, 2);
        result.chunks = mergeMemoryPipeline(result.chunks, sessionChunks, knowledgeFacts);

        const compiled = compile(result, {
          maxTokens: max_tokens,
          outputFormat: output_format as any,
          signalTerms: [
            ...(result.intent?.identifiers || []),
            ...(result.intent?.concepts || []),
          ],
        });

        // Implicit feedback tracking (no chunk IDs in output)
        recordRetrievedChunks(result.chunks);

        // Log to prompt history
        promptsRepo.insert({
          id: crypto.randomUUID(),
          prompt: prompt.length > 2000 ? prompt.substring(0, 2000) + '... [truncated]' : prompt,
          extractedConcepts: JSON.stringify(result.intent.concepts),
          retrievedChunkIds: JSON.stringify(result.chunks.map(c => c.id)),
          compiledTokenCount: compiled.tokenCount,
          latencyMs: result.latencyMs,
          createdAt: Date.now()
        });

        // Record context retrieved event
        sessionStore.addEvent({
          sessionId: sessionManager.getSessionId(),
          eventType: 'context_retrieved',
          content: `Retrieved ${result.chunks.length} chunks. Token count: ${compiled.tokenCount}.`,
          relatedFiles: null
        });

        const diagnosticHeader = `ContextOS | tokens: ${compiled.tokenCount}/${max_tokens}\n\n`;
        const text = diagnosticHeader + compiled.output;
        cacheSet(cacheKey, text);

        return {
          content: [
            {
              type: "text",
              text,
            },
          ],
        };
      } catch (error: any) {
        sessionStore.addEvent({
          sessionId: sessionManager.getSessionId(),
          eventType: 'error',
          content: `Error: ${error.message}`,
          relatedFiles: null
        });

        return {
          content: [{ type: "text", text: `Error retrieving context: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
