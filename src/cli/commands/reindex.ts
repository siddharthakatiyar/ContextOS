import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { initCommand } from './init.js';

export const reindexCommand = new Command('reindex')
  .description('Force a complete re-index of the repository by clearing the local database')
  .action(async () => {
    const cwd = process.cwd();
    const repoContextDir = path.join(cwd, '.contextos');
    const dbPath = path.join(repoContextDir, 'index.db');
    const walPath = path.join(repoContextDir, 'index.db-wal');
    const shmPath = path.join(repoContextDir, 'index.db-shm');

    console.log(chalk.yellow.bold(`Clearing local database at ${dbPath}...`));
    
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    console.log(chalk.green('Database cleared. Starting fresh initialization...'));
    
    // Call the init command logic
    await initCommand.parseAsync(['node', 'contextos', 'init']);
  });
