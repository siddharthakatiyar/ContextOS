/**
 * Proxy for Cursor @codebase search on Redis repo.
 * Uses ripgrep keyword search + identifier extraction (no semantic embeddings).
 * Scoped to redis/src, excludes deps/, tools/, modules/.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REDIS = '/Volumes/ExtremeSSD/code/redis';
const SRC = path.join(REDIS, 'src');
const CONTEXT_LINES = 40;
const MAX_FILES = 8;
const MAX_BYTES_PER_FILE = 6000;

const { estimateTokens } = await import('../../dist/src/utils/tokens.js');

const expectedFilesMap = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'expected-files-map.json'), 'utf8')
);

const queries = JSON.parse(fs.readFileSync(path.join(__dirname, 'redis-bench.json'), 'utf8'));

function extractSearchTerms(query) {
  const terms = new Set();
  // backtick identifiers
  for (const m of query.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g)) terms.add(m[1]);
  // file.c / file.h references
  for (const m of query.matchAll(/\b([a-zA-Z_][\w.-]*\.[ch])\b/g)) terms.add(m[1]);
  // CamelCase / snake_case identifiers (3+ chars)
  for (const m of query.matchAll(/\b([a-z][a-zA-Z0-9]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g)) {
    const w = m[1];
    if (!['How', 'What', 'Where', 'When', 'The', 'Redis', 'In', 'And', 'For', 'Are', 'Does', 'With'].includes(w)) {
      terms.add(w);
    }
  }
  return [...terms].slice(0, 6);
}

function rgSearch(term) {
  try {
    const out = execSync(
      `rg -l --no-heading --glob '*.c' --glob '*.h' --glob '!deps/**' --glob '!**/test/**' ${JSON.stringify(term)} ${JSON.stringify(SRC)}`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
    );
    return out.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readMatchContext(filePath, terms) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let bestLine = 0;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      let score = 0;
      for (const t of terms) {
        if (lines[i].includes(t)) score += t.length;
      }
      if (score > bestScore) {
        bestScore = score;
        bestLine = i;
      }
    }
    const start = Math.max(0, bestLine - CONTEXT_LINES);
    const end = Math.min(lines.length, bestLine + CONTEXT_LINES);
    const snippet = lines.slice(start, end).join('\n');
    return snippet.slice(0, MAX_BYTES_PER_FILE);
  } catch {
    return '';
  }
}

const results = [];
let targetedTokens = 0, genericTokens = 0;
let targetedAcc = 0, genericAcc = 0;

for (const q of queries) {
  const terms = extractSearchTerms(q.query);
  const fileScores = new Map();

  for (const term of terms) {
    for (const f of rgSearch(term)) {
      fileScores.set(f, (fileScores.get(f) || 0) + term.length);
    }
  }

  const ranked = [...fileScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FILES);
  const matchedFiles = ranked.map(([f]) => f);
  let resText = '';
  for (const [f] of ranked) {
    const snippet = readMatchContext(f, terms);
    if (snippet) resText += `\n--- ${path.basename(f)} ---\n${snippet}\n`;
  }
  resText = resText.slice(0, 40000);
  const tokens = estimateTokens(resText);

  const expected = expectedFilesMap[q.id] || [];
  const accurate = expected.length > 0 && matchedFiles.some(f => expected.some(exp => f.endsWith(exp)));

  if (q.type === 'specific') {
    targetedTokens += tokens;
    if (accurate) targetedAcc++;
  } else {
    genericTokens += tokens;
    if (accurate) genericAcc++;
  }

  results.push({
    id: q.id,
    type: q.type,
    query: q.query,
    tokens,
    accurate,
    matchedFiles,
    terms,
    resText: resText.slice(0, 2000),
  });
}

const report = {
  note: 'Proxy benchmark using ripgrep keyword search (not Cursor semantic @codebase)',
  totalQueries: queries.length,
  specific: { count: 50, accurate: targetedAcc, avgTokens: targetedTokens / 50, totalTokens: targetedTokens },
  generic: { count: 50, accurate: genericAcc, avgTokens: genericTokens / 50, totalTokens: genericTokens },
  results,
};

const outFile = path.join(__dirname, 'cursor-proxy-results.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
console.log('Cursor proxy benchmark complete');
console.log(`Targeted: ${targetedAcc}/50 accurate, avg ${(targetedTokens / 50).toFixed(0)} tokens`);
console.log(`Generic:  ${genericAcc}/50 accurate, avg ${(genericTokens / 50).toFixed(0)} tokens`);
console.log(`Total tokens: ${targetedTokens + genericTokens}`);
console.log(`Saved to ${outFile}`);
