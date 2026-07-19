import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { initCommand } from './init.js';
import { DB } from '../../core/storage/database.js';
import { backfillAllEmbeddings, isEmbeddingsAvailable } from '../../core/embeddings/index.js';

export const reindexCommand = new Command('reindex')
  .description('Force a complete re-index of the repository by clearing the local database')
  .option('--embeddings', 'Backfill chunk embeddings without wiping the DB (or after a full reindex)')
  .action(async (opts: { embeddings?: boolean }) => {
    const cwd = process.cwd();
    const repoContextDir = path.join(cwd, '.contextos');
    const dbPath = path.join(repoContextDir, 'index.db');
    const walPath = path.join(repoContextDir, 'index.db-wal');
    const shmPath = path.join(repoContextDir, 'index.db-shm');

    // Embeddings-only backfill: keep existing index, just (re)build vectors
    const abortController = new AbortController();
    const onSigInt = () => {
      console.log(chalk.red('\n\nAborting reindex...'));
      abortController.abort();
    };
    process.on('SIGINT', onSigInt);

    try {
      if (opts.embeddings && fs.existsSync(dbPath)) {
      if (!isEmbeddingsAvailable()) {
        console.log(chalk.yellow(
          'Embeddings are disabled (CONTEXTOS_EMBEDDINGS=0 or embeddingsEnabled=false). Nothing to do.'
        ));
        return;
      }
      console.log(chalk.blue.bold('Backfilling embeddings for existing chunks...'));
      console.log(chalk.dim('(Normal indexing also embeds on upsert; this forces a full backfill.)'));
      const db = new DB(dbPath);
      try {
        const n = await backfillAllEmbeddings(db.getInstance(), abortController.signal);
        console.log(chalk.green(`Embedding backfill complete (${n} chunks processed).`));
      } finally {
        db.close();
      }
      return;
    }

    console.log(chalk.yellow.bold(`Clearing local database at ${dbPath}...`));
    
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    if (fs.existsSync(walPath)) fs.unlinkSync(walPath);
    if (fs.existsSync(shmPath)) fs.unlinkSync(shmPath);

    console.log(chalk.green('Database cleared. Starting fresh initialization...'));
    console.log(chalk.dim('Embeddings are built automatically during indexFile when available.'));
    
    // Call the init command logic
    await initCommand.parseAsync(['node', 'contextos']);

    // Optional post-init embedding backfill (covers any chunks that skipped embed during index)
    if (opts.embeddings) {
      if (!isEmbeddingsAvailable()) {
        console.log(chalk.yellow('Embeddings unavailable after reindex — keyword-only index is ready.'));
        return;
      }
      console.log(chalk.blue.bold('\nEnsuring embeddings are backfilled...'));
      const db = new DB(dbPath);
      try {
        const n = await backfillAllEmbeddings(db.getInstance(), abortController.signal);
        console.log(chalk.green(`Embedding backfill complete (${n} chunks processed).`));
      } finally {
        db.close();
      }
    }
    } finally {
      process.off('SIGINT', onSigInt);
    }
  });
