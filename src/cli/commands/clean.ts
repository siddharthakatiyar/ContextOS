import { Command } from 'commander';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { EmbeddingsStore } from '../../core/embeddings/embeddings-store.js';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';

interface CountRow {
  c: number;
}

interface JunkChunkRow {
  id: string;
  source_file: string;
}

export const cleanCommand = new Command('clean')
  .description('Purge polluted data (node_modules, junk) from ContextOS databases')
  .option('--rebuild', 'Delete and rebuild the database from scratch')
  .option('--global', 'Also clean the global database at ~/.contextos/')
  .action(async (opts) => {
    const dbs = DB.resolveDatabases();

    console.log(chalk.bold('\nContextOS Clean\n'));

    if (opts.rebuild) {
      // Nuclear option: delete the local DB and re-init
      const localDbPath = path.join(process.cwd(), '.contextos', 'index.db');
      if (fs.existsSync(localDbPath)) {
        fs.unlinkSync(localDbPath);
        // Also remove WAL/SHM files
        if (fs.existsSync(localDbPath + '-wal')) fs.unlinkSync(localDbPath + '-wal');
        if (fs.existsSync(localDbPath + '-shm')) fs.unlinkSync(localDbPath + '-shm');
        console.log(chalk.yellow(`Deleted local database: ${localDbPath}`));
        console.log(chalk.blue('Run `contextos init` to rebuild the index.'));
      } else {
        console.log('No local database found.');
      }

      if (opts.global) {
        const globalDbPath = path.join(getContextOSHome(), 'index.db');
        if (fs.existsSync(globalDbPath)) {
          fs.unlinkSync(globalDbPath);
          if (fs.existsSync(globalDbPath + '-wal')) fs.unlinkSync(globalDbPath + '-wal');
          if (fs.existsSync(globalDbPath + '-shm')) fs.unlinkSync(globalDbPath + '-shm');
          console.log(chalk.yellow(`Deleted global database: ${globalDbPath}`));
        }
      }
      return;
    }

    // Surgical clean: remove node_modules and other junk
    const JUNK_PATTERNS = [
      '%node_modules%',
      '%/.git/%',
      '%/dist/%',
      '%/build/%',
      '%/.next/%',
      '%/coverage/%',
      '%/__pycache__/%',
      '%/target/%'
    ];

    for (const db of dbs) {
      const dbInstance = db.getInstance();
      const dbName = dbInstance.name || 'in-memory';

      const beforeCount = (dbInstance.prepare('SELECT COUNT(*) as c FROM chunks').get() as CountRow)
        .c;

      let totalRemoved = 0;
      for (const pattern of JUNK_PATTERNS) {
        // Get chunk IDs first to cascade-delete relationships
        const junkChunks = dbInstance
          .prepare('SELECT id, source_file FROM chunks WHERE source_file LIKE ?')
          .all(pattern) as JunkChunkRow[];
        if (junkChunks.length === 0) continue;

        // Delete relationships sourced from junk chunks
        const deleteRels = dbInstance.prepare(
          'DELETE FROM relationships WHERE source_chunk_id = ?'
        );
        const deleteChunk = dbInstance.prepare('DELETE FROM chunks WHERE id = ?');

        // vec0 vectors have no FK support — garbage-collect them explicitly
        const embeddingsStore = new EmbeddingsStore(dbInstance);
        const junkIds = junkChunks.map((chunk) => chunk.id);

        const transaction = dbInstance.transaction(() => {
          embeddingsStore.deleteByChunkIds(junkIds);
          for (const chunk of junkChunks) {
            deleteRels.run(chunk.id);
            deleteChunk.run(chunk.id);
          }
          // indexed_files may not exist in older schema DBs
          try {
            dbInstance.prepare('DELETE FROM indexed_files WHERE path LIKE ?').run(pattern);
          } catch {}
        });
        transaction();

        totalRemoved += junkChunks.length;
      }

      const afterCount = (dbInstance.prepare('SELECT COUNT(*) as c FROM chunks').get() as CountRow)
        .c;

      if (totalRemoved > 0) {
        console.log(
          chalk.green(
            `✔ ${path.basename(dbName)}: removed ${totalRemoved} junk chunks (${beforeCount} → ${afterCount})`
          )
        );

        // Vacuum to reclaim space
        dbInstance.exec('VACUUM');
        console.log(chalk.dim(`  Vacuumed database to reclaim disk space.`));
      } else {
        console.log(chalk.dim(`✔ ${path.basename(dbName)}: already clean (${beforeCount} chunks)`));
      }
    }

    console.log(chalk.green.bold('\n✔ Clean complete.\n'));
  });
