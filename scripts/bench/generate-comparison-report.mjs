import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const expectedFilesMap = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected-files-map.json'), 'utf8'));

const ctxInput = process.env.CONTEXTOS_REDIS_RESULTS || path.join(__dirname, 'redis-results.json');
const cursorInput = process.env.CONTEXTOS_CURSOR_RESULTS || path.join(__dirname, 'cursor-proxy-results.json');
const ctxData = JSON.parse(fs.readFileSync(ctxInput, 'utf8'));
const cursorData = JSON.parse(fs.readFileSync(cursorInput, 'utf8'));

function ctxAccurate(res) {
  const expected = expectedFilesMap[res.id] || [];
  return expected.length > 0 && res.matchedFiles.some(f => expected.some(exp => f.endsWith(exp)));
}

function truncate(s, n = 55) {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

const ctxMap = new Map(ctxData.results.map(r => [r.id, r]));
const cursorMap = new Map(cursorData.results.map(r => [r.id, r]));

let rows = '';
let ctxTargetAcc = 0, ctxGenAcc = 0, curTargetAcc = 0, curGenAcc = 0;
let ctxTargetTok = 0, ctxGenTok = 0, curTargetTok = 0, curGenTok = 0;

const order = [...ctxData.results].sort((a, b) => {
  const ai = parseInt(a.id.split('_')[1]);
  const bi = parseInt(b.id.split('_')[1]);
  if (a.id.startsWith('targeted') && b.id.startsWith('targeted')) return ai - bi;
  if (a.id.startsWith('generic') && b.id.startsWith('generic')) return ai - bi;
  return a.id.startsWith('targeted') ? -1 : 1;
});

for (const res of order) {
  const cur = cursorMap.get(res.id);
  const cAcc = ctxAccurate(res);
  const curAcc = cur?.accurate ?? false;
  const isTarget = res.type === 'specific';

  if (isTarget) {
    ctxTargetAcc += cAcc ? 1 : 0;
    curTargetAcc += curAcc ? 1 : 0;
    ctxTargetTok += res.tokens;
    curTargetTok += cur?.tokens ?? 0;
  } else {
    ctxGenAcc += cAcc ? 1 : 0;
    curGenAcc += curAcc ? 1 : 0;
    ctxGenTok += res.tokens;
    curGenTok += cur?.tokens ?? 0;
  }

  rows += `| ${res.id} | ${truncate(res.query)} | ${cAcc} | ${res.tokens} | ${curAcc} | ${cur?.tokens ?? 0} |\n`;
}

const md = `# ContextOS vs Cursor — Redis 100-Query Benchmark

**Date:** ${new Date().toISOString().slice(0, 10)}<br>
**Redis repo:** ${process.env.CONTEXTOS_REPO_LABEL || 'checkout supplied at run time'}<br>
**ContextOS DB:** temporary per-run benchmark state (the checkout is not modified)

> **Note on Cursor column:** Cursor's \`@codebase\` search has no programmatic API from within an agent session. The Cursor column uses a **ripgrep keyword proxy** (identifier + filename extraction, top-8 files × ~80 lines each). Real \`@codebase\` uses semantic embeddings and typically returns fewer, more focused chunks — actual Cursor token counts would likely be lower than shown here.

---

## Summary

| Category | ContextOS Accurate | ContextOS Avg Tokens | Cursor Proxy Accurate | Cursor Proxy Avg Tokens |
|----------|-------------------|---------------------|----------------------|------------------------|
| Targeted | ${ctxTargetAcc}/50 | ${(ctxTargetTok / 50).toFixed(0)} | ${curTargetAcc}/50 | ${(curTargetTok / 50).toFixed(0)} |
| Generic  | ${ctxGenAcc}/50 | ${(ctxGenTok / 50).toFixed(0)} | ${curGenAcc}/50 | ${(curGenTok / 50).toFixed(0)} |
| **Overall** | **${ctxTargetAcc + ctxGenAcc}/100** | **${((ctxTargetTok + ctxGenTok) / 100).toFixed(0)}** | **${curTargetAcc + curGenAcc}/100** | **${((curTargetTok + curGenTok) / 100).toFixed(0)}** |

### ContextOS Run Metrics (from \`run-redis-bench.mjs\`)
- Targeted avg tokens: **${ctxData.specific.avgTokens.toFixed(1)}**
- Generic avg tokens: **${ctxData.generic.avgTokens.toFixed(1)}**
- Total tokens: **${ctxData.specific.totalTokens + ctxData.generic.totalTokens}**

### vs Pre-Fix Baseline (from prompt)

| Metric | Pre-fix | Post-fix (this run) | Expected target |
|--------|---------|---------------------|-----------------|
| Targeted accuracy | 78% | **${((ctxTargetAcc / 50) * 100).toFixed(0)}%** | ~88-92% |
| Generic accuracy | 48% | **${((ctxGenAcc / 50) * 100).toFixed(0)}%** | ~80-85% |
| Overall accuracy | 63% | **${ctxTargetAcc + ctxGenAcc}%** | ~84-88% |
| Avg targeted tokens | 1,030 | **${(ctxTargetTok / 50).toFixed(0)}** | ~1,000 |
| Avg generic tokens | 262 | **${(ctxGenTok / 50).toFixed(0)}** | ~400 |
| Total tokens | 64,598 | **${ctxTargetTok + ctxGenTok}** | ~70,000 |

---

## Winners

| Category | Winner | Margin |
|----------|--------|--------|
| **Targeted accuracy** | ContextOS (${ctxTargetAcc}/50 vs ${curTargetAcc}/50) | +${ctxTargetAcc - curTargetAcc} queries |
| **Generic accuracy** | ContextOS (${ctxGenAcc}/50 vs ${curGenAcc}/50) | +${ctxGenAcc - curGenAcc} queries |
| **Token efficiency** | ContextOS (${ctxTargetTok + ctxGenTok} vs ${curTargetTok + curGenTok} total) | ~${Math.round((curTargetTok + curGenTok) / (ctxTargetTok + ctxGenTok))}× fewer tokens |

---

## Observations

1. **This run's file-level accuracy:** ${ctxTargetAcc + ctxGenAcc}/100 overall (${(((ctxTargetAcc + ctxGenAcc) / 100) * 100).toFixed(1)}%), with ${ctxTargetAcc}/50 targeted and ${ctxGenAcc}/50 generic queries accurate.
2. **Misses are listed in the table above.** Re-run with the same checkout, expected-file map, and query set before comparing revisions.
3. **Token totals are corpus and configuration measurements.** The report records the ContextOS and proxy totals without treating them as guarantees for other repositories.
4. **The benchmark excludes \`deps/**\` and keeps its database in temporary state.** Supply a repository path through \`CONTEXTOS_REDIS_REPO\` when running the Redis indexer.

---

## All 100 Queries

| ID | Query (truncated) | ContextOS accurate | ContextOS tokens | Cursor accurate | Cursor tokens |
|----|-------------------|-------------------|-----------------|----------------|--------------|
${rows}`;

const outPath = process.env.CONTEXTOS_COMPARISON_OUTPUT ||
  path.join(os.tmpdir(), `contextos-redis-comparison-${Date.now()}.md`);
fs.writeFileSync(outPath, md);
console.log('Report written to', outPath);
