#!/usr/bin/env node
/**
 * Held-out real-life A/B benchmark — NEVER used for tuning.
 * Written before 0.6.0 code changes; markers locked at creation time.
 *
 * Natural phrasing: contractions, sentence-initial capitals, bug-fix
 * scenarios, multi-file features, config questions.
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

function tok(text) {
  return estimateTokens(text || "");
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/**
 * 15 held-out real-life queries. Markers locked before any 0.6.0 changes.
 * Do NOT retune code against these — only use for final A/B retest.
 */
const TOPICS = [
  {
    n: 1,
    topic: "What's wrong with FTS query sanitization?",
    prompt:
      "What's wrong with how FTS queries get sanitized? I'm seeing OR operators disappear from search.",
    grepPattern: "sanitizeFTSQuery|AND\\|OR\\|NOT",
    grepGlob: "**/fts-sanitizer.ts",
    requiredFiles: ["src/core/storage/fts-sanitizer.ts"],
    requiredMarkers: [
      "function sanitizeFTSQuery",
      "AND|OR|NOT"
    ],
  },
  {
    n: 2,
    topic: "How does the daemon handle MCP over sockets?",
    prompt:
      "How does the ContextOS daemon accept MCP client connections over a Unix socket?",
    grepPattern: "ContextOSDaemon|handleConnection|socketPath",
    grepGlob: "**/daemon/daemon.ts",
    requiredFiles: ["src/core/daemon/daemon.ts"],
    requiredMarkers: [
      "ContextOSDaemon",
      "handleConnection",
      "StdioServerTransport",
      "socketPath",
    ],
  },
  {
    n: 3,
    topic: "Where's the PID lock for the MCP server?",
    prompt:
      "Where's the PID lockfile logic that prevents two MCP servers from running on the same project?",
    grepPattern: "acquireServerLock|releaseServerLock|server.pid",
    grepGlob: "**/database.ts",
    requiredFiles: ["src/core/storage/database.ts"],
    requiredMarkers: [
      "function acquireServerLock",
      "server.pid",
      "process.kill",
      "releaseServerLock",
    ],
  },
  {
    n: 4,
    topic: "Bug: feedback doesn't stick after reindex",
    prompt:
      "Bug: I rated a chunk useful but after reindex the feedback seems gone. How does rate_chunk / FeedbackTracker work?",
    grepPattern: "recordFeedback|FeedbackTracker|feedback_signals",
    grepGlob: "**/{feedback,tracker}.{ts,tsx}",
    requiredFiles: [
      "src/core/feedback/tracker.ts",
      "src/mcp/tools/feedback.ts",
    ],
    requiredMarkers: [
      "recordFeedback",
      "feedback_signals",
      "score_adjustment",
      "rate_chunk",
    ],
  },
  {
    n: 5,
    topic: "How are config files (JSON/YAML) indexed?",
    prompt:
      "How are JSON and YAML config files parsed into symbols for indexing?",
    grepPattern: "parseConfig|jsonKeyRegex|yamlKeyRegex",
    grepGlob: "**/config-parser.ts",
    requiredFiles: ["src/core/parser/config-parser.ts"],
    requiredMarkers: [
      "function parseConfig",
      "jsonKeyRegex",
      "yamlKeyRegex",
      "kind: 'variable'",
    ],
  },
  {
    n: 6,
    topic: "Explain importance scoring for files",
    prompt:
      "Explain how file importance scores are assigned — what's boosted vs demoted?",
    grepPattern: "scoreFileImportance|readme.md|node_modules",
    grepGlob: "**/importance-scorer.ts",
    requiredFiles: ["src/core/indexer/importance-scorer.ts"],
    requiredMarkers: [
      "function scoreFileImportance",
      "readme.md",
      "node_modules",
      "Math.max(1, Math.min(10",
    ],
  },
  {
    n: 7,
    topic: "Can't find how learn_fact stores knowledge",
    prompt:
      "Can't find how learn_fact / KnowledgeStore.learnFact persists facts and handles duplicates.",
    grepPattern: "learnFact|knowledge_facts|Reinforce existing",
    grepGlob: "**/knowledge-store.ts",
    requiredFiles: ["src/core/memory/knowledge-store.ts"],
    requiredMarkers: [
      "learnFact",
      "Reinforce existing fact",
      "INSERT INTO knowledge_facts",
      "confidence = MIN(confidence + 0.1",
    ],
  },
  {
    n: 8,
    topic: "Shell execute allowlist — is find safe?",
    prompt:
      "Is the ctx_execute shell tool's allowlist safe? Does it allow find with -exec?",
    grepPattern: "allowedCommands|find|execFileAsync",
    grepGlob: "**/execute.ts",
    requiredFiles: ["src/mcp/tools/execute.ts"],
    requiredMarkers: [
      "allowedCommands",
      "execFileAsync",
      "Directory traversal",
      "Absolute paths are not allowed",
    ],
  },
  {
    n: 9,
    topic: "How does save_context attach notes to a session?",
    prompt:
      "How does save_context attach notes to the current session memory?",
    grepPattern: "save_context|registerSaveContextTool|system_response",
    grepGlob: "**/save-context.ts",
    requiredFiles: ["src/mcp/tools/save-context.ts"],
    requiredMarkers: [
      "registerSaveContextTool",
      "save_context",
      "system_response",
      "addEvent",
    ],
  },
  {
    n: 10,
    topic: "DB resolveDatabases — local vs global",
    prompt:
      "How does resolveDatabases pick the local project DB versus the global ~/.contextos index?",
    grepPattern: "resolveDatabases|globalDbPath|getContextOSHome",
    grepGlob: "**/database.ts",
    requiredFiles: ["src/core/storage/database.ts"],
    requiredMarkers: [
      "resolveDatabases",
      "getContextOSHome",
      "index.db",
      "globalDbPath",
    ],
  },
  {
    n: 11,
    topic: "Junk symbol filtering in the code chunker",
    prompt:
      "What's the junk-symbol filter in the code chunker — when are tiny functions skipped?",
    grepPattern: "isJunkSymbol|estimateTokens|lines.length < 3",
    grepGlob: "**/code-chunker.ts",
    requiredFiles: ["src/core/chunker/code-chunker.ts"],
    requiredMarkers: [
      "function isJunkSymbol",
      "lines.length < 3",
      "estimateTokens(symbol.body) < 30",
    ],
  },
  {
    n: 12,
    topic: "Template literal consts for SQL DDL indexing",
    prompt:
      "How do large template-literal constants (like SQL DDL) get indexed as symbols?",
    grepPattern: "extractTopLevelStringConsts|template_string|body.length < 200",
    grepGlob: "**/code-parser.ts",
    requiredFiles: ["src/core/parser/code-parser.ts"],
    requiredMarkers: [
      "extractTopLevelStringConsts",
      "template_string",
      "body.length < 200",
      "kind: 'variable'",
    ],
  },
  {
    n: 13,
    topic: "Foreign workspace penalty in scoring",
    prompt:
      "How does scoring penalize chunks from a foreign workspace when multiple DBs are open?",
    grepPattern: "workspaceName|isLocal|finalScore \\*= 0.3",
    grepGlob: "**/scorer.ts",
    requiredFiles: ["src/core/retrieval/scorer.ts"],
    requiredMarkers: [
      "workspaceName",
      "isLocal",
      "finalScore *= 0.3",
    ],
  },
  {
    n: 14,
    topic: "Containment dedup of class vs methods",
    prompt:
      "Explain containment dedup — when a class chunk and its method chunks both match, which wins?",
    grepPattern: "containmentDedup|parentSymbol|childMethods",
    grepGlob: "**/retrieval/index.ts",
    requiredFiles: ["src/core/retrieval/index.ts"],
    requiredMarkers: [
      "function containmentDedup",
      "parentSymbol",
      "childMethods",
      "parentTokens > 500",
    ],
  },
  {
    n: 15,
    topic: "Tiered compressChunks full bodies vs stubs",
    prompt:
      "How does compressChunks decide which chunks get full bodies versus signature stubs?",
    grepPattern: "compressChunks|toStub|truncatePreservingSignals",
    grepGlob: "**/compressor.ts",
    requiredFiles: ["src/core/compiler/compressor.ts"],
    requiredMarkers: [
      "compressChunks",
      "toStub",
      "truncatePreservingSignals",
      "framingReserve",
    ],
  },
];

function isComplete(accumulated, markers) {
  const missing = markers.filter((m) => !accumulated.includes(m));
  return { ok: missing.length === 0, missing };
}

function scoreFromResult({ exactHit, fullBody, noiseLevel }) {
  let s = 1;
  if (exactHit) s += 2;
  if (fullBody) s += 2;
  if (noiseLevel === "High" && s > 1) s -= 1;
  if (noiseLevel === "Low" && fullBody) s = Math.min(5, s);
  return Math.max(1, Math.min(5, s));
}

function noiseFromExtra(accumulated, requiredFiles) {
  const lower = accumulated.toLowerCase();
  let junk = 0;
  if (lower.includes("autofile")) junk += 2;
  if ((lower.match(/readme\.md/g) || []).length > 2) junk += 1;
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
  const searchTokens = compiled.tokenCount;

  calls.push({
    tool: "get_context",
    tokens: searchTokens,
    note: `compiled ${compiled.tokenCount} / ${MAX_TOKENS}`,
  });

  let accumulated = output;
  let { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  const fullBodyFromSearch = ok;

  const filesRead = [];
  if (!ok) {
    for (const rel of topic.requiredFiles) {
      ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
      if (ok) break;
      // Prefer ranged read from stub line ranges (0.6.1 agent guidance)
      const range = stubRangeForFile(output, rel);
      let read = readFileRel(rel, range?.start, range?.end);
      if (!read.exists) continue;
      let fileHasMissing = missing.some((m) => read.text.includes(m));
      // If ranged miss, fall back to whole file
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
  const exactHit =
    topic.requiredFiles.some((f) =>
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
  const fullBodyFromSearch = false;
  const noiseLevel = noiseFromExtra(grepOut, topic.requiredFiles);
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
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
    score: ok ? 5 : searchScore,
  };
}

async function main() {
  const results = [];
  console.error(`Running HOLDOUT A/B benchmark on ${TOPICS.length} topics…`);

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

  const outPath = path.join(ROOT, "scripts/ab-holdout-results.json");
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), maxTokens: MAX_TOKENS, suite: "holdout", results },
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
          suite: "holdout",
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
