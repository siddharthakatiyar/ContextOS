import fs from 'fs';

const data = JSON.parse(fs.readFileSync('scripts/bench/redis-results.json', 'utf8'));
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

console.log(`\nAccuracy (on ${totalTargeted} explicit file targets): ${correct}/${totalTargeted} (${((correct / totalTargeted) * 100).toFixed(2)}%)`);
