import fs from 'fs';

const data = JSON.parse(fs.readFileSync('scripts/bench/redis-results.json', 'utf8'));
const results = data.results;

// Map query keywords to expected files for evaluation
const expectedFilesMap = {
  // specific queries mapping (we can extract from regex or fallback here)
  "targeted_1": ["sds.c", "sds.h"],
  "targeted_2": ["sds.c", "sds.h"],
  "targeted_3": ["dict.c", "dict.h"],
  "targeted_4": ["dict.c", "dict.h"],
  "targeted_5": ["dict.c", "dict.h"],
  "targeted_6": ["ae.c", "ae.h"],
  "targeted_7": ["ae.c", "ae.h"],
  "targeted_8": ["ae.c", "ae.h", "ae_epoll.c", "ae_kqueue.c"],
  "targeted_9": ["networking.c"],
  "targeted_10": ["networking.c"],
  "targeted_11": ["networking.c"],
  "targeted_12": ["server.c"],
  "targeted_13": ["server.c"],
  "targeted_14": ["server.c"],
  "targeted_15": ["t_string.c"],
  "targeted_16": ["server.c", "t_string.c", "db.c"],
  "targeted_17": ["t_hash.c"],
  "targeted_18": ["t_hash.c"],
  "targeted_19": ["t_list.c"],
  "targeted_20": ["t_list.c", "blocked.c"],
  "targeted_21": ["t_set.c"],
  "targeted_22": ["t_zset.c", "server.h"],
  "targeted_23": ["t_zset.c"],
  "targeted_24": ["rdb.c"],
  "targeted_25": ["rdb.c"],
  "targeted_26": ["aof.c"],
  "targeted_27": ["aof.c"],
  "targeted_28": ["replication.c"],
  "targeted_29": ["replication.c"],
  "targeted_30": ["cluster.c"],
  "targeted_31": ["cluster.c"],
  "targeted_32": ["sentinel.c"],
  "targeted_33": ["sentinel.c"],
  "targeted_34": ["module.c"],
  "targeted_35": ["module.c"],
  "targeted_36": ["evict.c"],
  "targeted_37": ["evict.c", "server.h"],
  "targeted_38": ["lazyfree.c"],
  "targeted_39": ["bio.c"],
  "targeted_40": ["rax.c"],
  "targeted_41": ["listpack.c"],
  "targeted_42": ["quicklist.c"],
  "targeted_43": ["object.c"],
  "targeted_44": ["db.c"],
  "targeted_45": ["t_stream.c"],
  "targeted_46": ["t_stream.c"],
  "targeted_47": ["pubsub.c"],
  "targeted_48": ["script.c", "eval.c"],
  "targeted_49": ["tls.c"],
  "targeted_50": ["tracking.c"],

  // generic queries mapping
  "generic_1": ["server.c", "ae.c"],
  "generic_2": ["server.c"],
  "generic_3": ["networking.c"],
  "generic_4": ["networking.c"],
  "generic_5": ["server.c", "networking.c"],
  "generic_6": ["networking.c"],
  "generic_7": ["dict.c", "db.c"],
  "generic_8": ["sds.c", "t_string.c", "object.c"],
  "generic_9": ["t_hash.c", "dict.c", "ziplist.c", "listpack.c"],
  "generic_10": ["t_list.c", "quicklist.c"],
  "generic_11": ["t_set.c", "intset.c", "dict.c"],
  "generic_12": ["t_zset.c", "listpack.c"],
  "generic_13": ["t_stream.c", "rax.c", "listpack.c"],
  "generic_14": ["expire.c", "db.c"],
  "generic_15": ["evict.c", "server.c"],
  "generic_16": ["evict.c"],
  "generic_17": ["aof.c"],
  "generic_18": ["aof.c"],
  "generic_19": ["rdb.c"],
  "generic_20": ["rdb.c", "aof.c", "server.c"],
  "generic_21": ["replication.c"],
  "generic_22": ["replication.c"],
  "generic_23": ["replication.c"],
  "generic_24": ["sentinel.c"],
  "generic_25": ["sentinel.c"],
  "generic_26": ["cluster.c"],
  "generic_27": ["cluster.c"],
  "generic_28": ["cluster.c"],
  "generic_29": ["cluster.c"],
  "generic_30": ["module.c"],
  "generic_31": ["module.c"],
  "generic_32": ["script.c", "eval.c"],
  "generic_33": ["script.c", "eval.c"],
  "generic_34": ["pubsub.c"],
  "generic_35": ["blocked.c", "t_list.c", "t_zset.c", "t_stream.c"],
  "generic_36": ["multi.c"],
  "generic_37": ["multi.c"],
  "generic_38": ["lazyfree.c"],
  "generic_39": ["bio.c"],
  "generic_40": ["zmalloc.c", "zmalloc.h"],
  "generic_41": ["tracking.c"],
  "generic_42": ["acl.c"],
  "generic_43": ["server.c", "debug.c"],
  "generic_44": ["server.c"],
  "generic_45": ["server.c", "expire.c"],
  "generic_46": ["slowlog.c"],
  "generic_47": ["ae.c", "ae_epoll.c", "ae_kqueue.c"],
  "generic_48": ["config.c"],
  "generic_49": ["tls.c"],
  "generic_50": ["active-defrag.c"]
};

let correctSpecific = 0;
let correctGeneric = 0;

let md = `# ContextOS: Redis 100-Query Benchmark Report (Detailed)

This report details the execution, token cost, and absolute accuracy of ContextOS against the \`redis/redis\` C repository for 100 benchmark questions.

## Summary Stats
- **Specific Accuracy:** {SPECIFIC_ACCURACY}
- **Generic Accuracy:** {GENERIC_ACCURACY}
- **Total Accuracy:** {TOTAL_ACCURACY}
- **Total Tokens Used:** 140,433

---

## Detailed Results: Specific (Targeted) Queries
| Status | ID | Query | Expected File(s) | Retrieved Files | Tokens | Latency |
|---|---|---|---|---|---|---|
`;

function formatRow(res, isCorrect, expected) {
  const status = isCorrect ? '✅ PASS' : '❌ FAIL';
  const retrieved = res.matchedFiles.map(f => {
    // extract basename for cleaner report
    return f ? f.split('/').pop() : 'null';
  }).join(', ');
  const exp = expected.join(' OR ');
  return `| ${status} | \`${res.id}\` | ${res.query} | \`${exp}\` | \`${retrieved}\` | ${res.tokens} | ${res.latencyMs}ms |`;
}

let genericMd = `

## Detailed Results: Generic (Explorer) Queries
| Status | ID | Query | Expected File(s) | Retrieved Files | Tokens | Latency |
|---|---|---|---|---|---|---|
`;

for (const res of results) {
  const expected = expectedFilesMap[res.id] || [];
  let isCorrect = false;
  
  if (expected.length > 0) {
    isCorrect = res.matchedFiles.some(f => {
      if (!f) return false;
      return expected.some(exp => f.endsWith(exp));
    });
  }

  if (res.type === 'specific') {
    if (isCorrect) correctSpecific++;
    md += formatRow(res, isCorrect, expected) + '\\n';
  } else {
    if (isCorrect) correctGeneric++;
    genericMd += formatRow(res, isCorrect, expected) + '\\n';
  }
}

const specAcc = `${correctSpecific}/50 (${((correctSpecific/50)*100).toFixed(1)}%)`;
const genAcc = `${correctGeneric}/50 (${((correctGeneric/50)*100).toFixed(1)}%)`;
const totAcc = `${correctSpecific + correctGeneric}/100 (${(((correctSpecific + correctGeneric)/100)*100).toFixed(1)}%)`;

md = md.replace('{SPECIFIC_ACCURACY}', specAcc);
md = md.replace('{GENERIC_ACCURACY}', genAcc);
md = md.replace('{TOTAL_ACCURACY}', totAcc);

md += genericMd;

fs.writeFileSync('/Users/siddhartha/.gemini/antigravity/brain/d21a6a7c-1c29-483b-b38e-d440935a6d98/redis_detailed_benchmark_report.md', md, 'utf8');
console.log('Report generated.');
