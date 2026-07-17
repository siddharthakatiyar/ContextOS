/**
 * Fresh benchmark topics verified against the live codebase (2026-07-12).
 * Each entry has a specific prompt (names file/symbol) and a generic prompt
 * (same underlying answer, no spoilers).
 */
export const TOPIC_DEFS = [
  {
    id: "containment-dedup",
    topic: "Class/method containment dedup",
    specific:
      "How does containmentDedup in src/core/retrieval/index.ts decide when to drop oversized class bodies vs keep method chunks?",
    generic:
      "How does retrieval avoid returning both a class and all of its methods when that would be redundant?",
    grepPattern: "export function containmentDedup|isCompactOutline|parentTokens > 500",
    grepGlob: "**/retrieval/index.ts",
    requiredFiles: ["src/core/retrieval/index.ts"],
    requiredMarkers: [
      "export function containmentDedup",
      "isCompactOutline",
      "parentTokens > 500",
      "symbolKind === 'segment'",
      "exactId",
    ],
  },
  {
    id: "retrieval-pipeline",
    topic: "RetrievalEngine retrieve pipeline",
    specific:
      "Walk through RetrievalEngine.retrieve in src/core/retrieval/index.ts — steps from detectIntent to returning topChunks",
    generic:
      "What is the full pipeline when ContextOS retrieves context for a prompt?",
    grepPattern: "public async retrieve\\(prompt|detectIntent|containmentDedup|applyEmbeddingFusion",
    grepGlob: "**/retrieval/index.ts",
    requiredFiles: ["src/core/retrieval/index.ts"],
    requiredMarkers: [
      "public async retrieve(prompt: string",
      "const intent = detectIntent(prompt)",
      "allChunksMap",
      "scored = containmentDedup(scored, intent.identifiers)",
      "applyEmbeddingFusion",
    ],
  },
  {
    id: "rrf-keyword-matcher",
    topic: "Reciprocal Rank Fusion keyword matching",
    specific:
      "How does reciprocalRankFusion and KeywordMatcher.matchChunks in keyword-matcher.ts fuse FTS strategy lists?",
    generic:
      "How does ContextOS combine multiple search strategies into one ranked chunk list?",
    grepPattern: "export function reciprocalRankFusion|matchChunks|RRF_K",
    grepGlob: "**/keyword-matcher.ts",
    requiredFiles: ["src/core/retrieval/keyword-matcher.ts"],
    requiredMarkers: [
      "export function reciprocalRankFusion",
      "const RRF_K = 60",
      "MAX_CLASS_EXPAND_PER_ID",
      "public matchChunks(intent: DetectedIntent",
      "return reciprocalRankFusion(strategyLists)",
    ],
  },
  {
    id: "intent-detector",
    topic: "Prompt intent / identifier extraction",
    specific:
      "How does detectIntent in intent-detector.ts extract camelCase identifiers and synthesize names like createSession?",
    generic:
      "How does ContextOS figure out which code symbols a natural-language question is talking about?",
    grepPattern: "export function detectIntent|looksLikeRealIdentifier|classifyIntentType",
    grepGlob: "**/intent-detector.ts",
    requiredFiles: ["src/core/retrieval/intent-detector.ts"],
    requiredMarkers: [
      "export function detectIntent(prompt: string)",
      "function looksLikeRealIdentifier",
      "extractQuotedTerms",
      "const verbStems = [",
      "function classifyIntentType",
    ],
  },
  {
    id: "poison-scorer",
    topic: "Poison path and noise score penalties",
    specific:
      "What do applyPoisonPenalty and applyNoiseDemotion in scorer.ts do to chunk scores?",
    generic:
      "How does ranking demote junk paths like node_modules, changelogs, tests, and File Structure stubs?",
    grepPattern: "export function applyPoisonPenalty|applyNoiseDemotion|finalScore = -9999",
    grepGlob: "**/scorer.ts",
    requiredFiles: ["src/core/retrieval/scorer.ts"],
    requiredMarkers: [
      "export function applyPoisonPenalty",
      "finalScore = -9999",
      "export function applyNoiseDemotion",
      "sectionTitle === 'File Structure'",
      "Prefer repo-local source files over foreign workspace pollution",
    ],
  },
  {
    id: "expand-match-tokens",
    topic: "Token stemming for fuzzy symbol match",
    specific:
      "What stemming variants does expandMatchTokens in keyword-matcher.ts generate from concept tokens?",
    generic:
      "How does search expand words like extraction or deduplicated to hit related symbol names?",
    grepPattern: "export function expandMatchTokens|stemVariants|get_context",
    grepGlob: "**/keyword-matcher.ts",
    requiredFiles: ["src/core/retrieval/keyword-matcher.ts"],
    requiredMarkers: [
      "export function expandMatchTokens(tokens: string[])",
      "get_context → getcontext for symbol match",
      "t.endsWith('ion') && t.length > 6",
      "t.endsWith('ies') && t.length > 5",
      "function stemVariants(stem: string)",
    ],
  },
  {
    id: "embedding-fusion",
    topic: "Optional embedding fusion in retrieve",
    specific:
      "When does applyEmbeddingFusion in RetrievalEngine call searchEmbeddingChunks, and how does lowConfidence gate it?",
    generic:
      "When does ContextOS fall back to vector or embedding search on top of keyword hits?",
    grepPattern: "applyEmbeddingFusion|searchEmbeddingChunks|CONTEXTOS_EMBEDDINGS",
    grepGlob: "**/retrieval/index.ts",
    requiredFiles: ["src/core/retrieval/index.ts"],
    requiredMarkers: [
      "private async applyEmbeddingFusion",
      "CONTEXTOS_EMBEDDINGS_RETRIEVAL",
      "embeddingsRetrieval === true",
      "searchEmbeddingChunks",
      "lowConfidence",
    ],
  },
  {
    id: "compiler-format",
    topic: "Context compiler output formatting",
    specific:
      "How does compile() in src/core/compiler/index.ts build markdown vs XML with <contextos_context>?",
    generic:
      "How is retrieved context formatted into the final string returned to the agent?",
    grepPattern: "export function compile|compressChunks|contextos_context|buildPathAliases",
    grepGlob: "**/compiler/index.ts",
    requiredFiles: ["src/core/compiler/index.ts"],
    requiredMarkers: [
      "export function compile(result: RetrievalResult, opts: CompilerOptions)",
      "compressChunks(result.chunks, compressBudget",
      "<contextos_context>",
      "</contextos_context>",
      "buildPathAliases",
    ],
  },
  {
    id: "pack-to-budget",
    topic: "Compressor packToBudget truncation",
    specific:
      "How does packToBudget in compressor.ts preserve markers like allChunksMap and containmentDedup when truncating?",
    generic:
      "How does the compressor keep important implementation markers when fitting chunks into a token budget?",
    grepPattern: "export function packToBudget|truncTerms|pushStubOrMini",
    grepGlob: "**/compressor.ts",
    requiredFiles: ["src/core/compiler/compressor.ts"],
    requiredMarkers: [
      "export function packToBudget",
      "truncTerms.push('deduplicate', 'allChunksMap', 'score +=', 'containmentDedup')",
      "'detectIntent', 'matchChunks', 'expander.expand', 'scoreChunks'",
      "room < 40",
      "pushStubOrMini",
    ],
  },
  {
    id: "truncate-signals",
    topic: "Signal-preserving truncation",
    specific:
      "How does truncatePreservingSignals in compressor.ts keep lines that hit signal terms while shrinking content?",
    generic:
      "How does ContextOS truncate long code chunks without deleting the lines that answer the query?",
    grepPattern: "export function truncatePreservingSignals|buildSignalRegex|longestSignalHit",
    grepGlob: "**/compressor.ts",
    requiredFiles: ["src/core/compiler/compressor.ts"],
    requiredMarkers: [
      "export function truncatePreservingSignals",
      "buildSignalRegex",
      "allChunksMap|containmentDedup",
      "longestSignalHit",
      "WEAK_STOP",
    ],
  },
  {
    id: "segment-large-symbol",
    topic: "Large symbol segmentation",
    specific:
      "How does segmentLargeSymbol in code-chunker.ts split large functions into ~320-token segments?",
    generic:
      "How are oversized functions broken into smaller searchable pieces for indexing?",
    grepPattern: "export function segmentLargeSymbol|targetTokens|isSegmentBoundary",
    grepGlob: "**/code-chunker.ts",
    requiredFiles: ["src/core/chunker/code-chunker.ts"],
    requiredMarkers: [
      "export function segmentLargeSymbol",
      "targetTokens: number = 320",
      "tok >= targetTokens * 1.35",
      "isSegmentBoundary",
    ],
  },
  {
    id: "file-structure-chunk",
    topic: "File Structure summary chunks",
    specific:
      "Where does chunkCode create the File Structure / File Summary chunk listing symbols?",
    generic:
      "Does indexing create a high-level per-file symbol outline chunk, and how is it titled?",
    grepPattern: "export function chunkCode|File Structure|File Summary",
    grepGlob: "**/code-chunker.ts",
    requiredFiles: ["src/core/chunker/code-chunker.ts"],
    requiredMarkers: [
      "export function chunkCode",
      "sectionTitle: 'File Structure'",
      "stableChunkId(doc.filePath, 'File Summary')",
      "maxSymbolChunkTokens",
    ],
  },
  {
    id: "fts-sanitizer",
    topic: "FTS5 query sanitization",
    specific:
      "How does sanitizeFTSQuery with preserveOperators handle quoted terms vs stripping AND/OR/NOT?",
    generic:
      "How are user search strings cleaned before SQLite FTS5 MATCH queries?",
    grepPattern: "export function sanitizeFTSQuery|preserveOperators|sanitizeFTSTerm",
    grepGlob: "**/fts-sanitizer.ts",
    requiredFiles: ["src/core/storage/fts-sanitizer.ts"],
    requiredMarkers: [
      "export function sanitizeFTSQuery",
      "preserveOperators?: boolean",
      "sanitizeFTSTerm",
    ],
  },
  {
    id: "chunks-repo-bm25",
    topic: "ChunksRepo BM25 FTS search",
    specific:
      "Show the searchFTS SQL in chunks-repo.ts that uses bm25(chunks_fts, 10.0, 1.0, 20.0, 8.0)",
    generic:
      "How does ContextOS score full-text matches against indexed chunks?",
    grepPattern: "searchFTS|bm25\\(chunks_fts",
    grepGlob: "**/chunks-repo.ts",
    requiredFiles: ["src/core/storage/chunks-repo.ts"],
    requiredMarkers: [
      "public searchFTS(query: string",
      "bm25(chunks_fts, 10.0, 1.0, 20.0, 8.0)",
      "WHERE chunks_fts MATCH ?",
    ],
  },
  {
    id: "schema-chunks-fts",
    topic: "SQLite schema and chunks_fts",
    specific:
      "What does SCHEMA_SQL in schema.ts define for chunks_fts and its AI/AD/AU triggers?",
    generic:
      "What is the SQLite schema for indexed chunks and full-text search?",
    grepPattern: "SCHEMA_SQL|chunks_fts USING fts5|chunks_ai AFTER INSERT",
    grepGlob: "**/schema.ts",
    requiredFiles: ["src/core/storage/schema.ts"],
    requiredMarkers: [
      "export const SCHEMA_SQL",
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(",
      "CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks",
    ],
  },
  {
    id: "server-lock",
    topic: "Server PID lockfile",
    specific:
      "How does acquireServerLock in database.ts use .contextos/server.pid and process.kill(pid, 0)?",
    generic:
      "How does ContextOS prevent two servers from writing the same project index at once?",
    grepPattern: "acquireServerLock|releaseServerLock|server.pid",
    grepGlob: "**/database.ts",
    requiredFiles: ["src/core/storage/database.ts"],
    requiredMarkers: [
      "export function acquireServerLock(projectDir: string)",
      "server.pid",
      "process.kill(existingPid, 0)",
      "export function releaseServerLock",
    ],
  },
  {
    id: "graph-expander",
    topic: "Graph expansion with hub filtering",
    specific:
      "How does GraphExpander.expand use MAX_CONNECTIONS_THRESHOLD and MIN_EDGE_WEIGHT when walking relationships?",
    generic:
      "How does ContextOS expand related entities in the code graph without following noisy hubs?",
    grepPattern: "class GraphExpander|MAX_CONNECTIONS_THRESHOLD|MIN_EDGE_WEIGHT",
    grepGlob: "**/expander.ts",
    requiredFiles: ["src/core/graph/expander.ts"],
    requiredMarkers: [
      "export class GraphExpander",
      "MAX_CONNECTIONS_THRESHOLD = 30",
      "MIN_EDGE_WEIGHT = 0.9",
      "Math.pow(0.5, current.depth)",
    ],
  },
  {
    id: "import-relationships",
    topic: "Import relationship extraction",
    specific:
      "How does extractImportRelationships set IMPORTS_WEIGHT vs USES_WEIGHT for graph edges?",
    generic:
      "How are import edges between files or symbols created for the relationship graph?",
    grepPattern: "extractImportRelationships|IMPORTS_WEIGHT|USES_WEIGHT",
    grepGlob: "**/extractor.ts",
    requiredFiles: ["src/core/graph/extractor.ts"],
    requiredMarkers: [
      "export function extractImportRelationships",
      "const IMPORTS_WEIGHT = 2.0",
      "const USES_WEIGHT = 0.8",
    ],
  },
  {
    id: "session-rotation",
    topic: "Session rotation and retention",
    specific:
      "How do SESSION_ROTATION_MS and shouldRotateSession in session-store.ts decide when to start a new session?",
    generic:
      "When does ContextOS rotate the current chat session and prune old session data?",
    grepPattern: "SESSION_ROTATION_MS|shouldRotateSession|pruneRetention",
    grepGlob: "**/session-store.ts",
    requiredFiles: ["src/core/session/session-store.ts"],
    requiredMarkers: [
      "export const SESSION_ROTATION_MS = 24 * 60 * 60 * 1000",
      "export function shouldRotateSession",
      "public pruneRetention",
    ],
  },
  {
    id: "daemon-gc-idle",
    topic: "Daemon idle GC shutdown",
    specific:
      "How does ContextOSDaemon shut down after 30 minutes with no connections?",
    generic:
      "Does the background daemon exit when idle, and how long does it wait?",
    grepPattern: "ContextOSDaemon|30 minutes|handleConnection",
    grepGlob: "**/daemon/daemon.ts",
    requiredFiles: ["src/core/daemon/daemon.ts"],
    requiredMarkers: [
      "export class ContextOSDaemon",
      "No connections for 30 minutes, shutting down daemon.",
      "handleConnection",
    ],
  },
  {
    id: "file-watcher",
    topic: "Filesystem watcher allowlist",
    specific:
      "How does startWatcher use ALLOWED_DOT_SEGMENTS and awaitWriteFinish.stabilityThreshold for reindexing?",
    generic:
      "How does ContextOS watch the repo for file changes while ignoring .git/node_modules but allowing .cursor rules?",
    grepPattern: "startWatcher|ALLOWED_DOT_SEGMENTS|stabilityThreshold",
    grepGlob: "**/watcher/index.ts",
    requiredFiles: ["src/core/watcher/index.ts"],
    requiredMarkers: [
      "export function startWatcher",
      "ALLOWED_DOT_SEGMENTS",
      "stabilityThreshold: 400",
    ],
  },
  {
    id: "get-context-memory",
    topic: "get_context memory merge pipeline",
    specific:
      "How does mergeMemoryPipeline in get-context.ts cap session/knowledge chunks with MEMORY_CHUNK_CAP?",
    generic:
      "How are session notes and learned facts merged into retrieved code context without crowding it out?",
    grepPattern: "mergeMemoryPipeline|MEMORY_CHUNK_CAP|Cross-Session Knowledge",
    grepGlob: "**/get-context.ts",
    requiredFiles: ["src/mcp/tools/get-context.ts"],
    requiredMarkers: [
      "function mergeMemoryPipeline",
      "MEMORY_CHUNK_CAP = 3",
      "Cross-Session Knowledge Fact",
    ],
  },
  {
    id: "ctx-execute-allowlist",
    topic: "ctx_execute command sandbox",
    specific:
      "How does registerExecuteTool block FIND_DANGEROUS_FLAGS for ctx_execute?",
    generic:
      "What shell commands are MCP agents allowed to run, and which find flags are blocked?",
    grepPattern: "FIND_DANGEROUS_FLAGS|hasDangerousFindFlag|ctx_execute",
    grepGlob: "**/execute.ts",
    requiredFiles: ["src/mcp/tools/execute.ts"],
    requiredMarkers: [
      "FIND_DANGEROUS_FLAGS",
      '"ctx_execute"',
      "hasDangerousFindFlag",
    ],
  },
  {
    id: "knowledge-store",
    topic: "Cross-session knowledge facts",
    specific:
      "How does KnowledgeStore.learnFact reinforce duplicates and runPeriodicDecay with DECAY_INTERVAL_MS?",
    generic:
      "How are learn_fact memories stored and decayed over time?",
    grepPattern: "class KnowledgeStore|DECAY_INTERVAL_MS|runPeriodicDecay",
    grepGlob: "**/knowledge-store.ts",
    requiredFiles: ["src/core/memory/knowledge-store.ts"],
    requiredMarkers: [
      "export class KnowledgeStore",
      "DECAY_INTERVAL_MS = 60 * 60 * 1000",
      "public runPeriodicDecay",
    ],
  },
  {
    id: "default-config",
    topic: "Default retrieval/chunking config",
    specific:
      "What are maxSymbolChunkTokens, maxRetrievalResults, and maxTokenBudget in defaultConfig?",
    generic:
      "What are the default knobs for chunk size, retrieval count, and token budget?",
    grepPattern: "defaultConfig|maxSymbolChunkTokens|maxTokenBudget",
    grepGlob: "**/defaults.ts",
    requiredFiles: ["src/config/defaults.ts"],
    requiredMarkers: [
      "export const defaultConfig",
      "maxSymbolChunkTokens: 900",
      "maxRetrievalResults: 25",
      "maxTokenBudget: 1200",
    ],
  },
  {
    id: "embed-chunk-text",
    topic: "Embedding text preparation",
    specific:
      "How does embedChunkText build compact embedding input with EMBED_CONTENT_CHAR_CAP and EMBED_CONTENT_LINE_CAP?",
    generic:
      "What text from a chunk gets fed into the embedding model for vector search?",
    grepPattern: "embedChunkText|EMBED_CONTENT_CHAR_CAP|EMBED_CONTENT_LINE_CAP",
    grepGlob: "**/embeddings/index.ts",
    requiredFiles: ["src/core/embeddings/index.ts"],
    requiredMarkers: [
      "export function embedChunkText",
      "EMBED_CONTENT_CHAR_CAP = 500",
      "EMBED_CONTENT_LINE_CAP = 40",
    ],
  },
  {
    id: "importance-scorer",
    topic: "File importance scoring",
    specific:
      "How does scoreFileImportance boost readme.md / core dirs and demote tests/vendor?",
    generic:
      "How does indexing decide that some files are more important than others by default?",
    grepPattern: "scoreFileImportance|readme.md|Math.max\\(1, Math.min\\(10",
    grepGlob: "**/importance-scorer.ts",
    requiredFiles: ["src/core/indexer/importance-scorer.ts"],
    requiredMarkers: [
      "export function scoreFileImportance",
      "filename === 'readme.md'",
      "Math.max(1, Math.min(10, score))",
    ],
  },
  {
    id: "cursor-mcp-config",
    topic: "Cursor MCP config generator",
    specific:
      "What does generateCursorConfig emit for mcpServers.contextos including CONTEXTOS_REPO_ROOT?",
    generic:
      "How does ContextOS generate the Cursor MCP server JSON to launch itself?",
    grepPattern: "generateCursorConfig|CONTEXTOS_REPO_ROOT|contextos@latest",
    grepGlob: "**/config-generator.ts",
    requiredFiles: ["src/mcp/cursor/config-generator.ts"],
    requiredMarkers: [
      "export function generateCursorConfig",
      "CONTEXTOS_REPO_ROOT",
      "@siddharthakatiyar/contextos@latest",
    ],
  },
];

/** Expand defs into runnable topics for a prompt style. */
export function buildSuite(style /* 'specific' | 'generic' */) {
  return TOPIC_DEFS.map((d, i) => ({
    n: i + 1,
    id: d.id,
    topic: d.topic,
    style,
    prompt: style === "specific" ? d.specific : d.generic,
    grepPattern: d.grepPattern,
    grepGlob: d.grepGlob,
    requiredFiles: d.requiredFiles,
    requiredMarkers: d.requiredMarkers,
  }));
}

export const SPECIFIC_TOPICS = buildSuite("specific");
export const GENERIC_TOPICS = buildSuite("generic");

/** Topics that share files — good for session-cache Track B. */
export const SESSION_TOPIC_IDS = [
  "containment-dedup",
  "retrieval-pipeline",
  "embedding-fusion",
  "poison-scorer",
  "rrf-keyword-matcher",
  "expand-match-tokens",
  "pack-to-budget",
  "truncate-signals",
];
