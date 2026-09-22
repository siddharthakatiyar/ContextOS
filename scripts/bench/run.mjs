#!/usr/bin/env node
/**
 * Portable benchmark entrypoint.
 *
 * The checked-in retrieval-examples fixtures are copied to temporary project
 * directories by scripts/run-benchmarks.ts. No repository database, generated
 * log, or machine-specific path is used as benchmark state.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generateReport } from './lib/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tsxCli = path.join(root, 'node_modules/tsx/dist/cli.mjs');
const benchmarkScript = path.join(root, 'scripts/run-benchmarks.ts');
const outputDir = process.env.CONTEXTOS_BENCH_OUTPUT_DIR ||
  fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-bench-report-'));

const child = spawnSync(process.execPath, [tsxCli, benchmarkScript, '--json'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env }
});

if (child.error) {
  console.error(`Unable to start benchmark runner: ${child.error.message}`);
  process.exit(1);
}
if (child.status !== 0) {
  process.stderr.write(child.stderr || 'Benchmark runner failed.\n');
  process.exit(child.status ?? 1);
}

let metrics;
try {
  metrics = JSON.parse(child.stdout.trim());
} catch (error) {
  console.error(`Benchmark runner did not return JSON metrics: ${error}`);
  process.exit(1);
}

const report = generateReport(
  [{
    name: 'retrieval-examples',
    command: 'npm run bench -- --json',
    metrics
  }],
  outputDir,
  { quiet: true }
);

process.stdout.write(`${JSON.stringify({
  metadata: report.metadata,
  ...metrics,
  reportPath: path.relative(root, path.resolve(outputDir))
}, null, 2)}\n`);
