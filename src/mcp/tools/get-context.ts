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
import crypto from "crypto";

export function registerGetContextTool(server: McpServer, dbs: DB[]) {
  const chunksRepos = dbs.map(db => new ChunksRepo(db.getInstance()));
  const relsRepos = dbs.map(db => new RelationshipsRepo(db.getInstance()));
  
  // Session tracking strictly uses the primary DB
  const primaryDb = dbs[0];
  const promptsRepo = new PromptsRepo(primaryDb.getInstance());
  const sessionStore = new SessionStore(primaryDb);
  const sessionManager = new SessionManager(promptsRepo, sessionStore);
  
  const engine = new RetrievalEngine(chunksRepos, relsRepos);

  server.tool(
    "get_context",
    "Retrieve relevant engineering context for a coding task. Call this BEFORE answering any coding question to get relevant conventions, architecture details, service relationships, and implementation patterns. Returns only the context needed for the specific task.",
    {
      prompt: z.string().describe("The user's coding question or task description"),
      max_tokens: z.number().optional().default(4000).describe("Maximum tokens for returned context"),
      layers: z.array(z.enum(["global", "workspace", "repo", "session"]))
        .optional()
        .describe("Which context layers to search. Defaults to all layers."),
      output_format: z.enum(["markdown", "xml"]).optional().default("markdown").describe("Format of the compiled context. Use XML if you are Claude or similar LLM that prefers XML."),
    },
    async ({ prompt, max_tokens, layers, output_format }) => {
      try {
        // Record user prompt event
        sessionStore.addEvent({
          sessionId: sessionManager.getSessionId(),
          eventType: 'user_prompt',
          content: prompt,
          relatedFiles: null
        });

        const result = await engine.retrieve(prompt, {
          maxChunks: 15,
          layers: layers as string[],
        });
        
        // Add session context
        const sessionChunks = await sessionManager.getSessionContext();
        
        // Push session chunks into result
        for (const sc of sessionChunks) {
          result.chunks.push({
            ...sc,
            sourceFile: 'session',
            sectionTitle: null,
            sectionDepth: 0,
            summary: null,
            keywords: null,
            hash: '',
            tokenCount: 0, // estimated in compile
            score: sc.importance
          } as any);
        }

        // Add cross-session memory facts
        const knowledgeStore = new KnowledgeStore(primaryDb);
        const knowledgeFacts = knowledgeStore.searchFacts(prompt, 5);
        for (const fact of knowledgeFacts) {
          result.chunks.push({
            id: fact.id,
            content: `**[${fact.category.toUpperCase()}]**: ${fact.fact}`,
            sourceFile: 'memory.fact',
            layer: 'global',
            workspaceName: null,
            sectionTitle: 'Cross-Session Knowledge Fact',
            sectionDepth: 1,
            summary: null,
            keywords: null,
            hash: '',
            tokenCount: 0, // estimated in compile
            score: fact.confidence * 10,
            fileType: 'text',
            language: undefined
          } as any);
        }

        const compiled = compile(result, { maxTokens: max_tokens, outputFormat: output_format as any });
        
        // Log to prompt history
        promptsRepo.insert({
          id: crypto.randomUUID(),
          prompt,
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
        
        return {
          content: [
            {
              type: "text",
              text: compiled.output,
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
