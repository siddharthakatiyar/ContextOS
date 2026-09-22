import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const resultsPath = process.env.CONTEXTOS_REDIS_RESULTS || path.join(scriptDir, 'redis-results.json');
const data = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
const results = data.results;

let correct = 0;
let totalTargeted = 0;

for (const res of results) {
  if (res.type === 'specific') {
    const match = res.query.match(/([a-zA-Z0-9_]+\.[ch])/);
    if (match) {
      totalTargeted++;
      const expectedFile = match[1];
      // check if any of the matchedFiles ends with expectedFile
      const found = res.matchedFiles.some(f => f && f.endsWith(expectedFile));
      if (found) {
        correct++;
      } else {
        console.log(`❌ Failed: ${res.query}`);
        console.log(`   Expected: ${expectedFile}`);
        console.log(`   Got: ${res.matchedFiles.join(', ')}`);
      }
    }
  }
}

const accuracy = totalTargeted ? (correct / totalTargeted) * 100 : 0;
console.log(`\nAccuracy (on ${totalTargeted} explicit file targets): ${correct}/${totalTargeted} (${accuracy.toFixed(2)}%)`);
