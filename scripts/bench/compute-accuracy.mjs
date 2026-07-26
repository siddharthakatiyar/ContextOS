import fs from 'fs';
import path from 'path';

const resultsFile = path.join(process.cwd(), 'scripts', 'bench', 'redis-results.json');
const mapFile = path.join(process.cwd(), 'scripts', 'bench', 'expected-files-map.json');

const results = JSON.parse(fs.readFileSync(resultsFile, 'utf8')).results;
const expectedMap = JSON.parse(fs.readFileSync(mapFile, 'utf8'));

let targetedHits = 0;
let genericHits = 0;
let targetedTotal = 0;
let genericTotal = 0;

for (const result of results) {
  const expectedFiles = expectedMap[result.id];
  if (!expectedFiles) {
    console.warn(`No expected files for ${result.id}`);
    continue;
  }
  
  // A hit is when at least one expected file is in the matchedFiles
  const matched = result.matchedFiles || [];
  const hit = expectedFiles.some(f => matched.some(m => m.endsWith(f)));
  
  if (result.type === 'specific') {
    targetedTotal++;
    if (hit) targetedHits++;
  } else {
    genericTotal++;
    if (hit) genericHits++;
  }
}

console.log(`Targeted Accuracy: ${targetedHits} / ${targetedTotal} (${((targetedHits/targetedTotal)*100).toFixed(1)}%)`);
console.log(`Generic Accuracy: ${genericHits} / ${genericTotal} (${((genericHits/genericTotal)*100).toFixed(1)}%)`);
console.log(`Overall Accuracy: ${targetedHits + genericHits} / ${targetedTotal + genericTotal} (${(((targetedHits + genericHits) / (targetedTotal + genericTotal))*100).toFixed(1)}%)`);
