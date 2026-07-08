import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { loadConfig } from '../../config/index.js';

export const statusCommand = new Command('status')
  .description('Show the status of the local ContextOS index')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const cwd = process.cwd();
    const config = loadConfig();
    const dbs = DB.resolveDatabases(cwd);
    
    try {
      const results = [];
      let totalSize = 0;
      let totalFiles = 0;
      let totalChunks = 0;
      let totalRels = 0;

    for (const dbInst of dbs) {
      const db = dbInst.getInstance();
      
      const fileCount = (db.prepare('SELECT COUNT(*) as count FROM files').get() as any).count;
      const chunkCount = (db.prepare('SELECT COUNT(*) as count FROM chunks').get() as any).count;
      const relCount = (db.prepare('SELECT COUNT(*) as count FROM relationships').get() as any).count;
      
      let dbSize = 0;
      if (fs.existsSync(db.name)) {
        dbSize = fs.statSync(db.name).size;
      }
      
      const layerType = db.name.includes(getContextOSHome()) ? 'Global' : 'Local';

      results.push({
        path: db.name,
        layer: layerType,
        sizeBytes: dbSize,
        sizeMb: (dbSize / (1024 * 1024)).toFixed(2),
        files: fileCount,
        chunks: chunkCount,
        relationships: relCount
      });

      totalSize += dbSize;
      totalFiles += fileCount;
      totalChunks += chunkCount;
      totalRels += relCount;
    }

    if (options.json) {
      console.log(JSON.stringify({
        databases: results,
        totals: {
          sizeBytes: totalSize,
          sizeMb: parseFloat((totalSize / (1024 * 1024)).toFixed(2)),
          files: totalFiles,
          chunks: totalChunks,
          relationships: totalRels
        }
      }, null, 2));
      return;
    }

    console.log(chalk.bold(`\nContextOS Status`));
    console.log(`==================\n`);

    for (const res of results) {
      console.log(chalk.blue.bold(`[${res.layer} Database]`));
      console.log(`Path:          ${res.path}`);
      console.log(`Size:          ${res.sizeMb} MB`);
      console.log(`Files Indexed: ${res.files}`);
      console.log(`Chunks:        ${res.chunks}`);
      console.log(`Relationships: ${res.relationships}`);
      console.log('');
    }

      console.log(chalk.green.bold(`[Total Aggregated]`));
      console.log(`Size:          ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Files Indexed: ${totalFiles}`);
      console.log(`Chunks:        ${totalChunks}`);
      console.log(`Relationships: ${totalRels}\n`);
    } finally {
      for (const dbInst of dbs) {
        dbInst.close();
      }
    }
  });
