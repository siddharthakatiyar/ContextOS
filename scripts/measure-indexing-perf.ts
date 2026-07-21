import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

const CONTEXTOS_BIN = path.join(import.meta.dirname, '../dist/bin/contextos.js');
const TARGET_REPO = path.join(import.meta.dirname, '../retrieval-examples/large-generated');
const RESULTS_FILE = path.join(import.meta.dirname, 'results/indexing-perf.json');

async function measure() {
  if (!fs.existsSync(TARGET_REPO)) {
    console.error(`Error: Target repo ${TARGET_REPO} not found.`);
    console.log(`Please run tools/generate-large-repo.ts first (or any large repo).`);
    process.exit(1);
  }

  console.log(`Starting indexing performance measurement on ${TARGET_REPO}...`);
  
  // Clean up any existing DB
  try {
    execSync(`rm -rf .contextos/`, { cwd: TARGET_REPO });
  } catch(e) {}

  const startTime = Date.now();
  
  let out = "";
  try {
    // /usr/bin/time -l is macOS specific, which matches the user environment.
    // If run on linux in CI, we'd use /usr/bin/time -v and parse "Maximum resident set size"
    const isMac = process.platform === 'darwin';
    const timeCmd = isMac ? '/usr/bin/time -l' : '/usr/bin/time -v';
    out = execSync(`${timeCmd} node ${CONTEXTOS_BIN} init 2>&1`, { cwd: TARGET_REPO }).toString();
  } catch (e: any) {
    out = e.stdout?.toString() || e.message;
  }

  const durationMs = Date.now() - startTime;
  
  // Parse maximum resident set size from output
  // macOS `time -l` format: "  2345678  maximum resident set size"
  // Linux `time -v` format: "Maximum resident set size (kbytes): 2345678"
  let peakMemBytes = 0;
  if (process.platform === 'darwin') {
    const memMatch = out.match(/(\d+)\s+maximum resident set size/);
    peakMemBytes = memMatch ? parseInt(memMatch[1], 10) : 0;
  } else {
    const memMatch = out.match(/Maximum resident set size \(kbytes\):\s+(\d+)/);
    peakMemBytes = memMatch ? parseInt(memMatch[1], 10) * 1024 : 0;
  }
  
  const peakMemMb = (peakMemBytes / 1024 / 1024).toFixed(2);

  console.log(`Indexing took ${durationMs}ms`);
  console.log(`Peak memory: ${peakMemMb} MB`);

  const result = {
    timestamp: new Date().toISOString(),
    durationMs,
    peakMemoryBytes: peakMemBytes,
    peakMemoryMb: parseFloat(peakMemMb)
  };

  let results = [];
  if (fs.existsSync(RESULTS_FILE)) {
    results = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  }
  
  results.push(result);
  
  if (!fs.existsSync(path.dirname(RESULTS_FILE))) {
    fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  }
  
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
  console.log(`Results saved to ${RESULTS_FILE}`);
}

measure();
