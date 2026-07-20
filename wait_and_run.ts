import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const dir = path.join(process.cwd(), 'retrieval-examples/large-generated');
const statusPath = path.join(dir, '.contextos/status.json');

console.log("Waiting for background indexing to complete...");
let completed = false;
while (!completed) {
  if (fs.existsSync(statusPath)) {
    const status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
    if (status.fullIndexCompleted) {
      completed = true;
      break;
    }
  }
  execSync('sleep 10');
}
console.log("Indexing completed. Running full benchmark suite...");
try {
  const out = execSync(`npx tsx scripts/run-benchmarks.ts`).toString();
  console.log("Benchmark Output:");
  console.log(out);
} catch (e) {
  console.error("Benchmark failed", e);
}
