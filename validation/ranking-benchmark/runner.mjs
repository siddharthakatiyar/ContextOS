import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

// Run in Vitest so the shared fixture's HOME isolation is identical to CI.
const output = path.resolve(process.argv[2] ?? 'validation/ranking-benchmark/latest.json');
const run = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    'tests/retrieval-130/benchmark.test.ts',
    '--maxWorkers=2',
    '--testTimeout=60000'
  ],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RANKING_BENCHMARK_OUTPUT: output,
      RANKING_BASELINE: process.env.RANKING_BASELINE ?? '0'
    }
  }
);
process.exitCode = run.status ?? 1;
