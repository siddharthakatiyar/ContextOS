import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { glob } from 'glob';
import { DB } from '../src/core/storage/database.js';
import { Indexer } from '../src/core/indexer/index.js';
import { createIndexIgnore } from '../src/core/indexer/ignore.js';
import { RetrievalEngine } from '../src/core/retrieval/index.js';
import { KnowledgeStore } from '../src/core/memory/knowledge-store.js';
import { SessionManager } from '../src/core/session/index.js';
import { PromptsRepo } from '../src/core/storage/prompts-repo.js';
import { SessionStore } from '../src/core/session/session-store.js';
import { ChunksRepo } from '../src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../src/core/storage/relationships-repo.js';
import { executeGetContext } from '../src/mcp/tools/get-context-core.js';
import { loadConfig } from '../src/config/index.js';

const EXAMPLES_DIR = path.join(import.meta.dirname, '../retrieval-examples');
const JSON_OUTPUT = process.argv.includes('--json');

function log(...args: unknown[]): void {
  if (!JSON_OUTPUT) console.log(...args);
}

type BenchmarkCase = {
  query: string;
  expectedFiles: string[];
  maxTokens?: number;
  minRecall?: number;
};

type QueryResult = {
  tokens?: number;
  chunks: Array<{ sourceFile?: string }>;
};

type QueryMetric = {
  fixture: string;
  query: string;
  expectedFiles: string[];
  retrievedFiles: string[];
  expectedFilesFound: number;
  expectedFileCount: number;
  recall: number;
  anyHit: boolean;
  minRecall: number;
  passed: boolean;
  tokens: number | null;
  error?: string;
};

function isolatedEnvironment(homeDirectory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDirectory,
    USERPROFILE: homeDirectory
  };
}

function copyFixture(sourceDirectory: string, targetDirectory: string): void {
  fs.cpSync(sourceDirectory, targetDirectory, {
    recursive: true,
    filter(source) {
      const relative = path.relative(sourceDirectory, source);
      if (!relative) return true;
      const firstSegment = relative.split(path.sep)[0];
      return !['.contextos', '.mcp.json', '.vscode', 'CLAUDE.md'].includes(firstSegment);
    }
  });
}

function relativeSourceFile(projectDirectory: string, sourceFile: string): string {
  const absolute = path.isAbsolute(sourceFile)
    ? sourceFile
    : path.resolve(projectDirectory, sourceFile);
  return path.relative(projectDirectory, absolute).replace(/\\/g, '/');
}

async function indexFixture(projectDirectory: string): Promise<{
  db: DB;
  deps: Parameters<typeof executeGetContext>[2];
  fileCount: number;
}> {
  const config = loadConfig({ cwd: projectDirectory, forceReload: true });
  const db = new DB(path.join(projectDirectory, '.contextos', 'index.db'));
  try {
    const indexIgnore = createIndexIgnore(projectDirectory, config.ignorePatterns);
    const indexer = new Indexer(db, indexIgnore.root, config.ignorePatterns);
    const files = new Set<string>();
    for (const pattern of config.indexablePatterns) {
      const matches = await glob(pattern, {
        cwd: projectDirectory,
        ignore: [...indexIgnore.globIgnore],
        absolute: true,
        nodir: true,
        follow: false
      });
      for (const file of matches) {
        if (!indexIgnore.ignores(file)) files.add(path.resolve(file));
      }
    }
    for (const file of [...files].sort()) await indexer.indexFile(file, 'repo');

    const chunksRepos = [new ChunksRepo(db.getInstance())];
    const relationshipsRepos = [new RelationshipsRepo(db.getInstance())];
    const promptsRepo = new PromptsRepo(db.getInstance());
    const sessionStore = new SessionStore(db);
    const sessionManager = new SessionManager(promptsRepo, sessionStore);
    const engine = new RetrievalEngine(chunksRepos, relationshipsRepos);
    const knowledgeStore = new KnowledgeStore(db);
    return {
      db,
      fileCount: files.size,
      deps: { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore }
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function runBenchmark(): Promise<void> {
  const directories = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((entry) => fs.statSync(path.join(EXAMPLES_DIR, entry)).isDirectory())
    .sort();
  let totalQueries = 0;
  let passedQueries = 0;
  let failedQueries = 0;
  let totalRecall = 0;
  let expectedFilesFound = 0;
  let expectedFileCount = 0;
  let anyHitQueries = 0;
  let failed = false;
  const queryMetrics: QueryMetric[] = [];

  for (const directory of directories) {
    const sourceDirectory = path.join(EXAMPLES_DIR, directory);
    const benchmarkFile = path.join(sourceDirectory, 'benchmark.json');
    if (!fs.existsSync(benchmarkFile)) continue;

    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `contextos-bench-${directory}-`));
    const projectDirectory = path.join(temporaryRoot, 'project');
    const homeDirectory = path.join(temporaryRoot, 'home');
    fs.mkdirSync(homeDirectory, { recursive: true });
    copyFixture(sourceDirectory, projectDirectory);
    const environment = isolatedEnvironment(homeDirectory);

    log(`\n--- Benchmarking ${directory} ---`);
    const benchmarks = JSON.parse(fs.readFileSync(benchmarkFile, 'utf8')) as BenchmarkCase[];
    const fixtureMetricStart = queryMetrics.length;
    let db: DB | undefined;
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;

    try {
      // Keep global config/model state isolated without starting a detached
      // daemon. The benchmark exercises the same DB, indexer, retrieval, and
      // compiler core used by the CLI and MCP paths, but its lifecycle remains
      // owned by this process so failures cannot orphan stateful workers.
      process.env.HOME = environment.HOME;
      process.env.USERPROFILE = environment.USERPROFILE;
      const indexed = await indexFixture(projectDirectory);
      db = indexed.db;
      log(`Indexed ${indexed.fileCount} files for ${directory}`);

      for (const benchmark of benchmarks) {
        totalQueries++;
        try {
          const result = await executeGetContext(
            benchmark.query,
            { repoRoot: projectDirectory, maxTokens: benchmark.maxTokens },
            indexed.deps
          );
          const results: QueryResult = {
            tokens: result.compiled.tokenCount,
            chunks: result.result.chunks
          };
          const sourceFiles = new Set(
            results.chunks
              .map((chunk) => chunk.sourceFile)
              .filter((sourceFile): sourceFile is string => Boolean(sourceFile))
              .map((sourceFile) => relativeSourceFile(projectDirectory, sourceFile))
          );
          const missingFiles = benchmark.expectedFiles.filter((file) => !sourceFiles.has(file));
          const foundCount = benchmark.expectedFiles.length - missingFiles.length;
          const expectedCount = benchmark.expectedFiles.length;
          const recall = expectedCount === 0 ? 0 : foundCount / expectedCount;
          const minRecall = benchmark.minRecall ?? 1;
          const passed = recall >= minRecall;
          totalRecall += recall;
          expectedFilesFound += foundCount;
          expectedFileCount += expectedCount;
          if (foundCount > 0) anyHitQueries++;
          if (passed) passedQueries++;
          else {
            failedQueries++;
            failed = true;
          }

          queryMetrics.push({
            fixture: directory,
            query: benchmark.query,
            expectedFiles: benchmark.expectedFiles,
            retrievedFiles: [...sourceFiles],
            expectedFilesFound: foundCount,
            expectedFileCount: expectedCount,
            recall,
            anyHit: foundCount > 0,
            minRecall,
            passed,
            tokens: results.tokens ?? null
          });

          log(`Query: "${benchmark.query}"`);
          log(
            `  Recall: ${(recall * 100).toFixed(0)}% (${foundCount}/${benchmark.expectedFiles.length})`
          );
          log(`  Tokens: ${results.tokens ?? 'unknown'}`);
          log(passed ? '  PASS' : `  FAIL: Missing files: ${missingFiles.join(', ')}`);
        } catch (error) {
          failed = true;
          failedQueries++;
          expectedFileCount += benchmark.expectedFiles.length;
          queryMetrics.push({
            fixture: directory,
            query: benchmark.query,
            expectedFiles: benchmark.expectedFiles,
            retrievedFiles: [],
            expectedFilesFound: 0,
            expectedFileCount: benchmark.expectedFiles.length,
            recall: 0,
            anyHit: false,
            minRecall: benchmark.minRecall ?? 1,
            passed: false,
            tokens: null,
            error: error instanceof Error ? error.message : String(error)
          });
          console.error(`Error running query: "${benchmark.query}"`);
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      failed = true;
      const unreported = benchmarks.length - (queryMetrics.length - fixtureMetricStart);
      for (const benchmark of benchmarks.slice(benchmarks.length - unreported)) {
        totalQueries++;
        failedQueries++;
        expectedFileCount += benchmark.expectedFiles.length;
        queryMetrics.push({
          fixture: directory,
          query: benchmark.query,
          expectedFiles: benchmark.expectedFiles,
          retrievedFiles: [],
          expectedFilesFound: 0,
          expectedFileCount: benchmark.expectedFiles.length,
          recall: 0,
          anyHit: false,
          minRecall: benchmark.minRecall ?? 1,
          passed: false,
          tokens: null,
          error: error instanceof Error ? error.message : String(error)
        });
      }
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      db?.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousUserProfile;
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  if (totalQueries === 0) {
    console.error('No benchmark queries were executed.');
    process.exitCode = 1;
    return;
  }
  const averageRecall = totalRecall / totalQueries;
  const expectedFileRecall = expectedFileCount === 0 ? 0 : expectedFilesFound / expectedFileCount;
  const anyHitRate = anyHitQueries / totalQueries;
  const summary = {
    corpus: 'retrieval-examples',
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    totalQueries,
    passedQueries,
    failedQueries,
    passRate: passedQueries / totalQueries,
    passRatePercent: (passedQueries / totalQueries) * 100,
    averageRecall,
    averageRecallPercent: averageRecall * 100,
    expectedFilesFound,
    expectedFileCount,
    expectedFileRecall,
    expectedFileRecallPercent: expectedFileRecall * 100,
    anyHitQueries,
    anyHitRate,
    anyHitRatePercent: anyHitRate * 100,
    metricDefinitions: {
      averageRecall: 'Mean of per-query expected-file recall values.',
      expectedFileRecall: 'All expected files found divided by all expected files across queries.',
      anyHitRate: 'Queries with at least one expected file retrieved divided by all queries.',
      passRate: 'Queries meeting their benchmark minRecall threshold divided by all queries.'
    },
    queries: queryMetrics,
    failed
  };
  if (JSON_OUTPUT) {
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (failed) process.exitCode = 1;
    return;
  }
  console.log(`\n=== Benchmark Summary ===`);
  console.log(
    `Passed ${passedQueries} / ${totalQueries} queries (${((passedQueries / totalQueries) * 100).toFixed(1)}%)`
  );
  console.log(`Average Recall: ${(averageRecall * 100).toFixed(1)}%`);
  console.log(`Expected-file Recall: ${(expectedFileRecall * 100).toFixed(1)}%`);
  console.log(`Any-hit Rate: ${(anyHitRate * 100).toFixed(1)}%`);
  if (failed) process.exitCode = 1;
}

const originalConsoleLog = console.log;
if (JSON_OUTPUT) {
  // Core startup/migration code may log progress. Keep --json stdout valid so
  // CI and scripts can parse one metrics document without scraping text.
  console.log = (...args: unknown[]) => console.error(...args);
}
runBenchmark()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => {
    console.log = originalConsoleLog;
  });
