import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BENCH_DIR, '../../..');

function gitSha(rootDir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf8'
    }).trim();
  } catch {
    return null;
  }
}

export function generateReport(
  results,
  outputDir = process.env.CONTEXTOS_BENCH_OUTPUT_DIR ||
    fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-bench-report-')),
  { quiet = false, rootDir = ROOT } = {}
) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const productVersion = packageJson.version;
  const tokenizer = 'cl100k_base';

  const report = {
    metadata: {
      harnessGitSha: gitSha(rootDir),
      productVersion,
      tokenizer,
      nodeVersion: process.version,
      timestamp: new Date().toISOString()
    },
    runs: results
  };

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const reportPath = path.join(outputDir, `benchmark-v2-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  if (!quiet) console.log(`Report written to ${reportPath}`);

  return report;
}
