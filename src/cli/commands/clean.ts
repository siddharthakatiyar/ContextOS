import { Command } from 'commander';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { EmbeddingsStore } from '../../core/embeddings/embeddings-store.js';
import chalk from 'chalk';
import path from 'path';
import { canonicalDirectory, removePrivateStateFile } from '../../utils/secure-state.js';

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
    const cwd = canonicalDirectory(process.cwd());
    const dbs = DB.resolveDatabases(cwd);

    console.log(chalk.bold('\nContextOS Clean\n'));

    if (opts.rebuild) {
      // Close all handles before unlinking SQLite files, then validate every
      // state path so a symlinked .contextos directory cannot redirect cleanup.
      for (const db of dbs) db.close();

      // Nuclear option: delete the local DB and re-init
      const localDbPath = path.join(cwd, '.contextos', 'index.db');
      const localDbDeleted = removePrivateStateFile(localDbPath);
      const localWalDeleted = removePrivateStateFile(localDbPath + '-wal');
      const localShmDeleted = removePrivateStateFile(localDbPath + '-shm');
      if (localDbDeleted || localWalDeleted || localShmDeleted) {
        console.log(chalk.yellow(`Deleted local database: ${localDbPath}`));
        console.log(chalk.blue('Run `contextos init` to rebuild the index.'));
      } else {
        console.log('No local database found.');
      }

      if (opts.global) {
        const globalDbPath = path.join(getContextOSHome(), 'index.db');
        const globalDbDeleted = removePrivateStateFile(globalDbPath);
        const globalWalDeleted = removePrivateStateFile(globalDbPath + '-wal');
        const globalShmDeleted = removePrivateStateFile(globalDbPath + '-shm');
        if (globalDbDeleted || globalWalDeleted || globalShmDeleted) {
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
