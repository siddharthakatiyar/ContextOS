#!/usr/bin/env node
/**
 *   Built-in Grep+Read  |  ContextOS get_context  |  Headroom CCR  |  context-mode FTS  |  Vector Only
 *
 * Same topics/markers as scripts/ab-e2e-benchmark.mjs and ab-holdout-benchmark.mjs.
 * Token estimator: ContextOS estimateTokens on every agent-visible tool output.
 *
 * Flows:
 *   builtin:      Grep → Read every required file
 *   contextos:    get_context → Read only until markers complete
 *   headroom:     Grep → headroom_compress(grep) → headroom_read each required file
 *   context-mode: context-mode search(prompt) → Read only until markers complete
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import { createInterface } from "readline";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PYTHON =
  process.env.HEADROOM_PYTHON ||
  "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3";
const CONTEXT_MODE = process.env.CONTEXT_MODE_BIN || "context-mode";
const HELPER = path.join(__dirname, "headroom-bench-helper.py");

const { DB } = await import(path.join(ROOT, "dist/src/core/storage/database.js"));
const { ChunksRepo } = await import(
  path.join(ROOT, "dist/src/core/storage/chunks-repo.js")
);
const { RelationshipsRepo } = await import(
  path.join(ROOT, "dist/src/core/storage/relationships-repo.js")
);
const { PromptsRepo } = await import(
  path.join(ROOT, "dist/src/core/storage/prompts-repo.js")
);
const { SessionStore } = await import(
  path.join(ROOT, "dist/src/core/session/session-store.js")
);
const { SessionManager } = await import(
  path.join(ROOT, "dist/src/core/session/index.js")
);
const { RetrievalEngine } = await import(
  path.join(ROOT, "dist/src/core/retrieval/index.js")
);
const { compile } = await import(path.join(ROOT, "dist/src/core/compiler/index.js"));
const { KnowledgeStore } = await import(
  path.join(ROOT, "dist/src/core/memory/knowledge-store.js")
);
const { estimateTokens } = await import(path.join(ROOT, "dist/src/utils/tokens.js"));

const MAX_TOKENS = 1200;
const MEMORY_CHUNK_CAP = 3;
const SIDES = ["builtin", "contextos", "headroom", "contextmode", "vectoronly"];
function tok(text) {
  return estimateTokens(text || "");
}

function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Extract TOPICS array literal from an existing ab-*.mjs harness. */
function loadTopicsFrom(scriptPath) {
  const code = fs.readFileSync(scriptPath, "utf8");
  const start = code.indexOf("const TOPICS = [");
  if (start < 0) throw new Error(`TOPICS not found in ${scriptPath}`);
  const after = code.slice(start + "const TOPICS = ".length);
  const endMark = after.indexOf("\n];\n\nfunction isComplete");
  if (endMark < 0) throw new Error(`TOPICS end not found in ${scriptPath}`);
  const literal = after.slice(0, endMark + 2); // include ]
  // Controlled local fixture — not user input
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal});`)();
}

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
    [...accumulated.matchAll(/`([a-z0-9_./-]+\.(?:ts|tsx|js|md))`/gi)].map((m) =>
      m[1].toLowerCase(),
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

function finalizeSide(side, calls, searchTokens, searchText, topic, extras = {}) {
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  const { ok, missing } = isComplete(
    extras.accumulated ?? searchText,
    topic.requiredMarkers,
  );
  const fullBodyFromSearch = extras.fullBodyFromSearch ?? false;
  const exactHit =
    extras.exactHit ??
    (topic.requiredFiles.some((f) => searchText.includes(path.basename(f))) ||
      topic.requiredMarkers.some((m) => searchText.includes(m)));
  const noiseLevel = noiseFromExtra(searchText, topic.requiredFiles);
  const searchScore = scoreFromResult({
    exactHit,
    fullBody: fullBodyFromSearch,
    noiseLevel,
  });
  return {
    side,
    calls,
    callCount: calls.length,
    searchTokens,
    followUpTokens: totalTokens - searchTokens,
    totalTokens,
    filesRead: extras.filesRead || [],
    exactHit,
    fullBodyFromSearch,
    complete: ok,
    missingMarkers: missing,
    noiseLevel,
    searchScore,
    score: ok
      ? Math.max(searchScore, fullBodyFromSearch ? searchScore : 4)
      : searchScore,
    ...extras.meta,
  };
}

/* ---------- Headroom JSONL bridge ---------- */
class HeadroomBridge {
  constructor() {
    this.proc = spawn(PYTHON, [HELPER], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, HEADROOM_MCP_READ: "on" },
    });
    this.rl = createInterface({ input: this.proc.stdout });
    this.queue = [];
    this.rl.on("line", (line) => {
      const waiter = this.queue.shift();
      if (!waiter) return;
      try {
        waiter.resolve(JSON.parse(line));
      } catch (e) {
        waiter.reject(e);
      }
    });
    this.proc.on("exit", (code) => {
      for (const w of this.queue) w.reject(new Error(`helper exited ${code}`));
      this.queue = [];
    });
  }

  request(payload) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  async compress(content) {
    return this.request({ op: "compress", content });
  }

  async read(filePath, fresh = false) {
    return this.request({ op: "read", file_path: filePath, fresh });
  }

  close() {
    try {
      this.proc.stdin.end();
    } catch {}
    try {
      this.proc.kill();
    } catch {}
  }
}

function runContextModeSearch(query, limit = 8) {
  const cmd = `${CONTEXT_MODE} search ${JSON.stringify(query)} --project ${JSON.stringify(ROOT)} --limit ${limit}`;
  try {
    return execSync(cmd, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: ROOT,
      env: {
        ...process.env,
        CONTEXT_MODE_DIR: path.join(ROOT, ".github/context-mode"),
      },
    });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
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

  for (const db of dbs) {
    try {
      db.close();
    } catch {}
  }

  return finalizeSide("contextos", calls, searchTokens, output, topic, {
    accumulated,
    fullBodyFromSearch,
    filesRead,
  });
}

async function runVectorOnlyFlow(topic) {
  const calls = [];
  const dbs = DB.resolveDatabases(ROOT);
  const chunksRepos = dbs.map((db) => new ChunksRepo(db.getInstance()));
  const relsRepos = dbs.map((db) => new RelationshipsRepo(db.getInstance()));
  const primaryDb = dbs[0];
  const promptsRepo = new PromptsRepo(primaryDb.getInstance());
  const sessionStore = new SessionStore(primaryDb);
  const sessionManager = new SessionManager(promptsRepo, sessionStore);
  const engine = new RetrievalEngine(chunksRepos, relsRepos);

  // MOCK: Disable FTS keyword matching to isolate Vector Embeddings
  engine.matcher.matchChunks = () => [];
  // MOCK: Disable Graph Expansion to isolate Vector Embeddings
  engine.expander.expand = () => [];

  // Enable Embeddings
  process.env.CONTEXTOS_EMBEDDINGS_RETRIEVAL = '1';

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
  const header = `VectorSearch | tokens: ${compiled.tokenCount}/${MAX_TOKENS}\n\n`;
  const output = header + compiled.output;
  const searchTokens = compiled.tokenCount;

  calls.push({
    tool: "vector_search",
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

  for (const db of dbs) {
    try {
      db.close();
    } catch {}
  }

  return finalizeSide("vectoronly", calls, searchTokens, output, topic, {
    accumulated,
    fullBodyFromSearch,
    filesRead,
  });
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

  return finalizeSide("builtin", calls, grepTokens, grepOut, topic, {
    accumulated,
    fullBodyFromSearch: false,
    filesRead,
  });
}

async function runHeadroomFlow(topic, bridge) {
  const calls = [];
  const grepOut = runGrep(topic.grepPattern, topic.grepGlob);
  const compressed = await bridge.compress(grepOut || "(empty)");
  if (!compressed.ok) {
    throw new Error(`headroom compress failed: ${compressed.error}`);
  }
  const toolText = compressed.tool_text || "";
  const searchTokens = tok(toolText);
  calls.push({
    tool: "Grep+headroom_compress",
    tokens: searchTokens,
    note: `saved=${compressed.tokens_saved} transforms=${(compressed.transforms || []).join(",")}`,
  });

  const compressedBody =
    typeof compressed.compressed === "string"
      ? compressed.compressed
      : JSON.stringify(compressed.compressed);
  let accumulated = compressedBody;
  // Grep/compress never equals full implementation body (same rule as built-in).
  const fullBodyFromSearch = false;

  const filesRead = [];
  // Per-query isolation: fresh=true so cross-topic CCR cache hits don't
  // under-count tokens (session CCR savings are a separate claim).
  for (const rel of topic.requiredFiles) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const read = await bridge.read(abs, true);
    if (!read.ok) continue;
    const text = read.tool_text || "";
    const tokens = tok(text);
    accumulated += `\n\n----- HEADROOM_READ ${rel} -----\n` + text;
    calls.push({ tool: "headroom_read", path: rel, tokens });
    filesRead.push(rel);
  }

  return finalizeSide("headroom", calls, searchTokens, compressedBody, topic, {
    accumulated,
    fullBodyFromSearch,
    filesRead,
    meta: {
      headroomSavingsPct: compressed.savings_percent,
      headroomTransforms: compressed.transforms,
    },
  });
}

function runContextModeFlow(topic) {
  const calls = [];
  const searchOut = runContextModeSearch(topic.prompt, 8);
  const searchTokens = tok(searchOut);
  calls.push({
    tool: "ctx_search",
    tokens: searchTokens,
    note: `${(searchOut.match(/^## /gm) || []).length} hits`,
  });

  let accumulated = searchOut;
  let { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  const fullBodyFromSearch = ok;
  const filesRead = [];

  if (!ok) {
    for (const rel of topic.requiredFiles) {
      ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
      if (ok) break;
      const read = readFileRel(rel);
      if (!read.exists) continue;
      const fileHasMissing = missing.some((m) => read.text.includes(m));
      if (!fileHasMissing && filesRead.length > 0) continue;
      accumulated += `\n\n----- READ ${rel} -----\n` + read.text;
      calls.push({ tool: "Read", path: rel, tokens: read.tokens });
      filesRead.push(rel);
    }
  }

  return finalizeSide("contextmode", calls, searchTokens, searchOut, topic, {
    accumulated,
    fullBodyFromSearch,
    filesRead,
  });
}

function summarizeSuite(name, results) {
  const bySide = {};
  for (const side of SIDES) {
    const rows = results.map((r) => r[side]);
    const n = rows.length;
    const sumTok = rows.reduce((s, r) => s + r.totalTokens, 0);
    const sumSearch = rows.reduce((s, r) => s + r.searchTokens, 0);
    const fullBody = rows.filter((r) => r.fullBodyFromSearch).length;
    const complete = rows.filter((r) => r.complete).length;
    const oneCall = rows.filter((r) => r.callCount === 1).length;
    const hits = rows.filter((r) => r.fullBodyFromSearch);
    const misses = rows.filter((r) => !r.fullBodyFromSearch);
    bySide[side] = {
      n,
      complete,
      fullBodyFromSearch: fullBody,
      oneCall,
      avgTotalTokens: Math.round(sumTok / n),
      totalTokens: sumTok,
      avgSearchTokens: Math.round(sumSearch / n),
      avgSearchScore:
        Math.round((rows.reduce((s, r) => s + r.searchScore, 0) / n) * 10) / 10,
      avgCalls:
        Math.round((rows.reduce((s, r) => s + r.callCount, 0) / n) * 10) / 10,
      hitAvgTokens: hits.length
        ? Math.round(hits.reduce((s, r) => s + r.totalTokens, 0) / hits.length)
        : null,
      missAvgTokens: misses.length
        ? Math.round(
            misses.reduce((s, r) => s + r.totalTokens, 0) / misses.length,
          )
        : null,
    };
  }

  // Per-topic token winner among all sides
  let wins = Object.fromEntries(SIDES.map((s) => [s, 0]));
  let ties = 0;
  for (const r of results) {
    const totals = SIDES.map((s) => ({ s, t: r[s].totalTokens }));
    totals.sort((a, b) => a.t - b.t);
    if (totals[0].t === totals[1].t) ties++;
    else wins[totals[0].s]++;
  }

  return { suite: name, bySide, tokenWins: wins, tokenTies: ties };
}

async function runSuite(name, topics, bridge) {
  console.error(`\n=== ${name} (${topics.length} topics) ===`);
  const results = [];
  for (const topic of topics) {
    process.stderr.write(`  #${topic.n} ${topic.topic.slice(0, 48)}… `);
    const builtin = runBuiltInFlow(topic);
    const contextos = await runContextOSFlow(topic);
    const headroom = await runHeadroomFlow(topic, bridge);
    const contextmode = runContextModeFlow(topic);
    const vectoronly = await runVectorOnlyFlow(topic);

    const totals = {
      builtin: builtin.totalTokens,
      contextos: contextos.totalTokens,
      headroom: headroom.totalTokens,
      contextmode: contextmode.totalTokens,
      vectoronly: vectoronly.totalTokens,
    };
    const sorted = Object.entries(totals).sort((a, b) => a[1] - b[1]);
    const tokenWinner =
      sorted[0][1] === sorted[1][1] ? "Tie" : sorted[0][0];

    const bodies = {
      builtin: builtin.fullBodyFromSearch,
      contextos: contextos.fullBodyFromSearch,
      headroom: headroom.fullBodyFromSearch,
      contextmode: contextmode.fullBodyFromSearch,
      vectoronly: vectoronly.fullBodyFromSearch,
    };

    results.push({
      n: topic.n,
      topic: topic.topic,
      prompt: topic.prompt,
      builtin,
      contextos,
      headroom,
      contextmode,
      vectoronly,
      totals,
      tokenWinner,
      bodies,
    });

    process.stderr.write(
      `B${builtin.totalTokens} C${contextos.totalTokens} H${headroom.totalTokens} M${contextmode.totalTokens} V${vectoronly.totalTokens} ` +
        `body=${["B", "C", "H", "M", "V"]
          .map((k, i) => (Object.values(bodies)[i] ? k : "-"))
          .join("")} win=${tokenWinner}\n`,
    );
  }
  return { results, summary: summarizeSuite(name, results) };
}

async function main() {
  const suiteArg = process.argv[2] || "all"; // e2e | holdout | all
  const e2eTopics = loadTopicsFrom(path.join(__dirname, "ab-e2e-benchmark.mjs"));
  const holdTopics = loadTopicsFrom(
    path.join(__dirname, "ab-holdout-benchmark.mjs"),
  );

  const bridge = new HeadroomBridge();
  const out = {
    generatedAt: new Date().toISOString(),
    maxTokens: MAX_TOKENS,
    notes: {
      tokenEstimator: "ContextOS estimateTokens on agent-visible tool outputs",
      builtin: "Grep → Read all required files",
      contextos: "get_context → conditional Read until markers complete",
      headroom:
        "Grep → headroom_compress → headroom_read each required file (HEADROOM_MCP_READ=on); code often 0% compress (router:protected:recent_code)",
      contextmode:
        "context-mode search (FTS5) → conditional Read until markers complete",
      vectoronly:
        "ContextOS embeddings (FTS and Graph Expansion disabled) → conditional Read",
    },
    suites: {},
  };

  try {
    if (suiteArg === "all" || suiteArg === "e2e") {
      const e2e = await runSuite("e2e", e2eTopics, bridge);
      out.suites.e2e = e2e;
    }
    if (suiteArg === "all" || suiteArg === "holdout") {
      const hold = await runSuite("holdout", holdTopics, bridge);
      out.suites.holdout = hold;
    }
  } finally {
    bridge.close();
  }

  const outPath = path.join(ROOT, "scripts/ab-4way-results.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`\nWrote ${outPath}`);
  console.log(JSON.stringify({ summaries: Object.fromEntries(
    Object.entries(out.suites).map(([k, v]) => [k, v.summary]),
  ) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
