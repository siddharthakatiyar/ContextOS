import crypto from "crypto";
import { RetrievalEngine } from "../../core/retrieval/index.js";
import { compile } from "../../core/compiler/index.js";
import { SessionStore } from "../../core/session/session-store.js";
import { SessionManager } from "../../core/session/index.js";
import { KnowledgeStore } from "../../core/memory/knowledge-store.js";
import { PromptsRepo } from "../../core/storage/prompts-repo.js";
import { estimateTokens } from "../../utils/tokens.js";
import { recordRetrievedChunks } from "./feedback.js";
import { loadConfig } from "../../config/index.js";
import type { ScoredChunk } from "../../core/retrieval/types.js";

import { mergeMemoryPipeline } from '../../core/session/memory-merge.js';
import { globalSentRegistry } from '../../core/session/sent-registry.js';

export interface GetContextOpts {
  maxTokens?: number;
  layers?: string[];
  outputFormat?: "markdown" | "xml";
  repoRoot?: string;
}

export interface GetContextDeps {
  engine: RetrievalEngine;
  sessionManager: SessionManager;
  knowledgeStore: KnowledgeStore;
  promptsRepo: PromptsRepo;
  sessionStore: SessionStore;
}

export async function executeGetContext(
  prompt: string,
  opts: GetContextOpts,
  deps: GetContextDeps
) {
  const { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore } = deps;
  const maxTokens = opts.maxTokens ?? loadConfig().maxTokenBudget;
  const layers = opts.layers ?? ["session", "workspace", "repo"];
  const outputFormat = opts.outputFormat ?? "markdown";
  const repoRoot = opts.repoRoot ?? process.cwd();

  // Record user prompt event
  sessionStore.addEvent({
    sessionId: sessionManager.getSessionId(),
    eventType: 'user_prompt',
    content: prompt.length > 2000 ? prompt.substring(0, 2000) + '... [truncated]' : prompt,
    relatedFiles: null
  });

  const result = await engine.retrieve(prompt, {
    maxChunks: loadConfig().maxRetrievalResults,
    layers,
    repoRoot,
  });

  const sessionChunks = await sessionManager.getSessionContext();
  const knowledgeFacts = knowledgeStore.searchFacts(prompt, 2);
  result.chunks = mergeMemoryPipeline(result.chunks, sessionChunks, knowledgeFacts, result.intent);

  const config = loadConfig();
  if (config.sentDedupEnabled !== false && result.chunks.length > 0) {
    const leader = result.chunks[0];
    for (let i = 1; i < result.chunks.length; i++) {
      const c = result.chunks[i];
      if (c.content && c.hash) {
        if (globalSentRegistry.hasBeenSent(c.hash)) {
          c.content = `(sent earlier, unchanged)`;
          c.tokenCount = estimateTokens(c.content);
        } else {
          globalSentRegistry.markSent(c.hash);
        }
      }
    }
    if (leader.hash) {
      globalSentRegistry.markSent(leader.hash);
    }
  }

  const compiled = compile(result, {
    maxTokens,
    outputFormat: "markdown",
    signalTerms: [
      ...(result.intent?.identifiers || []),
      ...(result.intent?.concepts || []),
    ],
  });

  recordRetrievedChunks(result.chunks);

  promptsRepo.insert({
    id: crypto.randomUUID(),
    prompt: prompt.length > 2000 ? prompt.substring(0, 2000) + '... [truncated]' : prompt,
    extractedConcepts: JSON.stringify(result.intent.concepts),
    retrievedChunkIds: JSON.stringify(result.chunks.map(c => c.id)),
    compiledTokenCount: compiled.tokenCount,
    latencyMs: result.latencyMs,
    createdAt: Date.now()
  });

  sessionStore.addEvent({
    sessionId: sessionManager.getSessionId(),
    eventType: 'context_retrieved',
    content: `Retrieved ${result.chunks.length} chunks. Token count: ${compiled.tokenCount}.`,
    relatedFiles: null
  });

  return {
    text: compiled.output,
    compiled,
    result
  };
}
