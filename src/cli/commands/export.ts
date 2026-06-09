import { Command } from 'commander';
import { DB } from '../../core/storage/database.js';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';

export const exportCommand = new Command('export')
  .description('Export the ContextOS graph to a JSON file for sharing')
  .argument('<outfile>', 'Output JSON file path')
  .action(async (outfile: string) => {
    const db = new DB();
    const spinner = ora('Exporting graph data...').start();
    
    try {
      const dbInstance = db.getInstance();
      
      const chunks = dbInstance.prepare('SELECT * FROM chunks').all();
      const relationships = dbInstance.prepare('SELECT * FROM relationships').all();
      const files = dbInstance.prepare('SELECT * FROM files').all();
      
      const exportData = {
        version: '0.2.0',
        exportedAt: Date.now(),
        data: {
          chunks,
          relationships,
          files
        }
      };
      
      const outPath = path.resolve(process.cwd(), outfile);
      fs.writeFileSync(outPath, JSON.stringify(exportData, null, 2));
      
      spinner.succeed(`Exported ${chunks.length} chunks, ${relationships.length} relationships, and ${files.length} files to ${chalk.green(outfile)}`);
    } catch (e: any) {
      spinner.fail(`Export failed: ${e.message}`);
    }
  });
