import fs from 'fs';

const data = JSON.parse(fs.readFileSync('scripts/bench/redis-results.json', 'utf8'));
const results = data.results;

const eval1 = JSON.parse(fs.readFileSync('scripts/bench/eval_0_19.json', 'utf8'));
const eval2 = JSON.parse(fs.readFileSync('scripts/bench/eval_20_39.json', 'utf8'));
const eval3 = JSON.parse(fs.readFileSync('scripts/bench/eval_40_59.json', 'utf8'));
const eval4 = JSON.parse(fs.readFileSync('scripts/bench/eval_60_79.json', 'utf8'));
const eval5 = JSON.parse(fs.readFileSync('scripts/bench/eval_80_99.json', 'utf8'));

const allEvals = [...eval1, ...eval2, ...eval3, ...eval4, ...eval5];
const evalMap = {};
allEvals.forEach(e => {
  evalMap[e.id] = e;
});

let correctSpecific = 0;
let correctGeneric = 0;

let md = `# ContextOS: Redis 100-Query Semantic Accuracy Report

This report details the execution and **qualitative, semantic accuracy** of ContextOS against the \`redis/redis\` C repository for 100 benchmark questions.
Accuracy in this report is graded by 5 parallel AI evaluator subagents. Each evaluator read the raw C context returned by ContextOS and judged whether the actual content returned contained sufficient information to accurately answer the user's query.

## Summary Stats
- **Specific Accuracy:** {SPECIFIC_ACCURACY}
- **Generic Accuracy:** {GENERIC_ACCURACY}
- **Total Accuracy:** {TOTAL_ACCURACY}
- **Total Tokens Used:** 140,433

---

## Detailed Results: Specific (Targeted) Queries
| Status | ID | Query | Evaluation Reason | Tokens | Latency |
|---|---|---|---|---|---|
`;

function formatRow(res, evaluation) {
  const isAccurate = evaluation ? evaluation.isAccurate : false;
  const reason = evaluation ? evaluation.reason : "No evaluation found";
  const status = isAccurate ? '✅ PASS' : '❌ FAIL';
  return `| ${status} | \`${res.id}\` | ${res.query} | ${reason} | ${res.tokens} | ${res.latencyMs}ms |`;
}

let genericMd = `

## Detailed Results: Generic (Explorer) Queries
| Status | ID | Query | Evaluation Reason | Tokens | Latency |
|---|---|---|---|---|---|
`;

for (const res of results) {
  const ev = evalMap[res.id];
  const isAccurate = ev ? ev.isAccurate : false;

  if (res.type === 'specific') {
    if (isAccurate) correctSpecific++;
    md += formatRow(res, ev) + '\\n';
  } else {
    if (isAccurate) correctGeneric++;
    genericMd += formatRow(res, ev) + '\\n';
  }
}

const specAcc = `${correctSpecific}/50 (${((correctSpecific/50)*100).toFixed(1)}%)`;
const genAcc = `${correctGeneric}/50 (${((correctGeneric/50)*100).toFixed(1)}%)`;
const totAcc = `${correctSpecific + correctGeneric}/100 (${(((correctSpecific + correctGeneric)/100)*100).toFixed(1)}%)`;

md = md.replace('{SPECIFIC_ACCURACY}', specAcc);
md = md.replace('{GENERIC_ACCURACY}', genAcc);
md = md.replace('{TOTAL_ACCURACY}', totAcc);

md += genericMd;

fs.writeFileSync('/Users/siddhartha/.gemini/antigravity/brain/d21a6a7c-1c29-483b-b38e-d440935a6d98/redis_semantic_benchmark_report.md', md, 'utf8');
console.log('Report generated.');
