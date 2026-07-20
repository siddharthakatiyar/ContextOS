import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const mkdir = promisify(fs.mkdir);
const writeFile = promisify(fs.writeFile);

const OUT_DIR = path.join(import.meta.dirname, '../retrieval-examples/large-generated');
const NUM_MODULES = 100;
const FILES_PER_MODULE = 500; // 50k files total

async function generate() {
  console.log(`Generating large repository benchmark in ${OUT_DIR}...`);
  
  if (!fs.existsSync(OUT_DIR)) {
    await mkdir(OUT_DIR, { recursive: true });
  }

  // Create a barrel file for the root
  let rootIndexContent = '';

  for (let m = 0; m < NUM_MODULES; m++) {
    const modDir = path.join(OUT_DIR, `module_${m}`);
    if (!fs.existsSync(modDir)) {
      await mkdir(modDir);
    }

    let modIndexContent = '';

    for (let f = 0; f < FILES_PER_MODULE; f++) {
      const fileName = `file_${f}.ts`;
      const filePath = path.join(modDir, fileName);
      const funcName = `doWork_m${m}_f${f}`;
      
      // Simulate interconnected graph: file N imports from file N-1
      let imports = '';
      let usage = '';
      if (f > 0) {
        const prevFunc = `doWork_m${m}_f${f-1}`;
        imports = `import { ${prevFunc} } from './file_${f-1}';\n`;
        usage = `  ${prevFunc}();\n`;
      } else if (m > 0) {
        // First file in module imports from last file in previous module
        const prevFunc = `doWork_m${m-1}_f${FILES_PER_MODULE-1}`;
        imports = `import { ${prevFunc} } from '../module_${m-1}/file_${FILES_PER_MODULE-1}';\n`;
        usage = `  ${prevFunc}();\n`;
      }

      const content = `${imports}\nexport function ${funcName}() {\n${usage}  return "Data from module ${m} file ${f}";\n}\n`;
      
      await writeFile(filePath, content);
      modIndexContent += `export * from './${fileName.replace('.ts', '')}';\n`;
    }

    await writeFile(path.join(modDir, 'index.ts'), modIndexContent);
    rootIndexContent += `export * as Module${m} from './module_${m}';\n`;
    
    if (m % 10 === 0) {
      console.log(`Generated ${m + 1} / ${NUM_MODULES} modules...`);
    }
  }

  await writeFile(path.join(OUT_DIR, 'index.ts'), rootIndexContent);
  
  // Write README
  await writeFile(path.join(OUT_DIR, 'README.md'), `# Large Generated Benchmark\n\nGenerated 50k files with cross-module dependencies to test SQLite scale and BFS max-depth cutoffs.`);
  
  console.log('Done generating 50,000 files.');
}

generate().catch(console.error);
