#!/usr/bin/env node
/**
 * End-to-end A/B benchmark: ContextOS get_context flow vs Grep+Read flow.
 * Counts ALL calls and tokens until the agent has the full implementation body.
 *
 * Completeness = every requiredMarkers[] string appears in accumulated context
 * (search output + any follow-up file reads).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);

// Use compiled dist (same as MCP server)
const { DB } = await import(path.join(ROOT, "dist/src/core/storage/database.js"));
const { ChunksRepo } = await import(path.join(ROOT, "dist/src/core/storage/chunks-repo.js"));
const { RelationshipsRepo } = await import(path.join(ROOT, "dist/src/core/storage/relationships-repo.js"));
const { PromptsRepo } = await import(path.join(ROOT, "dist/src/core/storage/prompts-repo.js"));
const { SessionStore } = await import(path.join(ROOT, "dist/src/core/session/session-store.js"));
const { SessionManager } = await import(path.join(ROOT, "dist/src/core/session/index.js"));
const { RetrievalEngine } = await import(path.join(ROOT, "dist/src/core/retrieval/index.js"));
const { compile } = await import(path.join(ROOT, "dist/src/core/compiler/index.js"));
const { KnowledgeStore } = await import(path.join(ROOT, "dist/src/core/memory/knowledge-store.js"));
const { estimateTokens } = await import(path.join(ROOT, "dist/src/utils/tokens.js"));

const MAX_TOKENS = 1200;
const MEMORY_CHUNK_CAP = 3;

/** Same estimateTokens used by ContextOS — applied to Grep/Read outputs for fair comparison. */
function tok(text) {
  return estimateTokens(text || "");
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * Ground truth: files the agent must eventually read (or receive via get_context)
 * and marker strings that prove the implementation body is present.
 */
const TOPICS = [
  {
    n: 1,
    topic: "Session lifecycle & DB events",
    prompt:
      "Session lifecycle and DB events - how sessions are created, updated, and persisted with database events",
    grepPattern: "createSession|addEvent|session_events|SessionStore|SessionManager",
    grepGlob: "*.{ts,tsx}",
    requiredFiles: [
      "src/core/session/session-store.ts",
      "src/core/session/index.ts",
    ],
    requiredMarkers: [
      "createSession",
      "addEvent",
      "getRecentEvents",
      "INSERT INTO session_events",
      "getSessionContext",
    ],
  },
  {
    n: 2,
    topic: "RetrievalEngine prompt→chunks sequence",
    prompt:
      "RetrievalEngine prompt to chunks sequence - how a prompt flows through retrieval to return scored chunks",
    grepPattern: "class RetrievalEngine|async retrieve\\(|scoreChunks|matchChunks",
    grepGlob: "**/retrieval/**/*.{ts,tsx}",
    requiredFiles: ["src/core/retrieval/index.ts"],
    requiredMarkers: [
      "class RetrievalEngine",
      "detectIntent",
      "matchChunks",
      "expander.expand",
      "scoreChunks",
    ],
  },
  {
    n: 3,
    topic: "Poison path filtering in scoring",
    prompt:
      "Poison path filtering in scoring - how poison or excluded paths are filtered during chunk scoring",
    grepPattern: "poison|node_modules|finalScore = -9999",
    grepGlob: "**/scorer.ts",
    requiredFiles: ["src/core/retrieval/scorer.ts"],
    requiredMarkers: [
      "Hard penalty for poison paths",
      "node_modules",
      "finalScore = -9999",
    ],
  },
  {
    n: 4,
    topic: "Chunks table schema + FTS5",
    prompt: "Chunks table schema and FTS5 full-text search setup",
    grepPattern: "CREATE TABLE.*chunks|chunks_fts|USING fts5",
    grepGlob: "**/schema.ts",
    requiredFiles: ["src/core/storage/schema.ts"],
    requiredMarkers: [
      "CREATE TABLE IF NOT EXISTS chunks",
      "CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5",
    ],
  },
  {
    n: 5,
    topic: "Entity extraction → RelationshipsRepo",
    prompt:
      "Entity extraction to RelationshipsRepo - how entities are extracted and relationships stored",
    grepPattern: "extractRelationships|extractEntities|RelationshipsRepo|bulkUpsert",
    grepGlob: "*.{ts,tsx}",
    requiredFiles: [
      "src/core/graph/extractor.ts",
      "src/core/storage/relationships-repo.ts",
    ],
    requiredMarkers: [
      "function extractRelationships",
      "extractEntities",
      "class RelationshipsRepo",
      "bulkUpsert",
    ],
  },
  {
    n: 6,
    topic: "compile layer grouping + token budget",
    prompt:
      "compile layer grouping and token budget - how context layers are grouped and token budget is applied during compilation",
    grepPattern: "function compile|byLayer|maxTokens|compressChunks",
    grepGlob: "**/compiler/**/*.{ts,tsx}",
    requiredFiles: ["src/core/compiler/index.ts"],
    requiredMarkers: [
      "function compile",
      "compressChunks",
      "byLayer",
      "session:",
      "maxTokens",
    ],
  },
  {
    n: 7,
    topic: "KeywordMatcher error semantic routing",
    prompt:
      "KeywordMatcher error semantic routing - how error-related queries are routed semantically in keyword matching",
    grepPattern: "findByFileStem|intentType === .fix.|Filename / path stem|errorHandler",
    grepGlob: "**/keyword-matcher.ts",
    requiredFiles: ["src/core/retrieval/keyword-matcher.ts"],
    requiredMarkers: [
      "Strategy 4: Intent-aware boosting",
      "Strategy 5: Filename / path stem matching",
      "findByFileStem",
      "intentType === 'fix'",
    ],
  },
  {
    n: 8,
    topic: "defaults.ts config overrides",
    prompt:
      "defaults.ts config overrides - how default configuration values are defined and overridden",
    grepPattern: "defaultConfig|maxTokenBudget|diversityDecay",
    grepGlob: "**/defaults.ts",
    requiredFiles: ["src/config/defaults.ts", "src/config/index.ts"],
    requiredMarkers: [
      "export const defaultConfig",
      "maxTokenBudget",
      "function loadConfig",
      "mergeDeep",
    ],
  },
  {
    n: 9,
    topic: "get_context cross-session knowledge facts",
    prompt:
      "get_context cross-session knowledge facts - how get_context retrieves knowledge facts across sessions",
    grepPattern: "searchFacts|KnowledgeStore|Cross-Session Knowledge",
    grepGlob: "**/get-context.ts",
    requiredFiles: ["src/mcp/tools/get-context.ts"],
    requiredMarkers: [
      "knowledgeStore.searchFacts",
      "Cross-Session Knowledge Fact",
      "fact.confidence",
    ],
  },
  {
    n: 10,
    topic: "Markdown parser heading chunking",
    prompt:
      "Markdown parser heading chunking - how markdown files are split into chunks by headings",
    grepPattern: "parseMarkdown|headingMatch|createSection",
    grepGlob: "**/markdown-parser.ts",
    requiredFiles: ["src/core/parser/markdown-parser.ts"],
    requiredMarkers: [
      "function parseMarkdown",
      "headingMatch",
      "createSection",
      "buildTree",
    ],
  },
  {
    n: 11,
    topic: "SessionStore add/retrieve by session ID",
    prompt:
      "SessionStore add and retrieve by session ID - createSession getSession addEvent getRecentEvents",
    grepPattern: "createSession|getSession|addEvent|getRecentEvents",
    grepGlob: "**/session-store.ts",
    requiredFiles: ["src/core/session/session-store.ts"],
    requiredMarkers: [
      "createSession",
      "getSession",
      "addEvent",
      "getRecentEvents",
      "WHERE session_id = ?",
    ],
  },
  {
    n: 12,
    topic: "Graph expansion (depth + score boosts)",
    prompt:
      "Graph expansion depth and score boosts - GraphExpander expand with depth and entity scores",
    grepPattern: "class GraphExpander|maxDepth|Math.pow\\(0.5",
    grepGlob: "**/expander.ts",
    requiredFiles: ["src/core/graph/expander.ts"],
    requiredMarkers: [
      "class GraphExpander",
      "maxDepth",
      "Math.pow(0.5, current.depth)",
      "findRelated",
    ],
  },
  {
    n: 13,
    topic: "Dedup/merge before final scoring",
    prompt:
      "Dedup merge before final scoring - how chunks are deduplicated and merged before scoreChunks",
    grepPattern: "allChunksMap|deduplicate|score \\+= ",
    grepGlob: "**/retrieval/index.ts",
    requiredFiles: ["src/core/retrieval/index.ts"],
    requiredMarkers: [
      "deduplicate and sum scores",
      "allChunksMap",
      "score +=",
      "scoreChunks",
    ],
  },
  {
    n: 14,
    topic: "KnowledgeStore.searchFacts confidence",
    prompt: "KnowledgeStore searchFacts confidence ordering and decay",
    grepPattern: "searchFacts|applyDecay|confidence \\* f.rank",
    grepGlob: "**/knowledge-store.ts",
    requiredFiles: ["src/core/memory/knowledge-store.ts"],
    requiredMarkers: [
      "searchFacts",
      "applyDecay",
      "ORDER BY f.rank ASC, k.confidence DESC",
      "confidence = MAX(confidence - 0.05",
    ],
  },
  {
    n: 15,
    topic: "Diversity decay by source file",
    prompt:
      "Diversity decay by source file - diversityDecay diversityPenaltyStart in scorer",
    grepPattern: "diversityDecay|diversityPenaltyStart|fileCounts",
    grepGlob: "**/scorer.ts",
    requiredFiles: ["src/core/retrieval/scorer.ts"],
    requiredMarkers: [
      "diversityDecay",
      "diversityPenaltyStart",
      "fileCounts",
      "Math.pow(diversityDecay",
    ],
  },
  {
    n: 16,
    topic: "CLI registration + query command",
    prompt:
      "CLI registration and query command - how CLI commands are registered including the query command",
    grepPattern: "queryCommand|addCommand|program\\.|Command\\(",
    grepGlob: "**/cli/**/*.{ts,tsx}",
    requiredFiles: ["src/cli/commands/query.ts", "bin/contextos.ts"],
    requiredMarkers: [
      "queryCommand",
      "new Command('query')",
      "addCommand(queryCommand)",
    ],
  },
  {
    n: 17,
    topic: "initCommand full setup flow",
    prompt:
      "initCommand full setup flow - what initCommand does during ContextOS initialization",
    grepPattern: "initCommand|new Command\\('init'\\)",
    grepGlob: "**/init.ts",
    requiredFiles: ["src/cli/commands/init.ts"],
    requiredMarkers: [
      "initCommand",
      "new Command('init')",
      ".action(async",
    ],
  },
  {
    n: 18,
    topic: "FileWatcher change → reindex",
    prompt:
      "FileWatcher change to reindex - how file watcher detects changes and triggers reindexing",
    grepPattern: "startWatcher|chokidar|\\.on\\('change'",
    grepGlob: "**/watcher/**/*.{ts,tsx}",
    requiredFiles: ["src/core/watcher/index.ts"],
    requiredMarkers: [
      "function startWatcher",
      "chokidar.watch",
      ".on('change'",
      "indexer.indexFile",
    ],
  },
  {
    n: 19,
    topic: "Token counting / tokenizer",
    prompt: "Token counting tokenizer estimateTokens - how tokens are counted",
    grepPattern: "estimateTokens|charsPerToken|codeRatio",
    grepGlob: "**/tokens.ts",
    requiredFiles: ["src/utils/tokens.ts"],
    requiredMarkers: [
      "function estimateTokens",
      "charsPerToken",
      "codeRatio",
    ],
  },
  {
    n: 20,
    topic: "scoreChunks finalScore formula",
    prompt: "scoreChunks finalScore formula - how finalScore is computed in scoreChunks",
    grepPattern: "finalScore|function scoreChunks|layerBoosts",
    grepGlob: "**/scorer.ts",
    requiredFiles: ["src/core/retrieval/scorer.ts"],
    requiredMarkers: [
      "function scoreChunks",
      "let finalScore",
      "layerBoosts",
      "maxGraphBoost",
      "feedbackAdjustments",
    ],
  },
];

function isComplete(accumulated, markers) {
  const missing = markers.filter((m) => !accumulated.includes(m));
  return { ok: missing.length === 0, missing };
}

function scoreFromResult({ exactHit, fullBody, noiseLevel }) {
  // 1–5: exact hit + full body + noise
  let s = 1;
  if (exactHit) s += 2;
  if (fullBody) s += 2;
  if (noiseLevel === "High" && s > 1) s -= 1;
  if (noiseLevel === "Low" && fullBody) s = Math.min(5, s);
  return Math.max(1, Math.min(5, s));
}

function noiseFromExtra(accumulated, requiredFiles) {
  // Heuristic: lots of Autofile / unrelated README → High
  const lower = accumulated.toLowerCase();
  let junk = 0;
  if (lower.includes("autofile")) junk += 2;
  if ((lower.match(/readme\.md/g) || []).length > 2) junk += 1;
  // Many files beyond required
  const fileMentions = new Set(
    [...accumulated.matchAll(/`([a-z0-9_./-]+\.(?:ts|tsx|js|md))`/gi)].map(
      (m) => m[1].toLowerCase(),
    ),
  );
  const requiredBasenames = new Set(
    requiredFiles.map((f) => path.basename(f).toLowerCase()),
  );
  let extra = 0;
  for (const f of fileMentions) {
    if (![...requiredBasenames].some((b) => f.endsWith(b))) extra++;
  }
  if (extra > 6 || junk >= 2) return "High";
  if (extra > 2 || junk >= 1) return "Medium";
  return "Low";
}

function runGrep(pattern, glob) {
  const globArg = glob ? `--glob '${glob}'` : "";
  // Search source + bin (CLI entry), exclude build artifacts
  const cmd = `rg -n --no-heading ${globArg} -e '${pattern.replace(/'/g, "'\\''")}' \
    --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/package/**' \
    "${ROOT}/src" "${ROOT}/bin" "${ROOT}/tests" 2>/dev/null || true`;
  let out = "";
  try {
    out = execSync(cmd, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: ROOT,
    });
  } catch (e) {
    out = e.stdout || "";
  }
  return out;
}

function readFileRel(rel, startLine, endLine) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { text: "", tokens: 0, exists: false };
  const full = fs.readFileSync(abs, "utf8");
  if (startLine != null && endLine != null) {
    const lines = full.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = Math.min(lines.length, endLine);
    const text = lines.slice(start, end).join("\n");
    return {
      text,
      tokens: tok(text),
      exists: true,
      path: rel,
      ranged: true,
      range: `${startLine}-${endLine}`,
    };
  }
  return { text: full, tokens: tok(full), exists: true, path: rel };
}

/** Parse path:line ranges from get_context output (stubs or full-body headers) for a required file. */
function stubRangeForFile(output, rel) {
  const base = path.basename(rel);
  const re = new RegExp(
    String.raw`(?:[\w./-]+/)?${base.replace(/\./g, "\\.")}:(\d+)-(\d+)`,
    "g",
  );
  let best = null;
  let m;
  while ((m = re.exec(output)) !== null) {
    const start = Number(m[1]);
    const end = Number(m[2]);
    if (!best || end - start > best.end - best.start) {
      best = { start, end };
    }
  }
  return best;
}

async function runContextOSFlow(topic) {
  const calls = [];
  const dbs = DB.resolveDatabases(ROOT);
  const chunksRepos = dbs.map((db) => new ChunksRepo(db.getInstance()));
  const relsRepos = dbs.map((db) => new RelationshipsRepo(db.getInstance()));
  const primaryDb = dbs[0];
  const promptsRepo = new PromptsRepo(primaryDb.getInstance());
  const sessionStore = new SessionStore(primaryDb);
  const sessionManager = new SessionManager(promptsRepo, sessionStore);
  const engine = new RetrievalEngine(chunksRepos, relsRepos);

  const result = await engine.retrieve(topic.prompt, {
    maxChunks: 12,
    layers: ["session", "workspace", "repo"],
  });

  const sessionChunks = await sessionManager.getSessionContext();
  const knowledgeStore = new KnowledgeStore(primaryDb);
  const knowledgeFacts = knowledgeStore.searchFacts(topic.prompt, 2);

  const memory = [];
  for (const sc of sessionChunks) {
    memory.push({
      ...sc,
      sourceFile: "session",
      sectionTitle: null,
      sectionDepth: 0,
      summary: null,
      keywords: null,
      hash: contentHash(sc.content),
      tokenCount: tok(sc.content),
      score: sc.importance,
      fileType: "text",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceName: null,
      layer: "session",
    });
  }
  for (const fact of knowledgeFacts) {
    const content = `**[${fact.category.toUpperCase()}]**: ${fact.fact}`;
    memory.push({
      id: fact.id,
      content,
      sourceFile: "memory.fact",
      layer: "global",
      workspaceName: null,
      sectionTitle: "Cross-Session Knowledge Fact",
      sectionDepth: 1,
      summary: null,
      keywords: null,
      hash: contentHash(content),
      tokenCount: tok(content),
      score: fact.confidence * 10,
      fileType: "text",
      importance: Math.round(fact.confidence * 10),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  const capped = memory
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, MEMORY_CHUNK_CAP);
  result.chunks = [...result.chunks, ...capped].sort(
    (a, b) => (b.score || 0) - (a.score || 0),
  );

  const compiled = compile(result, {
    maxTokens: MAX_TOKENS,
    signalTerms: [
      ...(result.intent?.identifiers || []),
      ...(result.intent?.concepts || []),
    ],
  });
  const header = `ContextOS | tokens: ${compiled.tokenCount}/${MAX_TOKENS}\n\n`;
  const output = header + compiled.output;
  const searchTokens = compiled.tokenCount; // matches MCP Diagnostic Header semantics

  calls.push({
    tool: "get_context",
    tokens: searchTokens,
    note: `compiled ${compiled.tokenCount} / ${MAX_TOKENS}`,
  });

  let accumulated = output;
  let { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  const fullBodyFromSearch = ok;

  // Follow-up reads only for required files still missing markers
  const filesRead = [];
  if (!ok) {
    for (const rel of topic.requiredFiles) {
      ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
      if (ok) break;
      const range = stubRangeForFile(output, rel);
      let read = readFileRel(rel, range?.start, range?.end);
      if (!read.exists) continue;
      let fileHasMissing = missing.some((m) => read.text.includes(m));
      if (!fileHasMissing && range) {
        read = readFileRel(rel);
        fileHasMissing = missing.some((m) => read.text.includes(m));
      }
      if (!fileHasMissing && filesRead.length > 0) continue;
      const label = read.ranged ? `${rel}:${read.range}` : rel;
      accumulated += `\n\n----- READ ${label} -----\n` + read.text;
      calls.push({
        tool: read.ranged ? "ctx_read_file" : "Read",
        path: label,
        tokens: read.tokens,
      });
      filesRead.push(label);
    }
  }

  ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));

  const ctxOutLower = output.toLowerCase();
  const exactHit = topic.requiredFiles.some((f) =>
    ctxOutLower.includes(path.basename(f).toLowerCase()),
  ) || topic.requiredMarkers.some((m) => output.includes(m));

  const noiseLevel = noiseFromExtra(output, topic.requiredFiles);
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  const searchScore = scoreFromResult({
    exactHit,
    fullBody: fullBodyFromSearch,
    noiseLevel,
  });

  for (const db of dbs) {
    try {
      db.close();
    } catch {}
  }

  return {
    side: "contextos",
    calls,
    callCount: calls.length,
    searchTokens,
    followUpTokens: totalTokens - searchTokens,
    totalTokens,
    filesRead,
    exactHit,
    fullBodyFromSearch,
    complete: ok,
    missingMarkers: missing,
    noiseLevel,
    searchScore,
    score: ok ? Math.max(searchScore, fullBodyFromSearch ? searchScore : 4) : searchScore,
  };
}

function runBuiltInFlow(topic) {
  const calls = [];
  const grepOut = runGrep(topic.grepPattern, topic.grepGlob);
  const grepTokens = tok(grepOut);
  calls.push({
    tool: "Grep",
    tokens: grepTokens,
    note: `${(grepOut.match(/\n/g) || []).length + (grepOut ? 1 : 0)} lines`,
  });

  // Grep returns matching lines only — never treat as full implementation body.
  // Complete process always Reads every required file (realistic agent workflow).
  const filesRead = [];
  let accumulated = grepOut;
  for (const rel of topic.requiredFiles) {
    const { text, tokens, exists } = readFileRel(rel);
    if (!exists) continue;
    accumulated += `\n\n----- READ ${rel} -----\n` + text;
    calls.push({ tool: "Read", path: rel, tokens });
    filesRead.push(rel);
  }

  const { ok, missing } = isComplete(accumulated, topic.requiredMarkers);

  const exactHit =
    topic.requiredFiles.some((f) => grepOut.includes(path.basename(f))) ||
    topic.requiredMarkers.some((m) => grepOut.includes(m));

  // Full body from search alone: Grep never provides full files
  const fullBodyFromSearch = false;
  const noiseLevel = noiseFromExtra(grepOut, topic.requiredFiles);
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);

  // Accuracy score reflects SEARCH quality (before follow-ups), since E2E both complete
  const searchScore = scoreFromResult({
    exactHit,
    fullBody: fullBodyFromSearch,
    noiseLevel,
  });

  return {
    side: "builtin",
    calls,
    callCount: calls.length,
    searchTokens: grepTokens,
    followUpTokens: totalTokens - grepTokens,
    totalTokens,
    filesRead,
    exactHit,
    fullBodyFromSearch,
    complete: ok,
    missingMarkers: missing,
    noiseLevel,
    searchScore,
    // Final understanding score after full process
    score: ok ? 5 : searchScore,
  };
}

async function main() {
  const results = [];
  console.error(`Running E2E A/B benchmark on ${TOPICS.length} topics…`);

  for (const topic of TOPICS) {
    process.stderr.write(`  #${topic.n} ${topic.topic}… `);
    const ctx = await runContextOSFlow(topic);
    const built = runBuiltInFlow(topic);

    let accuracyWinner = "Tie";
    if (ctx.searchScore !== built.searchScore) {
      accuracyWinner =
        ctx.searchScore > built.searchScore ? "ContextOS" : "Built-in";
    }

    let tokenWinner = "Tie";
    if (ctx.totalTokens < built.totalTokens) tokenWinner = "ContextOS";
    else if (built.totalTokens < ctx.totalTokens) tokenWinner = "Built-in";

    // Overall winner: prefer complete-process efficiency when both complete;
    // break ties with search accuracy.
    let winner = tokenWinner;
    if (tokenWinner === "Tie") winner = accuracyWinner;

    const row = {
      n: topic.n,
      topic: topic.topic,
      prompt: topic.prompt,
      contextos: ctx,
      builtin: built,
      accuracyWinner,
      tokenWinner,
      winner,
      tokenDelta: ctx.totalTokens - built.totalTokens,
      callDelta: ctx.callCount - built.callCount,
    };
    results.push(row);
    process.stderr.write(
      `Ctx ${ctx.totalTokens}t/${ctx.callCount}c search=${ctx.searchScore} body=${ctx.fullBodyFromSearch} | ` +
        `Grep ${built.totalTokens}t/${built.callCount}c search=${built.searchScore} | ` +
        `tokΔ=${row.tokenDelta} acc=${accuracyWinner}\n`,
    );
  }

  const outPath = path.join(ROOT, "scripts/ab-e2e-results.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), maxTokens: MAX_TOKENS, results },
      null,
      2,
    ),
  );
  console.error(`Wrote ${outPath}`);

  const sumCtx = results.reduce((s, r) => s + r.contextos.totalTokens, 0);
  const sumBuilt = results.reduce((s, r) => s + r.builtin.totalTokens, 0);
  const avgCtx = Math.round(sumCtx / results.length);
  const avgBuilt = Math.round(sumBuilt / results.length);
  const tokWinsCtx = results.filter((r) => r.tokenWinner === "ContextOS").length;
  const tokWinsBuilt = results.filter((r) => r.tokenWinner === "Built-in").length;
  const accWinsCtx = results.filter((r) => r.accuracyWinner === "ContextOS").length;
  const accWinsBuilt = results.filter((r) => r.accuracyWinner === "Built-in").length;
  const ctxNoFollowUp = results.filter((r) => r.contextos.callCount === 1).length;

  console.log(
    JSON.stringify(
      {
        summary: {
          avgContextOSTotalTokens: avgCtx,
          avgBuiltInTotalTokens: avgBuilt,
          totalContextOSTokens: sumCtx,
          totalBuiltInTokens: sumBuilt,
          tokenDeltaTotal: sumCtx - sumBuilt,
          tokenWins: { contextos: tokWinsCtx, builtin: tokWinsBuilt },
          accuracyWinsSearchPhase: {
            contextos: accWinsCtx,
            builtin: accWinsBuilt,
            tie: results.length - accWinsCtx - accWinsBuilt,
          },
          avgContextOSSearchScore:
            Math.round(
              (results.reduce((s, r) => s + r.contextos.searchScore, 0) /
                results.length) *
                10,
            ) / 10,
          avgBuiltInSearchScore:
            Math.round(
              (results.reduce((s, r) => s + r.builtin.searchScore, 0) /
                results.length) *
                10,
            ) / 10,
          contextosCompleteInOneCall: ctxNoFollowUp,
          contextosNeededFollowUp: results.length - ctxNoFollowUp,
          contextosFullBodyFromSearch: results.filter(
            (r) => r.contextos.fullBodyFromSearch,
          ).length,
          builtinFullBodyFromSearch: results.filter(
            (r) => r.builtin.fullBodyFromSearch,
          ).length,
          avgContextOSCalls:
            Math.round(
              (results.reduce((s, r) => s + r.contextos.callCount, 0) /
                results.length) *
                10,
            ) / 10,
          avgBuiltInCalls:
            Math.round(
              (results.reduce((s, r) => s + r.builtin.callCount, 0) /
                results.length) *
                10,
            ) / 10,
        },
        results,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
