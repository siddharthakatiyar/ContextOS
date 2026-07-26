import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeGetContext } from '../../dist/src/mcp/tools/get-context-core.js';
import { estimateTokens } from '../../dist/src/utils/tokens.js';
import { DB } from '../../dist/src/core/storage/database.js';
import { Indexer } from '../../dist/src/core/indexer/index.js';
import { RetrievalEngine } from '../../dist/src/core/retrieval/index.js';
import { SessionManager } from '../../dist/src/core/session/index.js';
import { KnowledgeStore } from '../../dist/src/core/memory/knowledge-store.js';
import { PromptsRepo } from '../../dist/src/core/storage/prompts-repo.js';
import { SessionStore } from '../../dist/src/core/session/session-store.js';
import { ChunksRepo } from '../../dist/src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../dist/src/core/storage/relationships-repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runBenchmark() {
  const redisPath = '/Volumes/ExtremeSSD/code/redis';
  if (!fs.existsSync(redisPath)) {
    console.error(`Redis path ${redisPath} does not exist. Please clone redis first.`);
    process.exit(1);
  }

  // Set the environment variable so contextOS knows the repo root
  process.env.CONTEXTOS_REPO_ROOT = redisPath;

  const benchFile = path.join(__dirname, 'redis-bench.json');
  const queries = JSON.parse(fs.readFileSync(benchFile, 'utf-8'));
  
  const results = [];
  let targetedTokens = 0;
  let genericTokens = 0;
  let targetedCount = 0;
  let genericCount = 0;

  // Delete the existing ContextOS db in Redis if it exists to force fresh index
  const dbPath = path.join(redisPath, '.contextos');
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
  }

  // CRITICAL: Pass the Redis-scoped DB path explicitly.
  // Without this, new DB() falls back to process.cwd() which is the contextOS repo,
  // causing Redis chunks to be written into the contextOS index.db (cross-contamination).
  const redisScopedDbPath = path.join(redisPath, '.contextos', 'index.db');
  const db = new DB(redisScopedDbPath);
  console.log('Indexing Redis codebase...');
  const indexer = new Indexer(db, redisPath);

  const { glob } = await import('glob');
  const { loadConfig } = await import('../../dist/src/config/index.js');
  const config = loadConfig();
  
  const ignore = [
    '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
    '**/.next/**', '**/coverage/**', '**/__pycache__/**', '**/target/**',
    '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.lock', '**/vendor/**',
    // Exclude Redis's bundled deps (jemalloc, hiredis, lua) — they are noise for retrieval
    // and previously caused 9/26 generic failures (returned jemalloc internals instead of Redis C)
    '**/deps/**',
    ...(config.ignorePatterns || [])
  ];

  const allRepoFiles = new Set();
  for (const pattern of config.indexablePatterns) {
    const files = await glob(pattern, { cwd: redisPath, ignore, absolute: true, nodir: true });
    for (const f of files) allRepoFiles.add(f);
  }

  let i = 0;
  for (const f of allRepoFiles) {
    if (i % 100 === 0) console.log(`Indexed ${i} / ${allRepoFiles.size} files...`);
    console.log('Indexing file:', f);
    await indexer.indexFile(f, 'workspace', redisPath);
    i++;
  }
  console.log(`Indexing complete. Total files indexed: ${allRepoFiles.size}`);

  const chunksRepos = [new ChunksRepo(db.getInstance())];
  const relsRepos = [new RelationshipsRepo(db.getInstance())];
  const promptsRepo = new PromptsRepo(db.getInstance());
  const sessionStore = new SessionStore(db);
  const sessionManager = new SessionManager(promptsRepo, sessionStore);
  const engine = new RetrievalEngine(chunksRepos, relsRepos);
  const knowledgeStore = new KnowledgeStore(db);

  const deps = { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore };

  // Run the first query multiple times to warm up the index and ignore indexing time
  console.log('Warming up index...');
  try {
    await executeGetContext(queries[0].query, { limit: 10, maxTokens: 4000, repoRoot: redisPath }, deps);
  } catch (e) {
    console.error('Warmup failed:', e);
    process.exit(1);
  }

  let index = 1;
  for (const q of queries) {
    console.log(`[${index}/${queries.length}] Running query: ${q.query}`);
    const start = Date.now();
    let resText = '';
    let tokens = 0;
    
    try {
      const res = await executeGetContext(q.query, { limit: 10, maxTokens: 4000, repoRoot: redisPath }, deps);
      resText = res.text || res; // Handle if executeGetContext returns an object instead of string
      const matchedFiles = res.result ? [...new Set(res.result.chunks.map(c => c.sourceFile))] : [];
      tokens = estimateTokens(resText);
      results.push({
        id: q.id,
        type: q.type,
        query: q.query,
        tokens,
        latencyMs: Date.now() - start,
        matchedFiles,
        resText
      });
    } catch (e) {
      console.error(`Error on query ${q.id}:`, e);
      tokens = 0;
      results.push({
        id: q.id,
        type: q.type,
        query: q.query,
        tokens,
        latencyMs: Date.now() - start,
        matchedFiles: [],
        resText: ""
      });
    }

    if (q.type === 'specific') {
      targetedTokens += tokens;
      targetedCount++;
    } else {
      genericTokens += tokens;
      genericCount++;
    }

    index++;
  }

  const report = {
    totalQueries: queries.length,
    specific: {
      count: targetedCount,
      avgTokens: targetedCount > 0 ? targetedTokens / targetedCount : 0,
      totalTokens: targetedTokens
    },
    generic: {
      count: genericCount,
      avgTokens: genericCount > 0 ? genericTokens / genericCount : 0,
      totalTokens: genericTokens
    },
    results
  };

  const outFile = path.join(__dirname, 'redis-results.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log('\n--- Benchmark Complete ---');
  console.log(`Specific Avg Tokens: ${report.specific.avgTokens.toFixed(1)}`);
  console.log(`Generic Avg Tokens: ${report.generic.avgTokens.toFixed(1)}`);
  console.log(`Total Tokens: ${targetedTokens + genericTokens}`);
  console.log(`Results saved to ${outFile}`);
}

runBenchmark().catch(console.error);
