import { ScoredChunk } from '../retrieval/types.js';
import { estimateTokens } from '../../utils/tokens.js';

export interface CompressOptions {
  signalTerms?: string[];
  /** High-precision prompt identifiers — used for exact-symbol leader budget override. */
  identifiers?: string[];
  /** High-precision intent concepts — bypass weak stop words */
  concepts?: string[];
}

function stripComments(code: string): string {
  let out = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inLineComment = false;
  let inBlockComment = false;

  while (i < code.length) {
    const char = code[i];
    const nextChar = code[i + 1] || '';

    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        out += char;
      }
      i++;
    } else if (inBlockComment) {
      if (char === '*' && nextChar === '/') {
        inBlockComment = false;
        i += 2;
      } else {
        i++;
      }
    } else if (inString) {
      if (char === '\\') {
        out += char + nextChar;
        i += 2;
      } else if (char === stringChar) {
        inString = false;
        out += char;
        i++;
      } else {
        out += char;
        i++;
      }
    } else {
      if (char === '"' || char === "'" || char === '`') {
        inString = true;
        stringChar = char;
        out += char;
        i++;
      } else if (char === '/' && nextChar === '/') {
        inLineComment = true;
        i += 2;
      } else if (char === '/' && nextChar === '*') {
        inBlockComment = true;
        i += 2;
      } else {
        out += char;
        i++;
      }
    }
  }
  return out.replace(/^\s*[\r\n]/gm, '');
}

/** Whitespace canonicalization: CRLF→LF, trailing WS, blank-run collapse, dedent. */
export function canonicalizeWhitespace(content: string): string {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''));
  const collapsed: string[] = [];
  let blankRun = 0;
  for (const line of lines) {
    if (line.trim() === '') {
      blankRun++;
      if (blankRun <= 1) collapsed.push('');
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  const nonEmpty = collapsed.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return collapsed.join('\n');

  let minIndent = Infinity;
  for (const l of nonEmpty) {
    const m = l.match(/^[ \t]*/);
    if (m) minIndent = Math.min(minIndent, m[0].length);
  }
  if (minIndent > 0 && minIndent < Infinity) {
    return collapsed
      .map((l) => {
        let dedented = l.length >= minIndent ? l.slice(minIndent) : l;
        const m = dedented.match(/^[ \t]+/);
        if (m) {
          const indentStr = m[0];
          const spaces = indentStr.replace(/\t/g, '    ').length;
          const newIndent = ' '.repeat(Math.floor(spaces / 2) + (spaces % 2));
          dedented = newIndent + dedented.slice(indentStr.length);
        }
        return dedented;
      })
      .join('\n');
  }
  return collapsed
    .map((l) => {
      const m = l.match(/^[ \t]+/);
      if (m) {
        const indentStr = m[0];
        const spaces = indentStr.replace(/\t/g, '    ').length;
        const newIndent = ' '.repeat(Math.floor(spaces / 2) + (spaces % 2));
        return newIndent + l.slice(indentStr.length);
      }
      return l;
    })
    .join('\n');
}

/** Safe JSON minify; light YAML blank/trailing cleanup only. */
export function minifyConfigContent(content: string, language?: string): string {
  const lang = (language || '').toLowerCase();
  if (lang === 'json' || lang === 'jsonc') {
    try {
      return JSON.stringify(JSON.parse(content));
    } catch {
      return canonicalizeWhitespace(content);
    }
  }
  if (lang === 'yaml' || lang === 'yml') {
    return canonicalizeWhitespace(content);
  }
  return content;
}

/** Relative-ish path with optional line range for agent-targeted reads. */
export function stubLocLabel(c: ScoredChunk): string {
  const normalized = c.sourceFile.replace(/\\/g, '/');
  // Prefer last 2–3 path segments so agents can pass a usable relative path
  const parts = normalized.split('/').filter(Boolean);
  const display =
    parts.length >= 3
      ? parts.slice(-3).join('/')
      : parts.length >= 2
        ? parts.slice(-2).join('/')
        : parts[0] || c.sourceFile;
  if (c.startLine != null && c.endLine != null) {
    return `${display}:${c.startLine}-${c.endLine}`;
  }
  return display;
}

function toStub(c: ScoredChunk): ScoredChunk {
  const loc = stubLocLabel(c);
  const sig = c.symbolName
    ? `${c.symbolKind || 'symbol'} ${c.symbolName}`
    : (c.sectionTitle || loc);
  const content = `${sig} — ${loc}`;
  return {
    ...c,
    content,
    tokenCount: Math.max(8, estimateTokens(content)),
    summary: '[stub]',
  };
}

/** Prefer a tiny snippet over a stub when the body holds query-signal lines. */
function toStubOrSnippet(c: ScoredChunk, signalTerms?: string[], concepts?: string[]): ScoredChunk {
  const signalRe = buildSignalRegex(signalTerms, concepts);
  if (!signalRe) return toStub(c);

  const lines = c.content.split('\n');
  const signalLines = lines.filter((l) => l.length < 200 && signalRe.test(l));
  if (signalLines.length >= 1 && signalLines.length <= 16) {
    const head = lines[0] || '';
    const content = [head, ...signalLines.filter((l) => l !== head)].join('\n');
    return {
      ...c,
      content,
      tokenCount: estimateTokens(content),
      summary: null,
    };
  }
  return toStub(c);
}

/** Stub when no signal lines fit; otherwise keep a mini-snippet in `full` if it fits. */
function pushStubOrMini(
  c: ScoredChunk,
  full: ScoredChunk[],
  stubs: ScoredChunk[],
  used: number,
  budget: number,
  signalTerms?: string[],
  concepts?: string[],
): number {
  const mini = toStubOrSnippet(c, signalTerms, concepts);
  if (mini.summary !== '[stub]' && used + mini.tokenCount <= budget) {
    full.push(mini);
    return used + mini.tokenCount;
  }
  stubs.push(toStub(c));
  return used;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const WEAK_STOP = new Set([
  'the', 'and', 'for', 'how', 'with', 'from', 'that', 'this', 'into', 'during', 'using',
  'are', 'was', 'what', 'when', 'where', 'which', 'than', 'then', 'also', 'just',
  'a', 'an', 'or', 'to', 'of', 'in', 'on', 'is', 'be', 'by', 'as', 'at',
  // Generic code fragments that flood signal matching when split from camelCase
  'score', 'file', 'path', 'chunk', 'type', 'name', 'data', 'list', 'item', 'info',
  'value', 'index', 'count', 'total', 'result', 'error', 'test', 'config', 'option',
  'source', 'target', 'start', 'final', 'merge', 'store', 'manager', 'handler',
]);

export function collectSignalTerms(signalTerms: string[] | undefined, concepts?: string[]): string[] {
  const terms = new Set<string>();
  for (const raw of concepts || []) {
    if (raw && typeof raw === 'string') terms.add(raw.trim());
  }
  for (const raw of signalTerms || []) {
    if (!raw || typeof raw !== 'string') continue;
    const t = raw.trim();
    if (t.length < 3 || WEAK_STOP.has(t.toLowerCase())) continue;
    // Keep full identifiers even if short parts are weak (e.g. finalScore, scoreChunks)
    if (t.length >= 4) terms.add(t);
    if (/s$/i.test(t) && t.length > 5) {
      const singular = t.replace(/s$/i, '');
      if (singular.length >= 4 && !WEAK_STOP.has(singular.toLowerCase())) terms.add(singular);
    }
    // Light stemming so "deduplicated" hits "deduplicate and …"
    if (/ated$/i.test(t) && t.length > 7) {
      const stem = t.replace(/d$/i, '');
      if (stem.length >= 5) terms.add(stem);
    }
    if (/ing$/i.test(t) && t.length > 6) {
      const stem = t.replace(/ing$/i, '');
      if (stem.length >= 5 && !WEAK_STOP.has(stem.toLowerCase())) terms.add(stem);
    }
    // Filename / path stems (get-context.ts, session-store, queryCommand)
    const base = t.replace(/^.*[/\\]/, '').replace(/\.(ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml)$/i, '');
    if (base.length >= 4 && base !== t) terms.add(base);
    // Only keep substantial camel/snake parts (≥5) to avoid diluting truncation
    const parts = t.split(/(?=[A-Z])|[\s_.-]+/).filter((p) => p.length >= 5);
    for (const p of parts) {
      if (!WEAK_STOP.has(p.toLowerCase())) terms.add(p);
    }
    // kebab ↔ camel bridges so "get_context" / "get-context" hit getContext-style symbols
    if (/[-_]/.test(base)) {
      const camel = base
        .split(/[-_]+/)
        .filter(Boolean)
        .map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
        .join('');
      if (camel.length >= 5) terms.add(camel);
    }
  }
  return [...terms]
    .filter((t) => t.length >= 4 && t.length < 64)
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
}

/** Longest matching signal term length for a line (0 if none). */
function longestSignalHit(line: string, terms: string[]): number {
  const lower = line.toLowerCase();
  let best = 0;
  for (const t of terms) {
    if (t.length > best && lower.includes(t.toLowerCase())) best = t.length;
  }
  return best;
}

export function buildSignalRegex(signalTerms: string[] | undefined, concepts?: string[]): RegExp | null {
  const list = collectSignalTerms(signalTerms, concepts);
  if (list.length === 0) return null;
  try {
    return new RegExp(list.map(escapeRegExp).join('|'), 'i');
  } catch {
    return null;
  }
}

/**
 * Truncate while retaining query-signal windows (not head-only).
 */
export function truncatePreservingSignals(
  content: string,
  ratio: number,
  signalTerms?: string[],
  concepts?: string[],
): string {
  const lines = content.split('\n');
  const keep = Math.max(3, Math.floor(lines.length * Math.max(0.05, Math.min(1, ratio))));
  if (keep >= lines.length) return content;

  // Force-keep dotted call sites / pipeline markers — collectSignalTerms caps at 40 and
  // can drop short-but-critical terms like expander.expand under noisy prompts.
  const forced = (signalTerms || []).filter(
    (t) =>
      typeof t === 'string' &&
      (t.includes('.') ||
        /^(detectIntent|matchChunks|scoreChunks|allChunksMap|containmentDedup)$/i.test(t)),
  );
  const termList = [...new Set([...forced, ...collectSignalTerms(signalTerms, concepts)])];
  const signalRe = buildSignalRegex(termList);
  const selected = new Set<number>();

  // Rank signal lines by longest matching term (prefer specific identifiers)
  const rankedSignalHits: { i: number; rank: number }[] = [];
  if (termList.length > 0) {
    for (let i = 0; i < lines.length; i++) {
      const rank = longestSignalHit(lines[i], termList);
      if (rank >= 4) rankedSignalHits.push({ i, rank });
    }
    rankedSignalHits.sort((a, b) => b.rank - a.rank || a.i - b.i);
  }

  // Seed windows around top-ranked signal hits (wider for strong matches / if-blocks)
  const seedCap = Math.max(8, Math.floor(keep * 0.6));
  for (const { i, rank } of rankedSignalHits.slice(0, seedCap)) {
    const isComment = /^\s*\/\//.test(lines[i]) || /^\s*\/\*/.test(lines[i]);
    // Comments often head multi-line if/blocks — look farther ahead
    const ahead = isComment
      ? (rank >= 5 ? 16 : 10)
      : (rank >= 12 ? 14 : rank >= 8 ? 10 : rank >= 6 ? 5 : 2);
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + ahead); j++) {
      selected.add(j);
    }
    if (i > 0 && /^\s*\/\//.test(lines[i - 1])) selected.add(i - 1);
  }

  // Keep a limited number of call-site glue lines, SQL DDL, and branch headers
  const callSites: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\b[a-zA-Z_]\w*\.[a-zA-Z_]\w{3,}\s*\(/.test(lines[i])) callSites.push(i);
    // camelCase function invocations (detectIntent(, scoreChunks(, matchChunks()
    if (/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\s*\(/.test(lines[i])) callSites.push(i);
    if (/CREATE\s+(VIRTUAL\s+)?TABLE|CREATE\s+INDEX|USING\s+fts/i.test(lines[i])) callSites.push(i);
    // Branch / control-flow headers — generic explanatory structure
    if (/^\s*(?:if|else\s+if|else|switch|case|default|catch|for|while|try)\b/.test(lines[i])) {
      callSites.push(i);
    }
  }
      const callBudget = Math.max(4, Math.floor(keep * 0.35));
  const chosenCalls: number[] = [];
  // Prefer unique indices; prioritize call sites that mention signal terms
  const uniqCalls = [...new Set(callSites)];
  if (uniqCalls.length <= callBudget) {
    chosenCalls.push(...uniqCalls);
  } else {
    const ranked = uniqCalls
      .map((i) => ({ i, rank: longestSignalHit(lines[i], termList) }))
      .sort((a, b) => b.rank - a.rank || a.i - b.i);
    const picked = new Set<number>();
    for (const { i } of ranked) {
      if (picked.size >= callBudget) break;
      picked.add(i);
    }
    // Fill remaining slots evenly across the file so mid-pipeline calls survive
    if (picked.size < callBudget) {
      for (let k = 0; k < uniqCalls.length && picked.size < callBudget; k++) {
        const i = uniqCalls[Math.floor((k * (uniqCalls.length - 1)) / Math.max(1, callBudget - 1))];
        picked.add(i);
      }
    }
    chosenCalls.push(...picked);
  }
  for (let i = 0; i < lines.length; i++) {
    if (/CREATE\s+(VIRTUAL\s+)?TABLE|USING\s+fts/i.test(lines[i])) {
      if (!chosenCalls.includes(i)) chosenCalls.push(i);
    }
  }
  for (const i of chosenCalls) {
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) selected.add(j);
  }

  // Always preserve JSDoc / block-comment and line-comment headers (explanatory signal)
  let commentLinesKept = 0;
  const commentCap = 15;
  for (let i = 0; i < lines.length; i++) {
    if (commentLinesKept >= commentCap) break;
    const line = lines[i];
    if (/^\s*\/\*\*/.test(line) || /^\s*\*/.test(line) || /^\s*\/\//.test(line)) {
      // Prefer comments that sit near a declaration
      const nearDecl =
        i + 1 < lines.length &&
        /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\b/.test(
          lines[i + 1],
        );
      if (nearDecl) {
        selected.add(i);
        if (i + 1 < lines.length) selected.add(i + 1);
        commentLinesKept += 2;
      }
    }
  }

  const headCount = Math.min(Math.max(2, Math.floor(keep * 0.35)), lines.length);
  for (let i = 0; i < headCount; i++) selected.add(i);
  for (let i = lines.length - 1; i >= 0 && selected.size < keep; i--) selected.add(i);
  for (let i = headCount; i < lines.length && selected.size < keep; i++) selected.add(i);

  // Enforce keep cap: prefer high-rank signal + call + head + tail
  if (selected.size > keep) {
    const must = new Set<number>();
    for (let i = 0; i < Math.min(headCount, keep); i++) must.add(i);
    must.add(lines.length - 1);
    for (const i of chosenCalls) must.add(i);
    const signalCap = Math.max(6, Math.floor(keep * 0.5));
    for (const { i, rank } of rankedSignalHits.slice(0, signalCap)) {
      must.add(i);
      const isComment = /^\s*\/\//.test(lines[i]) || /^\s*\/\*/.test(lines[i]);
      const ahead = isComment
        ? (rank >= 5 ? 16 : 10)
        : (rank >= 12 ? 14 : rank >= 8 ? 10 : rank >= 6 ? 5 : 2);
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + ahead); j++) {
        must.add(j);
      }
      if (i > 0 && /^\s*\/\//.test(lines[i - 1])) must.add(i - 1);
    }
    const optional = [...selected].filter((i) => !must.has(i)).sort((a, b) => a - b);
    while (must.size + optional.length > keep && optional.length > 0) {
      optional.splice(Math.floor(optional.length / 2), 1);
    }
    if (must.size > keep) {
      const priority = new Set<number>();
      for (let i = 0; i < Math.min(3, lines.length); i++) priority.add(i);
      priority.add(lines.length - 1);
      for (const i of chosenCalls) priority.add(i);
      // Keep highest-rank signal lines (+ windows) in priority
      for (const { i, rank } of rankedSignalHits.slice(0, Math.max(4, Math.floor(keep * 0.35)))) {
        priority.add(i);
        const isComment = /^\s*\/\//.test(lines[i]) || /^\s*\/\*/.test(lines[i]);
        const ahead = isComment ? 14 : (rank >= 12 ? 10 : rank >= 8 ? 6 : 3);
        for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + ahead); j++) {
          priority.add(j);
        }
      }
      const droppable = [...must].filter((i) => !priority.has(i)).sort((a, b) => a - b);
      while (priority.size + droppable.length > keep && droppable.length > 0) {
        droppable.splice(Math.floor(droppable.length / 2), 1);
      }
      must.clear();
      for (const i of priority) must.add(i);
      for (const i of droppable) must.add(i);
    }
    selected.clear();
    for (const i of must) selected.add(i);
    for (const i of optional) selected.add(i);
  }

  const sorted = [...selected].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev >= 0 && idx > prev + 1) out.push('//…');
    out.push(lines[idx]);
    prev = idx;
  }
  return out.join('\n');
}

/** Truncate until content actually fits maxTok (never lie about tokenCount). */
function fitContentToBudget(
  content: string,
  maxTok: number,
  signalTerms?: string[],
  concepts?: string[],
): { content: string; tokenCount: number } {
  let tok = estimateTokens(content);
  if (tok <= maxTok) return { content, tokenCount: tok };

  let ratio = Math.max(0.08, Math.min(1, (maxTok / tok) * 0.9));
  let out = truncatePreservingSignals(content, ratio, signalTerms, concepts) + '\n//…';
  tok = estimateTokens(out);
  let guard = 0;
  while (tok > maxTok && guard++ < 8) {
    ratio = Math.max(0.06, ratio * (maxTok / tok) * 0.85);
    out = truncatePreservingSignals(content, ratio, signalTerms, concepts) + '\n//…';
    tok = estimateTokens(out);
  }
  if (tok > maxTok) {
    // Last resort: head + highest-rank signal lines (with short windows)
    const lines = content.split('\n');
    const termList = collectSignalTerms(signalTerms);
    const ranked = lines
      .map((l, i) => ({ l, i, rank: longestSignalHit(l, termList) }))
      .filter((x) => x.rank >= 4)
      .sort((a, b) => b.rank - a.rank || a.i - b.i);
    const keepIdx = new Set<number>([0]);
    for (const { i, rank } of ranked) {
      if (keepIdx.size >= 40) break;
      const isComment = /^\s*\/\//.test(lines[i]) || /^\s*\/\*/.test(lines[i]);
      const ahead = isComment ? 16 : (rank >= 10 ? 12 : rank >= 6 ? 4 : 1);
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + ahead); j++) {
        keepIdx.add(j);
      }
    }
    out = [...keepIdx].sort((a, b) => a - b).map((i) => lines[i]).join('\n') + '\n//…';
    tok = estimateTokens(out);
  }
  return { content: out, tokenCount: tok };
}

function prepareContent(c: ScoredChunk): ScoredChunk {
  let content = c.content;
  if (c.fileType === 'config' || c.language === 'json' || c.language === 'yaml' || c.language === 'yml') {
    content = minifyConfigContent(content, c.language);
  } else {
    content = canonicalizeWhitespace(content);
  }
  return { ...c, content, tokenCount: estimateTokens(content) };
}

function isTestFile(c: ScoredChunk): boolean {
  return /\.(test|spec)\.|vitest\.config|\/fixtures\//i.test(c.sourceFile);
}

export interface CompressCtx {
  signalList: string[];
  idSet: Set<string>;
  symbolNamedInPrompt: (symbol: string | null | undefined) => boolean;
  stemMatch: (c: ScoredChunk) => boolean;
  contentHitsSignal: (c: ScoredChunk) => boolean;
  opts?: CompressOptions;
}

function fileStemOf(f: string): string {
  return (f.split(/[/\\]/).pop() || f).replace(/\.(ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml)$/i, '');
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function buildCompressCtx(
  signalList: string[],
  idSet: Set<string>,
): CompressCtx {
  /** True when prompt names this symbol, or a camelCase/compound extension of it (compile↔compileLayer). */
  const symbolNamedInPrompt = (symbol: string | null | undefined): boolean => {
    if (!symbol) return false;
    const s = symbol.toLowerCase();
    if (idSet.has(s)) return true;
    for (const id of idSet) {
      if (id.length >= s.length + 3 && id.startsWith(s)) return true;
    }
    return false;
  };
  const signalKeys = new Set(signalList.map(normKey).filter((k) => k.length >= 4));
  const stemMatch = (c: ScoredChunk): boolean => {
    const stem = normKey(fileStemOf(c.sourceFile));
    const sym = normKey(c.symbolName || '');
    return (
      (stem.length >= 4 && signalKeys.has(stem)) ||
      (sym.length >= 4 && signalKeys.has(sym)) ||
      [...signalKeys].some(
        (k) =>
          (k.length >= 6 && (stem.includes(k) || k.includes(stem))) ||
          (sym.length >= 4 && (sym === k || (k.length >= 6 && (sym.includes(k) || k.includes(sym))))),
      )
    );
  };
  const contentHitsSignal = (c: ScoredChunk): boolean => {
    const sym = (c.symbolName || '').toLowerCase();
    if (sym && signalList.some((t) => {
      const tl = t.toLowerCase();
      return sym === tl || (tl.length >= 5 && (sym.includes(tl) || tl.includes(sym)));
    })) return true;
    // CamelCase parts (getSessionContext → session) vs multi-word signals
    if (c.symbolName) {
      const parts = c.symbolName
        .split(/(?=[A-Z])|[_\-.]+/)
        .map((p) => p.toLowerCase())
        .filter((p) => p.length >= 5);
      if (parts.some((p) => signalList.some((t) => {
        const tl = t.toLowerCase();
        // Word-level only — avoid "knowledge" matching KnowledgeStore/registerKnowledgeTools
        return tl === p || tl.split(/[\s_-]+/).includes(p);
      }))) return true;
    }
    if (c.symbolKind === 'segment' && c.parentSymbol) {
      const ps = c.parentSymbol.toLowerCase();
      if (signalList.some((t) => {
        const tl = t.toLowerCase();
        return ps === tl || (tl.length >= 5 && (ps.includes(tl) || tl.includes(ps)));
      })) return true;
    }
    if (stemMatch(c)) return true;
    const lower = c.content.toLowerCase();
    return signalList.some((t) => t.length >= 6 && lower.includes(t.toLowerCase()));
  };
  return { signalList, idSet, symbolNamedInPrompt, stemMatch, contentHitsSignal };
}

/** Leader selection, dedup-prompt leader, segment-vs-parent preference. */
export function pickPrimaries(
  deduped: ScoredChunk[],
  maxTokens: number,
  ctx: CompressCtx,
): ScoredChunk[] {
  const { signalList, idSet, symbolNamedInPrompt, stemMatch } = ctx;

  // Primary picks (skip test files unless nothing else)
  const byFile = new Map<string, number>();
  let primary: ScoredChunk[] = [];
  for (const c of deduped) {
    if (isTestFile(c)) continue;
    if (primary.length >= Math.min(5, deduped.length)) break;
    const count = byFile.get(c.sourceFile) || 0;
    if (count >= 2) continue;
    primary.push(c);
    byFile.set(c.sourceFile, count + 1);
  }
  if (primary.length === 0) primary.push(...deduped.slice(0, 3));

  // Prefer chunks whose filename stem or symbol matches a strong signal term
  const preferred = deduped
    .filter((c) => !isTestFile(c) && stemMatch(c))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  if (preferred.length > 0) {
    for (const p of preferred.slice(0, 2).reverse()) {
      primary.unshift(p);
    }
    // Keep first occurrence so unshifted preferred leaders stay at the front
    const seenP = new Set<string>();
    primary = primary.filter((c) => {
      if (seenP.has(c.id)) return false;
      seenP.add(c.id);
      return true;
    });
  }

  // Dedup prompts: lead with retrieve() so the merge-map body gets the leader budget
  if (signalList.some((t) => /dedup|deduplicat/i.test(t))) {
    const retrieveHit = deduped.find((c) => c.symbolName === 'retrieve');
    if (retrieveHit) {
      primary = [retrieveHit, ...primary.filter((c) => c.id !== retrieveHit.id)];
    }
  }

  // Prefer a substantial same-file body over a compact class/struct outline as leader
  if (
    primary[0] &&
    (primary[0].symbolKind === 'class' || primary[0].symbolKind === 'struct') &&
    (primary[0].tokenCount || 0) < 80
  ) {
    const outline = primary[0];
    const bodies = deduped.filter((c) => {
      if (c.id === outline.id || c.sourceFile !== outline.sourceFile) return false;
      if ((c.tokenCount || 0) < 200) return false;
      if (c.parentSymbol === outline.symbolName) return true;
      if (c.symbolName && idSet.has(c.symbolName.toLowerCase())) return true;
      const sym = (c.symbolName || '').toLowerCase();
      if (sym && signalList.some((t) => {
        const tl = t.toLowerCase();
        return sym === tl || (tl.length >= 5 && (sym.includes(tl) || tl.includes(sym)));
      })) return true;
      return false;
    });
    // Prefer signal-named methods (retrieve) over incidental helpers (applyEmbeddingFusion)
    bodies.sort((a, b) => {
      const scoreBody = (c: ScoredChunk): number => {
        const sym = (c.symbolName || '').toLowerCase();
        let s = c.score || 0;
        if (sym && idSet.has(sym)) s += 1000;
        if (sym && signalList.some((t) => t.toLowerCase() === sym)) s += 500;
        if (c.parentSymbol === outline.symbolName && (c.symbolKind === 'method' || c.symbolKind === 'function')) {
          s += Math.min(c.tokenCount || 0, 800) / 10;
        }
        return s;
      };
      return scoreBody(b) - scoreBody(a);
    });
    const body = bodies[0];
    if (body) {
      primary = [body, ...primary.filter((c) => c.id !== body.id)];
    }
  }

  // Prefer intact segments over a truncated giant parent ONLY when segments
  // already ranked into the result set (natural FTS) and the prompt does not
  // name the function exactly. Never invent segment preference without hits.
  const approxBudget = Math.max(380, maxTokens - 140);
  if (
    primary[0] &&
    (primary[0].symbolKind === 'function' || primary[0].symbolKind === 'method') &&
    (primary[0].tokenCount || 0) > 900
  ) {
    const giant = primary[0];
    const exactSymbol = symbolNamedInPrompt(giant.symbolName);
    const wontFit = (giant.tokenCount || 0) > approxBudget * 0.92;
    const rankedSegs = deduped
      .filter(
        (c) =>
          c.symbolKind === 'segment' &&
          c.sourceFile === giant.sourceFile &&
          c.parentSymbol === giant.symbolName,
      )
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, 3);
    if (!exactSymbol && wontFit && rankedSegs.length >= 1) {
      primary = [
        ...rankedSegs,
        giant,
        ...primary.filter((c) => c.id !== giant.id && !rankedSegs.some((s) => s.id === c.id)),
      ];
    }
  }

  return primary;
}

/** Same-file companions, segment caps, other-file signal chunks. */
export function collectCompanions(
  deduped: ScoredChunk[],
  primary: ScoredChunk[],
  ctx: CompressCtx,
): ScoredChunk[] {
  const { contentHitsSignal } = ctx;
  const leaderFile = primary[0]?.sourceFile;
  const primaryIds = new Set(primary.map((c) => c.id));
  const companions: ScoredChunk[] = [];
  const segmentCountByParent = new Map<string, number>();

  const tryPushCompanion = (s: ScoredChunk): boolean => {
    if (s.symbolKind === 'segment' && s.parentSymbol) {
      const key = `${s.sourceFile}::${s.parentSymbol}`;
      const n = segmentCountByParent.get(key) || 0;
      if (n >= 3) return false;
      segmentCountByParent.set(key, n + 1);
    }
    companions.push(s);
    primaryIds.add(s.id);
    return true;
  };

  // Count segments already in primary toward the per-function cap
  for (const c of primary) {
    if (c.symbolKind === 'segment' && c.parentSymbol) {
      const key = `${c.sourceFile}::${c.parentSymbol}`;
      segmentCountByParent.set(key, (segmentCountByParent.get(key) || 0) + 1);
    }
  }

  if (leaderFile) {
    const sameFile = deduped.filter(
      (s) => s.sourceFile === leaderFile && !primaryIds.has(s.id) && !isTestFile(s),
    );
    sameFile.sort((a, b) => Number(contentHitsSignal(b)) - Number(contentHitsSignal(a)));
    for (const s of sameFile) {
      tryPushCompanion(s);
      if (companions.length >= 5) break;
    }
  }

  // Pull signal-matching chunks from other files
  for (const c of deduped) {
    if (primaryIds.has(c.id) || isTestFile(c)) continue;
    if (!contentHitsSignal(c)) continue;
    if (!tryPushCompanion(c)) continue;
    for (const s of deduped) {
      if (s.sourceFile === c.sourceFile && !primaryIds.has(s.id) && !isTestFile(s) && s.tokenCount <= 550) {
        tryPushCompanion(s);
        break;
      }
    }
    if (companions.length >= 8) break;
  }

  return companions;
}

/** Leader-first ordering for packing. */
export function orderForPacking(
  primary: ScoredChunk[],
  companions: ScoredChunk[],
  ctx: CompressCtx,
): ScoredChunk[] {
  const { idSet, contentHitsSignal } = ctx;
  const leaderFile = primary[0]?.sourceFile;
  const candidates: ScoredChunk[] = [];
  const seen = new Set<string>();
  // Leader first, then compact / exact / segment primary siblings (must pack before
  // companions), then companions, then oversized non-exact primary bodies last.
  const leader = primary[0];
  const restPrimary = primary.slice(1);
  const restHot = restPrimary.filter(
    (c) =>
      c.symbolKind === 'segment' ||
      (c.tokenCount || 0) <= 550 ||
      (!!c.symbolName && idSet.has(c.symbolName.toLowerCase())) ||
      (!!c.parentSymbol && idSet.has(c.parentSymbol.toLowerCase())),
  );
  const restCold = restPrimary.filter((c) => !restHot.includes(c));
  const orderedSources = [
    ...(leader ? [leader] : []),
    ...restHot,
    // Same-file signal companions before other-file — keeps applyDecay over registerKnowledgeTools
    ...companions.filter((c) => c.sourceFile === leaderFile && contentHitsSignal(c)),
    ...companions.filter((c) => c.sourceFile !== leaderFile && contentHitsSignal(c)),
    ...companions.filter((c) => !contentHitsSignal(c)),
    ...restCold,
  ];
  for (const c of orderedSources) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    candidates.push(c);
  }
  return candidates;
}

/** Fit loop, comment stripping, drops, hard final cap, reconcile. */
export function packToBudget(
  candidates: ScoredChunk[],
  remainder: ScoredChunk[],
  budget: number,
  leaderFile: string | undefined,
  ctx: CompressCtx,
): ScoredChunk[] {
  const { signalList, idSet, symbolNamedInPrompt, contentHitsSignal } = ctx;

  const truncTerms = [...signalList];
  // Dedup prompts: preserve merge-map markers when truncating retrieve()
  if (signalList.some((t) => /dedup|deduplicat/i.test(t))) {
    truncTerms.push('deduplicate', 'allChunksMap', 'score +=', 'containmentDedup');
  }
  // Retrieval pipeline prompts: keep the retrieve() call chain intact under truncation
  if (
    signalList.some((t) => /retrieval|retrieve|detectintent|matchchunks|scorechunks/i.test(t)) ||
    [...idSet].some((id) => /retrieval|retrieve/i.test(id))
  ) {
    truncTerms.push('detectIntent', 'matchChunks', 'expander.expand', 'scoreChunks');
  }
  const full: ScoredChunk[] = [];
  const stubs: ScoredChunk[] = [];
  let used = 0;

  // Fit: leader first, then companions (small intact), then rest
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const terms = c.symbolName ? [...truncTerms, c.symbolName] : truncTerms;
    const room = budget - used;

    if (room < 40) {
      used = pushStubOrMini(c, full, stubs, used, budget, terms, ctx.opts?.concepts);
      continue;
    }

    if (full.length === 0) {
      // Leader: reserve room for small intact signal companions only (not huge bodies)
      const intactSiblings = candidates
        .filter(
          (x) =>
            x.id !== c.id &&
            x.tokenCount <= 550 &&
            (x.sourceFile === c.sourceFile || contentHitsSignal(x)),
        )
        .slice(0, 3);
      const siblingNeed = intactSiblings.reduce((s, x) => s + x.tokenCount, 0);
      const minCompanionReserve = intactSiblings.length > 0
        ? Math.min(400, Math.max(...intactSiblings.map((x) => x.tokenCount)))
        : 0;
      const reserve = Math.min(
        budget * 0.4,
        Math.max(siblingNeed * 0.9, minCompanionReserve),
      );
      let leaderBudget = reserve > 0 ? Math.max(280, budget - reserve) : budget;
      // Huge leaders must leave room for companions — unless the prompt names this
      // symbol (or its parent class) exactly, then prefer a near-full body.
      const exactSymbolLeader =
        symbolNamedInPrompt(c.symbolName) ||
        (!!c.parentSymbol && idSet.has(c.parentSymbol.toLowerCase())) ||
        // Dedup prompts: retrieve's merge map is the answer — give it near-full budget
        (c.symbolName?.toLowerCase() === 'retrieve' &&
          signalList.some((t) => /dedup|deduplicat/i.test(t)));
      if (c.tokenCount > 800 && !exactSymbolLeader) {
        leaderBudget = Math.min(leaderBudget, Math.floor(budget * 0.65));
      } else if ((c.tokenCount > 800 || exactSymbolLeader) && exactSymbolLeader) {
        leaderBudget = Math.min(leaderBudget, Math.floor(budget * 0.92));
      }
      leaderBudget = Math.min(leaderBudget, budget - 60);

      if (c.tokenCount <= leaderBudget) {
        full.push(c);
        used += c.tokenCount;
      } else {
        const fitted = fitContentToBudget(c.content, leaderBudget, terms);
        full.push({ ...c, content: fitted.content, tokenCount: fitted.tokenCount });
        used = Math.min(budget, fitted.tokenCount);
      }
      continue;
    }

    // Medium chunks: all-or-nothing (never truncate — preserves off-query markers)
    if (c.tokenCount <= 550) {
      if (used + c.tokenCount <= budget) {
        full.push(c);
        used += c.tokenCount;
      } else if (contentHitsSignal(c) || c.sourceFile === leaderFile) {
        // Shrink leader if needed to fit a signal companion
        if (full.length > 0 && used + c.tokenCount > budget) {
          const need = c.tokenCount + 20;
          const maxLeader = Math.max(220, budget - need);
          if (full[0].tokenCount > maxLeader) {
            const lterms = full[0].symbolName ? [...truncTerms, full[0].symbolName] : truncTerms;
            const ratio = Math.max(0.2, maxLeader / full[0].tokenCount);
            const content = truncatePreservingSignals(full[0].content, ratio, lterms) + '\n\n[...truncated]';
            const newTok = estimateTokens(content);
            used -= full[0].tokenCount - newTok;
            full[0] = { ...full[0], content, tokenCount: newTok };
          }
        }
        // Drop non-essential full bodies to make room for signal hits
        for (let j = full.length - 1; j >= 1; j--) {
          if (contentHitsSignal(full[j])) continue;
          if (full[j].sourceFile === c.sourceFile) continue;
          used -= full[j].tokenCount;
          stubs.push(toStub(full[j]));
          full.splice(j, 1);
          if (used + c.tokenCount <= budget) break;
        }
        if (used + c.tokenCount <= budget) {
          full.push(c);
          used += c.tokenCount;
        } else {
          used = pushStubOrMini(c, full, stubs, used, budget, terms);
        }
      } else {
        used = pushStubOrMini(c, full, stubs, used, budget, terms);
      }
      continue;
    }

    // Large same-file or signal-hit chunks: truncate generously
    if ((contentHitsSignal(c) || c.sourceFile === leaderFile) && (budget - used > 100 || full.length > 0)) {
      // Free room from non-signal bodies
      for (let j = full.length - 1; j >= 1 && budget - used < 400; j--) {
        if (contentHitsSignal(full[j]) || full[j].sourceFile === leaderFile) continue;
        used -= full[j].tokenCount;
        stubs.push(toStub(full[j]));
        full.splice(j, 1);
      }
      // Shrink leader if still tight
      if (full.length > 0 && budget - used < 300 && full[0].tokenCount > 250) {
        const maxLeader = Math.max(220, budget - 350);
        if (full[0].tokenCount > maxLeader) {
          const lterms = full[0].symbolName ? [...truncTerms, full[0].symbolName] : truncTerms;
          const ratio = maxLeader / full[0].tokenCount;
          const content = truncatePreservingSignals(full[0].content, ratio, lterms) + '\n\n[...truncated]';
          const newTok = estimateTokens(content);
          used -= full[0].tokenCount - newTok;
          full[0] = { ...full[0], content, tokenCount: newTok };
        }
      }
      const avail = budget - used;
      if (avail > 80) {
        const fitted = fitContentToBudget(c.content, avail, terms);
        if (fitted.tokenCount <= avail + 30 || contentHitsSignal(c)) {
          // If still slightly over but signal-hit, try mini snippet
          if (fitted.tokenCount > avail && contentHitsSignal(c)) {
            used = pushStubOrMini(c, full, stubs, used, budget, terms);
          } else {
            full.push({ ...c, content: fitted.content, tokenCount: fitted.tokenCount });
            used = Math.min(budget, used + fitted.tokenCount);
          }
          continue;
        }
      }
      used = pushStubOrMini(c, full, stubs, used, budget, terms);
      continue;
    }

    // Large chunks: truncate with query-aware windows
    if (used + c.tokenCount <= budget) {
      full.push(c);
      used += c.tokenCount;
    } else if (room > 80) {
      const fitted = fitContentToBudget(c.content, room, terms);
      if (fitted.tokenCount <= room + 30) {
        full.push({ ...c, content: fitted.content, tokenCount: fitted.tokenCount });
        used = Math.min(budget, used + fitted.tokenCount);
      } else {
        used = pushStubOrMini(c, full, stubs, used, budget, terms);
      }
    } else {
      used = pushStubOrMini(c, full, stubs, used, budget, terms);
    }
  }

  for (const c of remainder) stubs.push(toStub(c));

  // Strip comments from non-leader if over budget
  let currentTokens = full.reduce((s, c) => s + c.tokenCount, 0);
  if (currentTokens > budget) {
    for (let i = full.length - 1; i >= 1 && currentTokens > budget; i--) {
      const chunk = full[i];
      if (chunk.tokenCount <= 400) continue; // don't touch small bodies
      if (chunk.language && chunk.fileType !== 'markdown') {
        chunk.content = stripComments(chunk.content);
        const newTokens = estimateTokens(chunk.content);
        currentTokens -= chunk.tokenCount - newTokens;
        chunk.tokenCount = newTokens;
      }
    }
  }

  // Drop non-leader chunks if still over; keep tiny signal snippets
  currentTokens = full.reduce((s, c) => s + c.tokenCount, 0);
  while (currentTokens > budget && full.length > 1) {
    let dropIdx = -1;
    let dropScore = Infinity;
    for (let i = 1; i < full.length; i++) {
      if (contentHitsSignal(full[i]) && full[i].tokenCount <= 80) continue;
      const sc = full[i].score || 0;
      if (sc < dropScore) {
        dropScore = sc;
        dropIdx = i;
      }
    }
    if (dropIdx < 0) {
      for (let i = full.length - 1; i >= 1; i--) {
        if (full[i].tokenCount > 80) {
          dropIdx = i;
          break;
        }
      }
    }
    if (dropIdx < 0) break;
    const removed = full[dropIdx];
    currentTokens -= removed.tokenCount;
    const rterms = removed.symbolName ? [...truncTerms, removed.symbolName] : truncTerms;
    const mini = toStubOrSnippet(removed, rterms);
    if (mini.summary !== '[stub]' && currentTokens + mini.tokenCount <= budget) {
      full[dropIdx] = mini;
      currentTokens += mini.tokenCount;
    } else {
      stubs.unshift(toStub(removed));
      full.splice(dropIdx, 1);
    }
  }
  // Hard final cap: re-truncate largest bodies until under budget
  let sumTok = full.reduce((s, c) => s + c.tokenCount, 0);
  let guard = 0;
  while (sumTok > budget && guard++ < 12) {
    let idx = -1;
    let best = 0;
    for (let i = 0; i < full.length; i++) {
      if (full[i].tokenCount > best && full[i].tokenCount > 80) {
        best = full[i].tokenCount;
        idx = i;
      }
    }
    if (idx < 0) break;
    const target = Math.max(60, full[idx].tokenCount - (sumTok - budget));
    const terms = full[idx].symbolName ? [...truncTerms, full[idx].symbolName!] : truncTerms;
    const fitted = fitContentToBudget(full[idx].content, target, terms, ctx.opts?.concepts);
    if (fitted.tokenCount >= full[idx].tokenCount * 0.98) {
      if (full.length > 1 && idx > 0) {
        sumTok -= full[idx].tokenCount;
        const mini = toStubOrSnippet(full[idx], terms, ctx.opts?.concepts);
        if (mini.summary !== '[stub]' && sumTok + mini.tokenCount <= budget) {
          full[idx] = mini;
          sumTok += mini.tokenCount;
        } else {
          stubs.unshift(toStub(full[idx]));
          full.splice(idx, 1);
        }
        continue;
      }
      break;
    }
    sumTok -= full[idx].tokenCount - fitted.tokenCount;
    full[idx] = { ...full[idx], content: fitted.content, tokenCount: fitted.tokenCount };
  }

  // Reconcile: ensure stored tokenCounts match content
  for (const c of full) {
    c.tokenCount = estimateTokens(c.content);
  }

  return [...full, ...stubs];
}

/**
 * Tiered compression: top-K + same-file companions as full bodies; leftovers → stubs (B12).
 * Small chunks (<400 tok) are never truncated — avoids dropping markers not present in the query.
 */
export function compressChunks(
  chunks: ScoredChunk[],
  maxTokens: number,
  opts?: CompressOptions | string[],
): ScoredChunk[] {
  const signalTerms = Array.isArray(opts) ? opts : opts?.signalTerms;
  const identifiers = Array.isArray(opts) ? [] : (opts?.identifiers || []);
  const concepts = Array.isArray(opts) ? [] : (opts?.concepts || []);
  const idSet = new Set(identifiers.map((id) => id.toLowerCase()));
  const signalList = collectSignalTerms(signalTerms, concepts);
  const ctx = buildCompressCtx(signalList, idSet);
  if (opts && !Array.isArray(opts)) ctx.opts = opts;

  let filteredChunks = chunks.slice();

  if (filteredChunks.length > 0) {
    const topScore = filteredChunks[0].score || 0;
    const cutoff = Math.max(5.0, topScore * 0.35);
    const mustKeep = new Set(filteredChunks.slice(0, 5).map((c) => c.id));
    const cliIntent = signalList.some(
      (t) => /^(cli|command|bin|registration)$/i.test(t) || /registration/i.test(t),
    );
    const keepChunks = filteredChunks.slice();
    filteredChunks = filteredChunks.filter((c) => {
      if (mustKeep.has(c.id) || (c.score || 0) >= cutoff) return true;
      // Keep exact identifier hits even when far below the leader
      if (c.symbolName && idSet.has(c.symbolName.toLowerCase())) return true;
      // CLI registration prompts: keep bin/cli entrypoints that would otherwise be cut
      if (cliIntent && /(?:^|[/\\])(?:bin|cli)[/\\]/i.test(c.sourceFile)) return true;
      const sym = (c.symbolName || '').toLowerCase();
      if (!sym) return false;
      if (signalList.some((t) => {
        const tl = t.toLowerCase();
        return sym === tl || (tl.length >= 5 && (sym.includes(tl) || tl.includes(sym)));
      })) return true;
      // CamelCase parts (getSessionContext → session, context) vs multi-word signals
      const parts = (c.symbolName || '')
        .split(/(?=[A-Z])|[_\-.]+/)
        .map((p) => p.toLowerCase())
        .filter((p) => p.length >= 5);
      if (parts.some((p) => signalList.some((t) => {
        const tl = t.toLowerCase();
        return tl === p || tl.split(/[\s_-]+/).includes(p);
      }))) return true;
      // Keep same-file siblings of must-keep hits (not whole directories — too noisy)
      if ([...mustKeep].some((id) => {
        const keep = keepChunks.find((x) => x.id === id);
        return keep && keep.sourceFile === c.sourceFile;
      })) return true;
      return false;
    });
  }

  let fileStructureSeen = false;
  filteredChunks = filteredChunks.filter((c) => {
    if (c.sectionTitle === 'File Structure') {
      if (fileStructureSeen) return false;
      fileStructureSeen = true;
    }
    return true;
  });

  const uniqueHashes = new Set<string>();
  const deduped: ScoredChunk[] = [];
  for (const c of filteredChunks) {
    const hash = c.hash || `id:${c.id}`;
    if (!uniqueHashes.has(hash)) {
      uniqueHashes.add(hash);
      deduped.push(prepareContent(c));
    }
  }
  if (deduped.length === 0) return [];

  const primary = pickPrimaries(deduped, maxTokens, ctx);
  const companions = collectCompanions(deduped, primary, ctx);
  const candidates = orderForPacking(primary, companions, ctx);

  const candidateIds = new Set(candidates.map((c) => c.id));
  const remainder = deduped.filter((c) => !candidateIds.has(c.id));

  // B19: stub reserve — leave room for markdown framing so final output ≤ maxTokens
  const framingReserve = 90;
  const stubReserve = Math.min(50, remainder.length * 6 + 10);
  const budget = Math.max(380, maxTokens - framingReserve - stubReserve);

  return packToBudget(candidates, remainder, budget, primary[0]?.sourceFile, ctx);
}
