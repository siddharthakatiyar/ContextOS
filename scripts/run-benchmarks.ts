import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const EXAMPLES_DIR = path.join(import.meta.dirname, '../retrieval-examples');
const CONTEXTOS_BIN = path.join(import.meta.dirname, '../dist/bin/contextos.js');
const WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

type BenchmarkCase = {
  query: string;
  expectedFiles: string[];
  minRecall?: number;
};

type QueryResult = {
  tokens?: number;
  chunks: Array<{ sourceFile?: string }>;
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

function stopDaemon(projectDirectory: string): void {
  const pidPath = path.join(projectDirectory, '.contextos', 'daemon.pid');
  if (!fs.existsSync(pidPath)) return;
  const pid = Number.parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    Atomics.wait(WAIT_BUFFER, 0, 0, 100);
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
  }
  // The PID came from this benchmark's isolated project and is safe to force-stop.
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function runBenchmark(): void {
  const directories = fs
    .readdirSync(EXAMPLES_DIR)
    .filter((entry) => fs.statSync(path.join(EXAMPLES_DIR, entry)).isDirectory());
  let totalQueries = 0;
  let passedQueries = 0;
  let totalRecall = 0;
  let failed = false;

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

    console.log(`\n--- Benchmarking ${directory} ---`);
    const benchmarks = JSON.parse(fs.readFileSync(benchmarkFile, 'utf8')) as BenchmarkCase[];

    try {
      const initOutput = execFileSync(process.execPath, [CONTEXTOS_BIN, 'init'], {
        cwd: projectDirectory,
        env: environment
      });
      console.log(`Init output for ${directory}:`, initOutput.toString().substring(0, 500));

      let indexed = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        const statusOutput = execFileSync(process.execPath, [CONTEXTOS_BIN, 'status', '--json'], {
          cwd: projectDirectory,
          env: environment
        }).toString();
        const status = JSON.parse(statusOutput) as {
          daemon?: { indexing?: { fullIndexCompleted?: boolean } };
        };
        if (status.daemon?.indexing?.fullIndexCompleted) {
          indexed = true;
          break;
        }
        Atomics.wait(WAIT_BUFFER, 0, 0, 1000);
      }
      if (!indexed) throw new Error(`Timeout waiting for indexing to complete for ${directory}`);

      for (const benchmark of benchmarks) {
        totalQueries++;
        try {
          const output = execFileSync(
            process.execPath,
            [CONTEXTOS_BIN, 'query', benchmark.query, '--json'],
            {
              cwd: projectDirectory,
              env: environment,
              stdio: 'pipe',
              maxBuffer: 10 * 1024 * 1024
            }
          ).toString();
          const results = JSON.parse(output) as QueryResult;
          const sourceFiles = new Set(
            results.chunks
              .map((chunk) => chunk.sourceFile)
              .filter((sourceFile): sourceFile is string => Boolean(sourceFile))
              .map((sourceFile) => path.relative(projectDirectory, sourceFile).replace(/\\/g, '/'))
          );
          const missingFiles = benchmark.expectedFiles.filter((file) => !sourceFiles.has(file));
          const foundCount = benchmark.expectedFiles.length - missingFiles.length;
          const recall = foundCount / benchmark.expectedFiles.length;
          const passed = recall >= (benchmark.minRecall ?? 1);
          totalRecall += recall;
          if (passed) passedQueries++;
          else failed = true;

          console.log(`Query: "${benchmark.query}"`);
          console.log(
            `  Recall: ${(recall * 100).toFixed(0)}% (${foundCount}/${benchmark.expectedFiles.length})`
          );
          console.log(`  Tokens: ${results.tokens ?? 'unknown'}`);
          console.log(passed ? '  PASS' : `  FAIL: Missing files: ${missingFiles.join(', ')}`);
        } catch (error) {
          failed = true;
          console.error(`Error running query: "${benchmark.query}"`);
          console.error(error instanceof Error ? error.message : String(error));
        }
      }
    } catch (error) {
      failed = true;
      console.error(error instanceof Error ? error.message : String(error));
    } finally {
      stopDaemon(projectDirectory);
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }

  if (totalQueries === 0) {
    console.error('No benchmark queries were executed.');
    process.exitCode = 1;
    return;
  }
  const averageRecall = (totalRecall / totalQueries) * 100;
  console.log(`\n=== Benchmark Summary ===`);
  console.log(
    `Passed ${passedQueries} / ${totalQueries} queries (${((passedQueries / totalQueries) * 100).toFixed(1)}%)`
  );
  console.log(`Average Recall: ${averageRecall.toFixed(1)}%`);
  if (failed) process.exitCode = 1;
}

runBenchmark();
