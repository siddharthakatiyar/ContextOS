import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const EXAMPLES_DIR = path.join(import.meta.dirname, '../retrieval-examples');
const CONTEXTOS_BIN = path.join(import.meta.dirname, '../dist/bin/contextos.js');

function runBenchmark() {
  const dirs = fs.readdirSync(EXAMPLES_DIR).filter(d => fs.statSync(path.join(EXAMPLES_DIR, d)).isDirectory());
  
  let totalQueries = 0;
  let passedQueries = 0;
  let totalRecall = 0;
  
  for (const dir of dirs) {
    // if (dir === 'large-generated') continue; // Skip large repo for this quick test

    const dirPath = path.join(EXAMPLES_DIR, dir);
    const benchmarkFile = path.join(dirPath, 'benchmark.json');
    
    if (!fs.existsSync(benchmarkFile)) continue;
    
    console.log(`\n--- Benchmarking ${dir} ---`);
    const benchmarks = JSON.parse(fs.readFileSync(benchmarkFile, 'utf8'));
    
    // Init the project
    try {
      execSync(`node ${CONTEXTOS_BIN} init`, { cwd: dirPath });
    } catch (e: any) {
      console.error(`Failed to init ContextOS in ${dir}:`, e.message, e.stdout?.toString(), e.stderr?.toString());
      continue;
    }
    
    for (const bm of benchmarks) {
      totalQueries++;
      const query = bm.query;
      const expectedFiles: string[] = bm.expectedFiles;
      
      try {
        const out = execSync(`node ${CONTEXTOS_BIN} query "${query}" --json`, { 
          cwd: dirPath, 
          stdio: 'pipe',
          maxBuffer: 10 * 1024 * 1024 // 10MB
        }).toString();
        const results = JSON.parse(out);
        
        // Extract paths from context
        const sourceFiles = new Set<string>();
        for (const chunk of results.chunks) {
          if (chunk.sourceFile) {
            // E.g. "/Volumes/.../retrieval-examples/express-auth-routing/middleware/auth.ts"
            // We want to match against "middleware/auth.ts"
            const relativePath = path.relative(dirPath, chunk.sourceFile).replace(/\\/g, '/');
            sourceFiles.add(relativePath);
          }
        }
        
        let foundCount = 0;
        let missingFiles: string[] = [];
        
        for (const file of expectedFiles) {
          if (sourceFiles.has(file)) {
            foundCount++;
          } else {
            missingFiles.push(file);
          }
        }
        
        const recall = foundCount / expectedFiles.length;
        const minRecall = bm.minRecall !== undefined ? bm.minRecall : 1.0;
        const passed = recall >= minRecall;
        
        if (passed) passedQueries++;
        totalRecall += recall;
        
        console.log(`Query: "${query}"`);
        console.log(`  Recall: ${(recall * 100).toFixed(0)}% (${foundCount}/${expectedFiles.length})`);
        console.log(`  Tokens: ${results.tokens || 'unknown'}`);
        if (!passed) {
          console.log(`  FAIL: Missing files: ${missingFiles.join(', ')}`);
        } else {
          console.log(`  PASS`);
        }
      } catch (e: any) {
        console.error(`Error running query: "${query}"`);
        console.error(e.message);
      }
    }
  }
  
  console.log(`\n=== Benchmark Summary ===`);
  console.log(`Passed ${passedQueries} / ${totalQueries} queries (${((passedQueries / totalQueries) * 100).toFixed(1)}%)`);
  console.log(`Average Recall: ${((totalRecall / totalQueries) * 100).toFixed(1)}%`);
}

runBenchmark();
