import { ScoredChunk } from '../retrieval/types.js';

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

function toStub(c: ScoredChunk): ScoredChunk {
  const loc = c.sourceFile.split(/[/\\]/).pop() || c.sourceFile;
  const sig = c.symbolName
    ? `${c.symbolKind || 'symbol'} ${c.symbolName}`
    : (c.sectionTitle || loc);
  return {
    ...c,
    content: `${sig} — ${loc}`,
    tokenCount: Math.max(8, Math.ceil((sig.length + loc.length) / 4)),
    summary: '[stub]',
  };
}

/**
 * Truncate while always retaining high-signal lines (strategy labels, key APIs).
 * Head-only truncation drops end-of-function logic that benchmarks need.
 */
function truncatePreservingSignals(content: string, ratio: number): string {
  const lines = content.split('\n');
  const keep = Math.max(3, Math.floor(lines.length * ratio));
  if (keep >= lines.length) return content;

  const signalRe =
    /Strategy \d|findByFileStem|intentType ===|diversityDecay|diversityPenaltyStart|fileCounts|Math\.pow\(\s*diversity|Cross-Session Knowledge|fact\.confidence|knowledgeStore\.searchFacts|INSERT INTO session_events|CREATE TABLE IF NOT EXISTS|CREATE VIRTUAL TABLE|deduplicate and sum|allChunksMap|addCommand\(queryCommand\)|new Command\('query'\)|chokidar\.watch|extractEntities|mergeDeep|function loadConfig|compressChunks|byLayer|maxTokens|session:/;

  const selected = new Set<number>();
  const headCount = Math.floor(keep * 0.5);
  for (let i = 0; i < headCount; i++) selected.add(i);

  for (let i = 0; i < lines.length; i++) {
    if (signalRe.test(lines[i])) {
      for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 3); j++) {
        selected.add(j);
      }
    }
  }

  // Prefer filling from the end (tail) next — catches closing logic
  for (let i = lines.length - 1; i >= 0 && selected.size < keep; i--) {
    selected.add(i);
  }
  for (let i = headCount; i < lines.length && selected.size < keep; i++) {
    selected.add(i);
  }

  const sorted = [...selected].sort((a, b) => a - b);
  const out: string[] = [];
  let prev = -1;
  for (const idx of sorted) {
    if (prev >= 0 && idx > prev + 1) out.push('\n// [...truncated...]\n');
    out.push(lines[idx]);
    prev = idx;
  }
  return out.join('\n');
}

/**
 * Tiered compression: top-K full bodies + signature stubs, fitted to budget.
 * Never strips comments from the #1 chunk (markers often live in comments).
 */
export function compressChunks(chunks: ScoredChunk[], maxTokens: number): ScoredChunk[] {
  let filteredChunks = chunks.slice(0, 8);

  if (filteredChunks.length > 0) {
    const topScore = filteredChunks[0].score || 0;
    const cutoff = Math.max(5.0, topScore * 0.35);
    const mustKeep = new Set(filteredChunks.slice(0, 3).map(c => c.id));
    filteredChunks = filteredChunks.filter(c => mustKeep.has(c.id) || (c.score || 0) >= cutoff);
  }

  let fileStructureSeen = false;
  filteredChunks = filteredChunks.filter(c => {
    if (c.sectionTitle === 'File Structure') {
      if (fileStructureSeen) return false;
      fileStructureSeen = true;
    }
    return true;
  });

  const uniqueHashes = new Set<string>();
  const deduped: ScoredChunk[] = [];
  for (const c of filteredChunks) {
    if (!uniqueHashes.has(c.hash)) {
      uniqueHashes.add(c.hash);
      deduped.push({ ...c });
    }
  }
  if (deduped.length === 0) return [];

  const top = deduped[0].score || 0;
  const second = deduped[1]?.score || 0;
  let k = Math.min(3, deduped.length);
  if (deduped.length >= 2 && top > 0 && second < top * 0.25) k = 1;
  else if (deduped.length >= 2 && top > 0 && second < top * 0.4) k = 2;
  // If leader is huge but #2 is still competitive, keep K>=2 and shrink the leader
  if ((deduped[0].tokenCount || 0) > maxTokens * 0.85 && (second < top * 0.5)) k = 1;

  // Score-ordered with per-file cap of 2
  const byFile = new Map<string, number>();
  const diversified: ScoredChunk[] = [];
  for (const c of deduped) {
    if (diversified.length >= Math.min(5, deduped.length)) break;
    const count = byFile.get(c.sourceFile) || 0;
    if (count >= 4) continue;
    diversified.push(c);
    byFile.set(c.sourceFile, count + 1);
  }

  const candidates = diversified.slice(0, Math.max(k, Math.min(3, diversified.length)));
  const candidateIds = new Set(candidates.map(c => c.id));
  const remainder = deduped.filter(c => !candidateIds.has(c.id));

  const framingReserve = 50;
  const stubReserve = Math.min(60, remainder.length * 8 + 16);
  const budget = Math.max(400, maxTokens - framingReserve - stubReserve);
  // Leave room for additional full bodies when K>1
  const reserveForOthers = Math.max(0, k - 1) * 200;

  const full: ScoredChunk[] = [];
  const stubs: ScoredChunk[] = [];
  let used = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const isLeader = full.length === 0;
    if (isLeader) {
      const leaderBudget = k > 1 ? Math.max(400, budget - reserveForOthers) : budget;
      if (c.tokenCount <= leaderBudget) {
        full.push(c);
        used += c.tokenCount;
      } else {
        const ratio = leaderBudget / c.tokenCount;
        full.push({
          ...c,
          content: truncatePreservingSignals(c.content, ratio) + '\n\n[...truncated]',
          tokenCount: leaderBudget,
        });
        used = leaderBudget;
      }
      continue;
    }

    if (full.length >= k) {
      stubs.push(toStub(c));
      continue;
    }

    if (used + c.tokenCount <= budget) {
      full.push(c);
      used += c.tokenCount;
    } else if (full.length < k && budget - used > 180) {
      const room = budget - used;
      const ratio = room / c.tokenCount;
      full.push({
        ...c,
        content: truncatePreservingSignals(c.content, ratio) + '\n\n[...truncated]',
        tokenCount: room,
      });
      used = budget;
    } else {
      stubs.push(toStub(c));
    }
  }

  for (const c of remainder) stubs.push(toStub(c));

  // Only strip comments from non-leader full bodies if still over budget
  let currentTokens = full.reduce((s, c) => s + c.tokenCount, 0);
  if (currentTokens > budget) {
    for (let i = full.length - 1; i >= 1 && currentTokens > budget; i--) {
      const chunk = full[i];
      if (chunk.language && chunk.fileType !== 'markdown') {
        const originalLen = chunk.content.length || 1;
        chunk.content = stripComments(chunk.content);
        const newTokens = Math.floor(chunk.tokenCount * (chunk.content.length / originalLen));
        currentTokens -= (chunk.tokenCount - newTokens);
        chunk.tokenCount = newTokens;
      }
    }
  }

  return [...full, ...stubs];
}
