import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs() {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf('--output-dir');
  if (outputIndex >= 0 && !args[outputIndex + 1]) {
    throw new Error('--output-dir requires a directory path');
  }
  const outputArg = outputIndex >= 0 ? args[outputIndex + 1] : undefined;
  const repoArg = args.find(
    (arg, index) =>
      !arg.startsWith('-') && !(outputIndex >= 0 && index === outputIndex + 1)
  );
  const repo = process.env.CONTEXTOS_REDIS_REPO || repoArg;
  if (!repo) {
    throw new Error(
      'Usage: CONTEXTOS_REDIS_REPO=/path/to/redis node scripts/bench/run-redis-bench.mjs [--output-dir DIR]'
    );
  }
  const redisPath = path.resolve(repo);
  if (!fs.existsSync(redisPath) || !fs.statSync(redisPath).isDirectory()) {
    throw new Error(`Redis path ${redisPath} does not exist. Clone or provide a Redis checkout first.`);
  }
  return { redisPath, outputArg };
}

function relativeFile(root, file) {
  if (typeof file !== 'string') return null;
  return path.relative(root, file).replace(/\\/g, '/');
}

async function runBenchmark() {
  const { redisPath, outputArg } = parseArgs();
  process.env.CONTEXTOS_REPO_ROOT = redisPath;

  const benchFile = path.join(__dirname, 'redis-bench.json');
  const queries = JSON.parse(fs.readFileSync(benchFile, 'utf8'));
  if (!Array.isArray(queries) || queries.length === 0) {
    throw new Error(`Benchmark file ${benchFile} does not contain any queries.`);
  }
  const expectedFilesMap = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'expected-files-map.json'), 'utf8')
  );

  // Keep the index outside the checkout. No existing .contextos state is
  // deleted or modified, so a benchmark can safely run on a user's clone.
  const benchmarkStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-redis-bench-'));
  const outputDir = path.resolve(
    outputArg || process.env.CONTEXTOS_BENCH_OUTPUT_DIR ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-redis-results-'))
  );
  let db;
  try {
    const redisScopedDbPath = path.join(benchmarkStateDir, 'index.db');
    db = new DB(redisScopedDbPath);
    console.log(`Indexing Redis checkout (${redisPath})...`);

    const { glob } = await import('glob');
    const { loadConfig } = await import('../../dist/src/config/index.js');
    const config = loadConfig({ cwd: redisPath });
    const indexer = new Indexer(db, redisPath, config.ignorePatterns);
    const ignore = [
      '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
      '**/.next/**', '**/coverage/**', '**/__pycache__/**', '**/target/**',
      '**/*.min.js', '**/*.min.css', '**/*.map', '**/*.lock', '**/vendor/**',
      // Redis bundles third-party sources under deps/. Exclude them so this
      // measures Redis source retrieval rather than vendored internals.
      '**/deps/**',
      ...(config.ignorePatterns || [])
    ];

    const allRepoFiles = new Set();
    for (const pattern of config.indexablePatterns) {
      const files = await glob(pattern, { cwd: redisPath, ignore, absolute: true, nodir: true });
      for (const file of files) allRepoFiles.add(file);
    }
    const sortedFiles = [...allRepoFiles].sort();
    for (const [index, file] of sortedFiles.entries()) {
      if (index % 100 === 0) console.log(`Indexed ${index} / ${sortedFiles.length} files...`);
      await indexer.indexFile(file, 'workspace', process.env.CONTEXTOS_WORKSPACE || 'redis-benchmark');
    }
    console.log(`Indexing complete. Total files indexed: ${sortedFiles.length}`);

    const chunksRepos = [new ChunksRepo(db.getInstance())];
    const relsRepos = [new RelationshipsRepo(db.getInstance())];
    const promptsRepo = new PromptsRepo(db.getInstance());
    const sessionStore = new SessionStore(db);
    const sessionManager = new SessionManager(promptsRepo, sessionStore);
    const engine = new RetrievalEngine(chunksRepos, relsRepos);
    const knowledgeStore = new KnowledgeStore(db);
    const deps = { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore };

    // Warm the index once so latency measurements do not include cold-start I/O.
    console.log('Warming up index...');
    await executeGetContext(
      queries[0].query,
      { limit: 10, maxTokens: 4000, repoRoot: redisPath },
      deps
    );

    const results = [];
    let targetedTokens = 0;
    let genericTokens = 0;
    let targetedCount = 0;
    let genericCount = 0;
    let failedQueries = 0;
    let expectedFilesFound = 0;
    let expectedFileCount = 0;
    let anyHitQueries = 0;

    for (const [queryIndex, query] of queries.entries()) {
      console.log(`[${queryIndex + 1}/${queries.length}] Running query: ${query.query}`);
      const start = Date.now();
      let tokens = 0;
      try {
        const res = await executeGetContext(
          query.query,
          { limit: 10, maxTokens: 4000, repoRoot: redisPath },
          deps
        );
        const resText = res.text || res;
        const matchedFiles = res.result
          ? [...new Set(res.result.chunks.map((chunk) => relativeFile(redisPath, chunk.sourceFile)))]
            .filter(Boolean)
          : [];
        tokens = estimateTokens(resText);
        const expectedFiles = expectedFilesMap[query.id] || [];
        const foundCount = expectedFiles.filter((expected) =>
          matchedFiles.some((file) => file.endsWith(expected))
        ).length;
        const anyHit = foundCount > 0;
        expectedFilesFound += foundCount;
        expectedFileCount += expectedFiles.length;
        if (anyHit) anyHitQueries++;
        results.push({
          id: query.id,
          type: query.type,
          query: query.query,
          tokens,
          latencyMs: Date.now() - start,
          matchedFiles,
          resText,
          expectedFiles,
          expectedFilesFound: foundCount,
          expectedFileCount: expectedFiles.length,
          recall: expectedFiles.length ? foundCount / expectedFiles.length : 0,
          anyHit,
          error: null
        });
      } catch (error) {
        failedQueries++;
        const expectedFiles = expectedFilesMap[query.id] || [];
        expectedFileCount += expectedFiles.length;
        console.error(`Error on query ${query.id}:`, error);
        results.push({
          id: query.id,
          type: query.type,
          query: query.query,
          tokens: 0,
          latencyMs: Date.now() - start,
          matchedFiles: [],
          resText: '',
          expectedFiles,
          expectedFilesFound: 0,
          expectedFileCount: expectedFiles.length,
          recall: 0,
          anyHit: false,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      if (query.type === 'specific') {
        targetedTokens += tokens;
        targetedCount++;
      } else {
        genericTokens += tokens;
        genericCount++;
      }
    }

    const expectedFileRecall = expectedFileCount ? expectedFilesFound / expectedFileCount : 0;
    const anyHitRate = queries.length ? anyHitQueries / queries.length : 0;
    const report = {
      corpus: 'redis-bench.json',
      repository: process.env.CONTEXTOS_REPO_LABEL || path.basename(redisPath),
      generatedAt: new Date().toISOString(),
      totalQueries: queries.length,
      failedQueries,
      failed: failedQueries > 0,
      expectedFilesFound,
      expectedFileCount,
      expectedFileRecall,
      expectedFileRecallPercent: expectedFileRecall * 100,
      anyHitQueries,
      anyHitRate,
      anyHitRatePercent: anyHitRate * 100,
      metricDefinitions: {
        expectedFileRecall: 'All expected files found divided by all expected files across queries.',
        anyHitRate: 'Queries with at least one expected file retrieved divided by all queries.'
      },
      specific: {
        count: targetedCount,
        avgTokens: targetedCount ? targetedTokens / targetedCount : 0,
        totalTokens: targetedTokens
      },
      generic: {
        count: genericCount,
        avgTokens: genericCount ? genericTokens / genericCount : 0,
        totalTokens: genericTokens
      },
      results
    };

    fs.mkdirSync(outputDir, { recursive: true });
    const outFile = path.join(outputDir, 'redis-results.json');
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
    console.log('\n--- Benchmark Complete ---');
    console.log(`Specific Avg Tokens: ${report.specific.avgTokens.toFixed(1)}`);
    console.log(`Generic Avg Tokens: ${report.generic.avgTokens.toFixed(1)}`);
    console.log(`Total Tokens: ${targetedTokens + genericTokens}`);
    console.log(`Expected-file recall: ${report.expectedFileRecallPercent.toFixed(1)}%`);
    console.log(`Any-hit rate: ${report.anyHitRatePercent.toFixed(1)}%`);
    console.log(`Results saved to ${outFile}`);
    if (report.failed) process.exitCode = 1;
  } finally {
    db?.close();
    fs.rmSync(benchmarkStateDir, { recursive: true, force: true });
  }
}

runBenchmark().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
