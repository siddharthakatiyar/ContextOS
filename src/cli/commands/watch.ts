import { Command } from 'commander';
import chokidar from 'chokidar';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { DB } from '../../core/storage/database.js';
import { Indexer } from '../../core/indexer/index.js';
import { loadConfig } from '../../config/index.js';
import { glob } from 'glob';
import { getErrorMessage } from '../../utils/errors.js';
import { createIndexIgnore } from '../../core/indexer/ignore.js';
import { canonicalDirectory } from '../../utils/secure-state.js';

export const watchCommand = new Command('watch')
  .description('Watch the current directory for changes and live re-index')
  .option('-w, --workspace <name>', 'Workspace name')
  .action(async (options) => {
    const cwd = canonicalDirectory(process.cwd());
    const config = loadConfig({ cwd });
    const indexIgnore = createIndexIgnore(cwd, config.ignorePatterns);
    const root = indexIgnore.root;
    const db = new DB(path.join(root, '.contextos', 'index.db'));
    const indexer = new Indexer(db, root, config.ignorePatterns);

    console.log(chalk.blue.bold(`\nContextOS Watch Mode Started`));
    console.log(`Watching: ${root}\n`);

    const spinner = ora('Initializing watch mode...').start();

    // Re-index all existing files on startup to ensure we're up to date
    try {
      const files = await glob(config.indexablePatterns, {
        cwd: root,
        ignore: [...indexIgnore.globIgnore],
        absolute: true,
        nodir: true,
        follow: false
      });
      const indexableFiles = files.filter((file) => !indexIgnore.ignores(file));

      let processed = 0;
      for (const file of indexableFiles) {
        await indexer.indexFile(file, 'workspace', options.workspace);
        processed++;
        spinner.text = `Initial sync: Indexed ${processed}/${indexableFiles.length} files...`;
      }
      spinner.succeed(`Initial sync complete. Indexed ${processed} files.`);
    } catch (error) {
      spinner.fail(`Failed initial sync: ${getErrorMessage(error)}`);
    }

    // Set up file watcher
    const watcher = chokidar.watch(root, {
      ignored: (filePath: string, stats?: import('node:fs').Stats) => {
        const normalized = filePath.replace(/\\/g, '/');
        const parts = normalized.split('/');
        const hasDisallowedDot = parts.some(
          (part) => part.startsWith('.') && part !== '.' && part !== '..' && part !== '.cursor'
        );
        // Chokidar omits stats for unlink events. Let those through so a file
        // removed after an ignore rule change cannot leave stale rows behind.
        return hasDisallowedDot || (stats !== undefined && indexIgnore.ignores(filePath));
      },
      persistent: true,
      ignoreInitial: true,
      followSymlinks: false
    });

    watcher
      .on('add', async (filePath) => {
        const ext = path.extname(filePath);
        if (!ext) return;

        console.log(chalk.gray(`[ADD] ${path.relative(root, filePath)}`));
        try {
          await indexer.indexFile(filePath, 'workspace', options.workspace);
        } catch (error) {
          console.error(chalk.red(`Failed to index ${filePath}: ${getErrorMessage(error)}`));
        }
      })
      .on('change', async (filePath) => {
        const ext = path.extname(filePath);
        if (!ext) return;

        console.log(chalk.yellow(`[CHANGE] ${path.relative(root, filePath)}`));
        try {
          await indexer.indexFile(filePath, 'workspace', options.workspace);
        } catch (error) {
          console.error(chalk.red(`Failed to update ${filePath}: ${getErrorMessage(error)}`));
        }
      })
      .on('unlink', async (filePath) => {
        console.log(chalk.red(`[DELETE] ${path.relative(root, filePath)}`));
        try {
          await indexer.removeFile(filePath);
        } catch (error) {
          console.error(
            chalk.red(`Failed to remove ${filePath} from index: ${getErrorMessage(error)}`)
          );
        }
      });

    process.on('SIGINT', () => {
      console.log(chalk.blue('\nStopping watch mode...'));
      watcher.close();
      process.exit(0);
    });
  });
