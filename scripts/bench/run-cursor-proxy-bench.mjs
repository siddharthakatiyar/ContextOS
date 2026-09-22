#!/usr/bin/env node
/**
 * Reproducible proxy for Cursor @codebase search on a Redis checkout.
 *
 * This is a ripgrep keyword baseline, not Cursor's semantic search. The
 * repository path is supplied at runtime and generated results are written to
 * a temporary directory unless CONTEXTOS_BENCH_OUTPUT_DIR or --output-dir is
 * provided.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT_LINES = 40;
const MAX_FILES = 8;
const MAX_BYTES_PER_FILE = 6000;

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
      'Usage: CONTEXTOS_REDIS_REPO=/path/to/redis node scripts/bench/run-cursor-proxy-bench.mjs [--output-dir DIR]'
    );
  }
  const redisPath = path.resolve(repo);
  if (!fs.existsSync(redisPath) || !fs.statSync(redisPath).isDirectory()) {
    throw new Error(`Redis path ${redisPath} does not exist. Clone or provide a Redis checkout first.`);
  }
  return { redisPath, outputArg };
}

const { estimateTokens } = await import('../../dist/src/utils/tokens.js');

function extractSearchTerms(query) {
  const terms = new Set();
  for (const match of query.matchAll(/`([a-zA-Z_][a-zA-Z0-9_]*)`/g)) terms.add(match[1]);
  for (const match of query.matchAll(/\b([a-zA-Z_][\w.-]*\.[ch])\b/g)) terms.add(match[1]);
  for (const match of query.matchAll(/\b([a-z][a-zA-Z0-9]{2,}|[A-Z][a-zA-Z0-9_]{2,})\b/g)) {
    const word = match[1];
    if (!['How', 'What', 'Where', 'When', 'The', 'Redis', 'In', 'And', 'For', 'Are', 'Does', 'With'].includes(word)) {
      terms.add(word);
    }
  }
  return [...terms].slice(0, 6);
}

function rgSearch(term, sourceDir) {
  const result = spawnSync(
    'rg',
    [
      '-l', '--no-heading', '--glob', '*.c', '--glob', '*.h',
      '--glob', '!deps/**', '--glob', '!**/test/**', '--', term, sourceDir
    ],
    { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }
  );
  if (result.error || result.status !== 0) return [];
  return result.stdout.trim().split('\n').filter(Boolean);
}

function readMatchContext(filePath, terms) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    let bestLine = 0;
    let bestScore = 0;
    for (let index = 0; index < lines.length; index++) {
      const score = terms.reduce(
        (total, term) => total + (lines[index].includes(term) ? term.length : 0),
        0
      );
      if (score > bestScore) {
        bestScore = score;
        bestLine = index;
      }
    }
    const start = Math.max(0, bestLine - CONTEXT_LINES);
    const end = Math.min(lines.length, bestLine + CONTEXT_LINES);
    return lines.slice(start, end).join('\n').slice(0, MAX_BYTES_PER_FILE);
  } catch {
    return '';
  }
}

async function runBenchmark() {
  const { redisPath, outputArg } = parseArgs();
  const sourceDir = path.join(redisPath, 'src');
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Redis source directory ${sourceDir} does not exist.`);
  }
  const expectedFilesMap = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'expected-files-map.json'), 'utf8')
  );
  const queries = JSON.parse(fs.readFileSync(path.join(__dirname, 'redis-bench.json'), 'utf8'));
  if (!Array.isArray(queries) || queries.length === 0) throw new Error('No Redis queries found.');

  const results = [];
  let targetedTokens = 0;
  let genericTokens = 0;
  let targetedAcc = 0;
  let genericAcc = 0;
  let expectedFilesFound = 0;
  let expectedFileCount = 0;
  let anyHitQueries = 0;

  for (const query of queries) {
    const terms = extractSearchTerms(query.query);
    const fileScores = new Map();
    for (const term of terms) {
      for (const file of rgSearch(term, sourceDir)) {
        fileScores.set(file, (fileScores.get(file) || 0) + term.length);
      }
    }
    const ranked = [...fileScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_FILES);
    const matchedFiles = ranked.map(([file]) => path.relative(redisPath, file).replace(/\\/g, '/'));
    const resText = ranked
      .map(([file]) => `\n--- ${path.basename(file)} ---\n${readMatchContext(file, terms)}\n`)
      .join('')
      .slice(0, 40000);
    const tokens = estimateTokens(resText);
    const expected = expectedFilesMap[query.id] || [];
    const foundCount = expected.filter((file) =>
      matchedFiles.some((match) => match.endsWith(file))
    ).length;
    const anyHit = foundCount > 0;
    const accurate = anyHit;
    expectedFilesFound += foundCount;
    expectedFileCount += expected.length;
    if (anyHit) anyHitQueries++;
    if (query.type === 'specific') {
      targetedTokens += tokens;
      if (accurate) targetedAcc++;
    } else {
      genericTokens += tokens;
      if (accurate) genericAcc++;
    }
    results.push({
      id: query.id,
      type: query.type,
      query: query.query,
      tokens,
      accurate,
      matchedFiles,
      expectedFiles: expected,
      expectedFilesFound: foundCount,
      expectedFileCount: expected.length,
      recall: expected.length ? foundCount / expected.length : 0,
      anyHit,
      terms,
      resText: resText.slice(0, 2000)
    });
  }

  const targetedQueries = results.filter((result) => result.type === 'specific').length;
  const genericQueries = results.length - targetedQueries;
  const expectedFileRecall = expectedFileCount ? expectedFilesFound / expectedFileCount : 0;
  const anyHitRate = results.length ? anyHitQueries / results.length : 0;
  const report = {
    corpus: 'redis-bench.json',
    repository: process.env.CONTEXTOS_REPO_LABEL || path.basename(redisPath),
    generatedAt: new Date().toISOString(),
    note: 'Proxy benchmark using ripgrep keyword search (not Cursor semantic @codebase).',
    totalQueries: results.length,
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
      count: targetedQueries,
      accurate: targetedAcc,
      avgTokens: targetedQueries ? targetedTokens / targetedQueries : 0,
      totalTokens: targetedTokens
    },
    generic: {
      count: genericQueries,
      accurate: genericAcc,
      avgTokens: genericQueries ? genericTokens / genericQueries : 0,
      totalTokens: genericTokens
    },
    results
  };

  const outputDir = path.resolve(
    outputArg || process.env.CONTEXTOS_BENCH_OUTPUT_DIR ||
      fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-cursor-proxy-'))
  );
  fs.mkdirSync(outputDir, { recursive: true });
  const outFile = path.join(outputDir, 'cursor-proxy-results.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log('Cursor proxy benchmark complete');
  console.log(`Targeted: ${targetedAcc}/${targetedQueries} accurate, avg ${report.specific.avgTokens.toFixed(0)} tokens`);
  console.log(`Generic: ${genericAcc}/${genericQueries} accurate, avg ${report.generic.avgTokens.toFixed(0)} tokens`);
  console.log(`Expected-file recall: ${report.expectedFileRecallPercent.toFixed(1)}%`);
  console.log(`Any-hit rate: ${report.anyHitRatePercent.toFixed(1)}%`);
  console.log(`Saved to ${outFile}`);
}

runBenchmark().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
