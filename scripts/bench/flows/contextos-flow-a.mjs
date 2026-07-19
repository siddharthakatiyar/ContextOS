#!/usr/bin/env node
/**
 * Fair multi-track benchmark — each tool used as designed.
 *
 * Topics: scripts/ab-topics.mjs (verified against live codebase)
 *   Track A-specific — user names file/function
 *   Track A-generic  — same answers, vague natural-language prompts
 *
 * Flows:
 *   Built-in:      Grep → ranged Read around hits → full file only if needed
 *   ContextOS:     get_context → conditional Read until markers complete
 *   Headroom:      Grep → headroom_compress → headroom_read (full file; CCR)
 *   context-mode:  FTS search → ctx_execute_file-style extract (stdout only)
 *
 * Track B — Session continuity (overlapping files, Headroom cache ON)
 * Track C — Think-in-code aggregation (context-mode native)
 * Track D — Compression by content type (Headroom native)
 *
 * Tokens: ContextOS estimateTokens on agent-visible outputs only.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import {
  SPECIFIC_TOPICS,
  GENERIC_TOPICS,
  TOPIC_DEFS,
  SESSION_TOPIC_IDS,
} from "../topics/contextos.mjs";
import { checkOracle, isComplete } from "../lib/oracle.mjs";

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
const RANGE_PAD = 40;

function tok(text) {
  return estimateTokens(text || "");
}
function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}



function runGrep(pattern, glob) {
  const globArg = glob ? `--glob '${glob}'` : "";
  const cmd = `rg -n --no-heading ${globArg} -e '${pattern.replace(/'/g, "'\\''")}' \
    --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/package/**' \
    "${ROOT}/src" "${ROOT}/bin" "${ROOT}/tests" 2>/dev/null || true`;
  try {
    return execSync(cmd, {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      cwd: ROOT,
    });
  } catch (e) {
    return e.stdout || "";
  }
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
      lineCount: lines.length,
    };
  }
  return {
    text: full,
    tokens: tok(full),
    exists: true,
    path: rel,
    lineCount: full.split("\n").length,
  };
}

/** Line numbers in a file that appear in grep output. */
function grepHitLines(grepOut, rel) {
  const base = path.basename(rel);
  const lines = [];
  for (const row of grepOut.split("\n")) {
    if (!row.includes(base) && !row.includes(rel)) continue;
    const m = row.match(/:(\d+):/);
    if (m) lines.push(Number(m[1]));
  }
  return [...new Set(lines)].sort((a, b) => a - b);
}

function mergeRanges(lineNums, pad, maxLine) {
  if (!lineNums.length) return [];
  const ranges = [];
  for (const ln of lineNums) {
    const start = Math.max(1, ln - pad);
    const end = Math.min(maxLine, ln + pad);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 2) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  return ranges;
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
    if (!best || end - start > best.end - best.start) best = { start, end };
  }
  return best;
}

function runContextModeSearch(query, limit = 5) {
  const cmd = `${CONTEXT_MODE} search ${JSON.stringify(query)} --project ${JSON.stringify(ROOT)} --limit ${limit} --type code`;
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

/**
 * ctx_execute_file contract: only stdout enters context.
 * Extract windows around missing markers from a file.
 */
function sandboxExtract(rel, markers, pad = 20) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return { text: "", tokens: 0, exists: false };
  const full = fs.readFileSync(abs, "utf8");
  const lines = full.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (markers.some((m) => lines[i].includes(m))) {
      const start = Math.max(0, i - pad);
      const end = Math.min(lines.length, i + pad + 15);
      hits.push({ start, end });
      i = end;
    }
  }
  const merged = [];
  for (const h of hits) {
    const last = merged[merged.length - 1];
    if (last && h.start <= last.end + 2) last.end = Math.max(last.end, h.end);
    else merged.push({ ...h });
  }
  // If markers exist but not as line substrings (multiline), fall back to
  // including whole file in sandbox output only when necessary — still rare.
  let text = merged
    .map((h) => {
      const slice = lines.slice(h.start, h.end).join("\n");
      return `// ${rel}:${h.start + 1}-${h.end}\n${slice}`;
    })
    .join("\n\n");
  const stillMissing = markers.filter((m) => !full.includes(m));
  const present = markers.filter((m) => full.includes(m));
  if (present.some((m) => !text.includes(m))) {
    // Marker in file but outside windows (e.g. far from siblings) — widen:
    // dump every line containing any present marker with larger pad
    text = "";
    for (let i = 0; i < lines.length; i++) {
      if (present.some((m) => lines[i].includes(m))) {
        const a = Math.max(0, i - pad * 2);
        const b = Math.min(lines.length, i + pad * 3);
        text += `// ${rel}:${a + 1}-${b}\n` + lines.slice(a, b).join("\n") + "\n\n";
        i = b;
      }
    }
  }
  // Last resort for markers that span oddly: include full file in stdout
  // (honest: sandbox can print anything; agent asked for full body)
  if (present.some((m) => !text.includes(m))) {
    text = full;
  }
  return {
    text,
    tokens: tok(text),
    exists: true,
    stillMissingInFile: stillMissing,
    fullTokens: tok(full),
  };
}

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
  compress(content) {
    return this.request({ op: "compress", content });
  }
  read(filePath, fresh = false) {
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

async function runContextOSFlow(topic) {
  const calls = [];
  const dbs = DB.resolveDatabases(ROOT);
  const chunksRepos = dbs.map((db) => new ChunksRepo(db.getInstance()));
  const relsRepos = dbs.map((db) => new RelationshipsRepo(db.getInstance()));
  const primaryDb = dbs[0];
  const sessionManager = new SessionManager(
    new PromptsRepo(primaryDb.getInstance()),
    new SessionStore(primaryDb),
  );
  const engine = new RetrievalEngine(chunksRepos, relsRepos);
  const result = await engine.retrieve(topic.prompt, {
    maxChunks: 25,
    layers: ["session", "workspace", "repo"],
  });
  const sessionChunks = await sessionManager.getSessionContext();
  const knowledgeFacts = new KnowledgeStore(primaryDb).searchFacts(topic.prompt, 2);
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
  const output = compiled.output;
  const searchTokens = tok(output);
  calls.push({ tool: "get_context", tokens: searchTokens });

  let accumulated = output;
  const oneShot = isComplete(accumulated, topic.requiredMarkers).ok;
  const filesRead = [];
  
  // Extract all stubs from output
  // e.g. "src/mcp/tools/get-context-core.ts:40-80"
  // Assuming stubRangeForFile is still used, or we just parse all ranges from output.
  const allStubs = [];
  const re = /(?:[\w./-]+/)?([\w.-]+(?:ts|js|tsx|jsx|json|md|py))(?::(\d+)-(\d+))?/g;
  let mMatch;
  while ((mMatch = re.exec(output)) !== null) {
    const fileBase = mMatch[1];
    const start = mMatch[2] ? Number(mMatch[2]) : null;
    const end = mMatch[3] ? Number(mMatch[3]) : null;
    
    // Find matching relative path from requiredFiles just for testing simulation
    const rel = topic.requiredFiles.find(f => path.basename(f) === fileBase) || fileBase;
    
    if (start && end) {
      allStubs.push({ rel, start, end });
    }
  }

  // 1. Stub-range parse -> read
  for (const stub of allStubs) {
    if (filesRead.includes(stub.rel)) continue;
    const read = readFileRel(stub.rel, stub.start, stub.end);
    if (!read.exists) continue;
    const label = `${stub.rel}:${read.range}`;
    accumulated += `\n\n----- READ ${label} -----\n` + read.text;
    calls.push({ tool: "ctx_read_file", tokens: read.tokens, path: label });
    filesRead.push(stub.rel);
  }

  // 2. Oracle-free: we do NOT fall back to reading requiredFiles.
  // If the agent didn't figure out what to read from the stubs, it fails.

  const { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  for (const db of dbs) {
    try {
      db.close();
    } catch {}
  }
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  const resultObj = {
    side: "contextos",
    totalTokens,
    searchTokens,
    followUpTokens: totalTokens - searchTokens,
    callCount: calls.length,
    oneShot,
    complete: ok,
    missingMarkers: missing,
    filesRead,
    calls,
  };
  return checkOracle(resultObj, false); // false = oracle-free
}

function runBuiltInFair(topic) {
  const calls = [];
  const grepOut = runGrep(topic.grepPattern, topic.grepGlob);
  const grepTokens = tok(grepOut);
  calls.push({ tool: "Grep", tokens: grepTokens });

  let accumulated = grepOut;
  const filesRead = [];
  let { ok, missing } = isComplete(accumulated, topic.requiredMarkers);

  for (const rel of topic.requiredFiles) {
    ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
    if (ok) break;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const lineCount = fs.readFileSync(abs, "utf8").split("\n").length;
    const hits = grepHitLines(grepOut, rel);
    const ranges = hits.length
      ? mergeRanges(hits, RANGE_PAD, lineCount)
      : [{ start: 1, end: lineCount }];

    let fileText = "";
    let fileTok = 0;
    for (const r of ranges) {
      const read = readFileRel(rel, r.start, r.end);
      fileText += read.text + "\n";
      fileTok += read.tokens;
    }
    accumulated += `\n\n----- READ ${rel} (ranged) -----\n` + fileText;
    calls.push({
      tool: "Read",
      path: rel,
      tokens: fileTok,
      note: hits.length ? `ranged ${ranges.length} windows` : "full (no grep hits)",
    });
    filesRead.push(rel);

    ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
    if (!ok && missing.some((m) => fs.readFileSync(abs, "utf8").includes(m))) {
      // Escalate to full file
      const full = readFileRel(rel);
      accumulated += `\n\n----- READ ${rel} (full) -----\n` + full.text;
      calls.push({ tool: "Read", path: rel, tokens: full.tokens, note: "escalated full" });
    }
  }

  ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  return {
    side: "builtin",
    totalTokens,
    searchTokens: grepTokens,
    followUpTokens: totalTokens - grepTokens,
    callCount: calls.length,
    oneShot: false,
    complete: ok,
    missingMarkers: missing,
    filesRead,
    calls,
  };
}

async function runHeadroomFair(topic, bridge, { freshReads = true } = {}) {
  const calls = [];
  const grepOut = runGrep(topic.grepPattern, topic.grepGlob);
  const compressed = await bridge.compress(grepOut || "(empty)");
  if (!compressed.ok) throw new Error(compressed.error);
  const toolText = compressed.tool_text || "";
  const searchTokens = tok(toolText);
  calls.push({
    tool: "Grep+headroom_compress",
    tokens: searchTokens,
    note: `savings%=${compressed.savings_percent} transforms=${(compressed.transforms || []).join(",")}`,
  });

  let accumulated =
    typeof compressed.compressed === "string"
      ? compressed.compressed
      : JSON.stringify(compressed.compressed);
  const filesRead = [];

  for (const rel of topic.requiredFiles) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const read = await bridge.read(abs, freshReads);
    if (!read.ok) continue;
    const text = read.tool_text || "";
    const tokens = tok(text);
    accumulated += `\n\n----- HEADROOM_READ ${rel} -----\n` + text;
    calls.push({
      tool: "headroom_read",
      path: rel,
      tokens,
      note: text.includes('"status": "cached"') ? "cache_hit" : "full",
    });
    filesRead.push(rel);
  }

  const { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  return {
    side: "headroom",
    totalTokens,
    searchTokens,
    followUpTokens: totalTokens - searchTokens,
    callCount: calls.length,
    oneShot: false,
    complete: ok,
    missingMarkers: missing,
    filesRead,
    calls,
    savingsPercent: compressed.savings_percent,
    transforms: compressed.transforms,
  };
}

function filesCitedInSearch(searchOut, candidates) {
  const lower = searchOut.toLowerCase();
  const cited = candidates.filter((rel) => {
    const base = path.basename(rel).toLowerCase();
    return lower.includes(base) || lower.includes(rel.toLowerCase());
  });
  // Prefer search-cited files; if none, fall back to ground-truth list
  // (agent would open Grep/search hits — same assumption as Built-in requiredFiles).
  return cited.length ? cited : candidates;
}

function runContextModeFair(topic) {
  const calls = [];
  const searchOut = runContextModeSearch(topic.prompt, 5);
  const searchTokens = tok(searchOut);
  calls.push({ tool: "ctx_search", tokens: searchTokens });

  let accumulated = searchOut;
  let { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  const oneShot = ok;
  const filesRead = [];
  let savedVsFull = 0;
  const targets = filesCitedInSearch(searchOut, topic.requiredFiles);

  if (!ok) {
    for (const rel of targets) {
      ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
      if (ok) break;
      const need = missing.filter((m) => {
        const abs = path.join(ROOT, rel);
        return fs.existsSync(abs) && fs.readFileSync(abs, "utf8").includes(m);
      });
      if (!need.length && filesRead.length > 0) continue;
      const markersForFile = need.length ? need : missing;
      const extract = sandboxExtract(rel, markersForFile);
      if (!extract.exists) continue;
      accumulated += `\n\n----- ctx_execute_file ${rel} -----\n` + extract.text;
      calls.push({
        tool: "ctx_execute_file",
        path: rel,
        tokens: extract.tokens,
        note: `stdout-only; full would be ${extract.fullTokens}`,
      });
      filesRead.push(rel);
      savedVsFull += Math.max(0, extract.fullTokens - extract.tokens);
    }
    // If search cited the wrong subset, try remaining required files
    if (!ok) {
      for (const rel of topic.requiredFiles) {
        if (filesRead.includes(rel)) continue;
        ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
        if (ok) break;
        const extract = sandboxExtract(rel, missing);
        if (!extract.exists) continue;
        if (!missing.some((m) => extract.text.includes(m))) continue;
        accumulated += `\n\n----- ctx_execute_file ${rel} -----\n` + extract.text;
        calls.push({
          tool: "ctx_execute_file",
          path: rel,
          tokens: extract.tokens,
          note: "fallback after search miss",
        });
        filesRead.push(rel);
        savedVsFull += Math.max(0, extract.fullTokens - extract.tokens);
      }
    }
  }

  ({ ok, missing } = isComplete(accumulated, topic.requiredMarkers));
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  return {
    side: "contextmode",
    totalTokens,
    searchTokens,
    followUpTokens: totalTokens - searchTokens,
    callCount: calls.length,
    oneShot,
    complete: ok,
    missingMarkers: missing,
    filesRead,
    calls,
    sandboxSavedVsFullRead: savedVsFull,
  };
}

function summarizeTrackA(name, results) {
  const sides = ["builtin", "contextos", "headroom", "contextmode"];
  const bySide = {};
  for (const side of sides) {
    const rows = results.map((r) => r[side]);
    const n = rows.length;
    const sum = rows.reduce((s, r) => s + r.totalTokens, 0);
    bySide[side] = {
      n,
      complete: rows.filter((r) => r.complete).length,
      oneShot: rows.filter((r) => r.oneShot).length,
      avgTotalTokens: Math.round(sum / n),
      totalTokens: sum,
      avgCalls:
        Math.round((rows.reduce((s, r) => s + r.callCount, 0) / n) * 10) / 10,
    };
  }
  const wins = Object.fromEntries(sides.map((s) => [s, 0]));
  let ties = 0;
  for (const r of results) {
    const sorted = sides
      .map((s) => ({ s, t: r[s].totalTokens }))
      .sort((a, b) => a.t - b.t);
    if (sorted[0].t === sorted[1].t) ties++;
    else wins[sorted[0].s]++;
  }
  return { suite: name, bySide, tokenWins: wins, tokenTies: ties };
}

async function runTrackA(name, topics, bridge) {
  console.error(`\n=== Track A: ${name} (${topics.length}) — fair single-query ===`);
  const results = [];
  for (const topic of topics) {
    process.stderr.write(`  #${topic.n} ${topic.topic.slice(0, 40)}… `);
    const builtin = runBuiltInFair(topic);
    const contextos = await runContextOSFlow(topic);
    const headroom = await runHeadroomFair(topic, bridge, { freshReads: true });
    const contextmode = runContextModeFair(topic);
    const totals = {
      builtin: builtin.totalTokens,
      contextos: contextos.totalTokens,
      headroom: headroom.totalTokens,
      contextmode: contextmode.totalTokens,
    };
    const sorted = Object.entries(totals).sort((a, b) => a[1] - b[1]);
    const tokenWinner = sorted[0][1] === sorted[1][1] ? "Tie" : sorted[0][0];
    results.push({
      n: topic.n,
      topic: topic.topic,
      builtin,
      contextos,
      headroom,
      contextmode,
      totals,
      tokenWinner,
      oneShot: {
        builtin: builtin.oneShot,
        contextos: contextos.oneShot,
        headroom: headroom.oneShot,
        contextmode: contextmode.oneShot,
      },
    });
    process.stderr.write(
      `B${builtin.totalTokens} C${contextos.totalTokens} H${headroom.totalTokens} M${contextmode.totalTokens} ` +
        `1shot=${contextos.oneShot ? "C" : "-"}${contextmode.oneShot ? "M" : "-"} win=${tokenWinner}\n`,
    );
  }
  return { results, summary: summarizeTrackA(name, results) };
}

/**
 * Headroom session flow: file bytes stay in the agent's context after the
 * first headroom_read. Later cache hits cost ~20 tok and completeness uses
 * the session memory of prior full reads (CCR contract).
 */
async function runHeadroomSessionQuery(topic, bridge, fileMemory) {
  const calls = [];
  const grepOut = runGrep(topic.grepPattern, topic.grepGlob);
  const compressed = await bridge.compress(grepOut || "(empty)");
  if (!compressed.ok) throw new Error(compressed.error);
  const toolText = compressed.tool_text || "";
  const searchTokens = tok(toolText);
  calls.push({
    tool: "Grep+headroom_compress",
    tokens: searchTokens,
    note: `savings%=${compressed.savings_percent}`,
  });

  let accumulated =
    (typeof compressed.compressed === "string"
      ? compressed.compressed
      : JSON.stringify(compressed.compressed)) + "\n";
  // Prior full reads still in the conversation
  for (const rel of topic.requiredFiles) {
    if (fileMemory.has(rel)) accumulated += fileMemory.get(rel) + "\n";
  }

  let cacheHits = 0;
  for (const rel of topic.requiredFiles) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const read = await bridge.read(abs, false);
    if (!read.ok) continue;
    const text = read.tool_text || "";
    const tokens = tok(text);
    const isCache = text.includes('"status": "cached"');
    if (isCache) {
      cacheHits++;
      calls.push({ tool: "headroom_read", path: rel, tokens, note: "cache_hit" });
    } else {
      fileMemory.set(rel, text);
      accumulated += text + "\n";
      calls.push({ tool: "headroom_read", path: rel, tokens, note: "full" });
    }
  }

  const { ok, missing } = isComplete(accumulated, topic.requiredMarkers);
  const totalTokens = calls.reduce((s, c) => s + c.tokens, 0);
  return {
    side: "headroom",
    totalTokens,
    searchTokens,
    followUpTokens: totalTokens - searchTokens,
    callCount: calls.length,
    oneShot: false,
    complete: ok,
    missingMarkers: missing,
    calls,
    cacheHits,
  };
}

async function runTrackB(bridge) {
  // Overlapping-file session using specific prompts (named symbols)
  const byId = Object.fromEntries(SPECIFIC_TOPICS.map((t) => [t.id, t]));
  const sequence = SESSION_TOPIC_IDS.map((id) => byId[id]).filter(Boolean);

  console.error(`\n=== Track B: session continuity (${sequence.length} related queries) ===`);

  const sessionBridge = new HeadroomBridge();
  const fileMemory = new Map();
  const sides = {
    builtin: [],
    contextos: [],
    headroom: [],
    contextmode: [],
  };

  try {
    for (const topic of sequence) {
      process.stderr.write(`  sess #${topic.n}… `);
      sides.builtin.push(runBuiltInFair(topic));
      sides.contextos.push(await runContextOSFlow(topic));
      sides.headroom.push(
        await runHeadroomSessionQuery(topic, sessionBridge, fileMemory),
      );
      sides.contextmode.push(runContextModeFair(topic));
      process.stderr.write(
        `B${sides.builtin.at(-1).totalTokens} C${sides.contextos.at(-1).totalTokens} ` +
          `H${sides.headroom.at(-1).totalTokens}(cache=${sides.headroom.at(-1).cacheHits}) ` +
          `M${sides.contextmode.at(-1).totalTokens}\n`,
      );
    }
  } finally {
    sessionBridge.close();
  }

  const summary = {};
  for (const [side, rows] of Object.entries(sides)) {
    const total = rows.reduce((s, r) => s + r.totalTokens, 0);
    const cacheHits = rows.reduce((s, r) => s + (r.cacheHits || 0), 0);
    summary[side] = {
      queries: rows.length,
      totalTokens: total,
      avgTokens: Math.round(total / rows.length),
      cacheHits,
      complete: rows.filter((r) => r.complete).length,
      oneShot: rows.filter((r) => r.oneShot).length,
    };
  }
  return { sequence: sequence.map((t) => t.id), perQuery: sides, summary };
}

function runTrackC() {
  console.error(`\n=== Track C: think-in-code aggregation ===`);
  const files = [
    ...new Set(TOPIC_DEFS.slice(0, 14).flatMap((t) => t.requiredFiles)),
  ].filter((f) => fs.existsSync(path.join(ROOT, f)));

  // Built-in / Headroom first-read cost: all file bytes enter context
  let dumpTokens = 0;
  for (const rel of files) {
    dumpTokens += readFileRel(rel).tokens;
  }

  // context-mode: one sandbox script — only summary stdout
  let stdout = "";
  for (const rel of files) {
    const full = fs.readFileSync(path.join(ROOT, rel), "utf8");
    const exportFns = (
      full.match(
        /(?:export\s+(?:async\s+)?function\s+\w+|export\s+const\s+\w+\s*=)/g,
      ) || []
    ).length;
    const lines = full.split("\n").length;
    stdout += `${rel}: ${lines} lines, ~${exportFns} exports\n`;
  }
  const sandboxTokens = tok(stdout);

  // ContextOS: ask one compile query (honest — wrong tool for aggregation)
  // Measure get_context for "count exports in these files" — likely incomplete
  const result = {
    files: files.length,
    builtinDumpTokens: dumpTokens,
    headroomFirstReadTokens: dumpTokens, // same first-pass cost
    contextmodeStdoutTokens: sandboxTokens,
    savingsPctVsDump: Math.round((1 - sandboxTokens / dumpTokens) * 1000) / 10,
    stdoutPreview: stdout.slice(0, 500),
    note: "context-mode Think-in-Code: file bytes stay in sandbox; only summary enters context. ContextOS get_context is for semantic retrieval, not aggregation — not run as primary here.",
  };
  console.error(
    `  files=${files.length} dump=${dumpTokens} sandbox_stdout=${sandboxTokens} save=${result.savingsPctVsDump}%`,
  );
  return result;
}

async function runTrackD(bridge) {
  console.error(`\n=== Track D: Headroom compression by content type ===`);
  const cases = [];

  const bigGrep = runGrep(
    "function |class |export ",
    "*.{ts,tsx}",
  );
  const codeFile = fs.readFileSync(
    path.join(ROOT, "src/core/retrieval/scorer.ts"),
    "utf8",
  );
  const syntheticLog = Array.from({ length: 800 }, (_, i) => {
    const lvl = i % 17 === 0 ? "ERROR" : i % 5 === 0 ? "WARN" : "INFO";
    return `2026-07-12T12:00:${String(i % 60).padStart(2, "0")}.000Z ${lvl} service=api request_id=req_${i} msg=handled path=/v1/items/${i % 40} latency_ms=${(i * 7) % 300}`;
  }).join("\n");

  for (const [label, content] of [
    ["large_code_grep", bigGrep],
    ["source_file_scorer_ts", codeFile],
    ["synthetic_api_log", syntheticLog],
  ]) {
    const r = await bridge.compress(content);
    cases.push({
      label,
      originalChars: content.length,
      originalTokensEst: tok(content),
      headroomOriginalTokens: r.original_tokens,
      headroomCompressedTokens: r.compressed_tokens,
      savingsPercent: r.savings_percent,
      transforms: r.transforms,
      agentVisibleTokens: tok(r.tool_text || ""),
    });
    console.error(
      `  ${label}: ${r.savings_percent}% saved (transforms=${(r.transforms || []).join(",")})`,
    );
  }
  return { cases };
}

async function main() {
  const styleArg = process.argv[2] || "all"; // specific | generic | all
  const bridge = new HeadroomBridge();
  const out = {
    generatedAt: new Date().toISOString(),
    topicSource: "scripts/ab-topics.mjs",
    topicCount: TOPIC_DEFS.length,
    methodology: {
      tokenEstimator: "ContextOS estimateTokens on agent-visible tool outputs",
      specific:
        "Prompt names the file and/or function the user already knows about",
      generic:
        "Same underlying answer; prompt is a vague natural-language question",
      trackA: {
        builtin: "Grep → ranged Read (±40 lines around hits) → full escalate if needed",
        contextos: "get_context (budget 1200) → conditional Read",
        headroom: "Grep → headroom_compress → headroom_read (fresh per query)",
        contextmode:
          "ctx_search → ctx_execute_file-style marker window extract (stdout only)",
      },
      trackB: "Related queries sharing files; Headroom cache ON across session",
      trackC: "Aggregate export counts: dump-all Reads vs sandbox stdout summary",
      trackD: "headroom_compress savings by content type",
    },
  };

  try {
    out.trackA = {};
    if (styleArg === "all" || styleArg === "specific") {
      out.trackA.specific = await runTrackA(
        "specific",
        SPECIFIC_TOPICS,
        bridge,
      );
    }
    if (styleArg === "all" || styleArg === "generic") {
      out.trackA.generic = await runTrackA("generic", GENERIC_TOPICS, bridge);
    }
    if (styleArg === "all") {
      out.trackB = await runTrackB(bridge);
      out.trackC = runTrackC();
      out.trackD = await runTrackD(bridge);
    }
  } finally {
    bridge.close();
  }

  const outPath = path.join(ROOT, "scripts/ab-fair-results.json");
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.error(`\nWrote ${outPath}`);

  const brief = {
    trackA_specific: out.trackA.specific?.summary,
    trackA_generic: out.trackA.generic?.summary,
    trackB: out.trackB?.summary,
    trackC: out.trackC && {
      files: out.trackC.files,
      dump: out.trackC.builtinDumpTokens,
      sandbox: out.trackC.contextmodeStdoutTokens,
      savePct: out.trackC.savingsPctVsDump,
    },
    trackD: out.trackD?.cases.map((c) => ({
      label: c.label,
      savingsPercent: c.savingsPercent,
      transforms: c.transforms,
    })),
  };
  console.log(JSON.stringify(brief, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
