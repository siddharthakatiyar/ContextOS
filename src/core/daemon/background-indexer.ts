import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB } from '../storage/database.js';
import { Indexer, MAX_INDEXABLE_FILE_BYTES } from '../indexer/index.js';
import { createIndexIgnore } from '../indexer/ignore.js';
import { getErrorMessage } from '../../utils/errors.js';
import { canonicalDirectory, writePrivateStateFile } from '../../utils/secure-state.js';
import { isGeneratedFile } from '../../utils/file-heuristics.js';

interface IndexConfig {
  ignorePatterns: string[];
  indexablePatterns: string[];
}

export const INDEXER_VERSION = 1;

// Single-flight guard at module level: the daemon's startup indexer and any
// watcher-burst indexer share one process, so a per-instance flag allowed two
// full indexes to run concurrently (duplicate work + racing status writes).
let activeFullIndex: Promise<void> | null = null;

/** Write JSON atomically (tmp + rename) so readers never see torn files. */
function writeJsonAtomic(filePath: string, data: unknown): void {
  // Status is auxiliary state but can contain indexing progress and paths. Use
  // the same owner-only, symlink-resistant writer as daemon state files.
  writePrivateStateFile(filePath, JSON.stringify(data));
}

export class BackgroundIndexer {
  private db: DB;
  private indexer?: Indexer;
  private isIndexing = false;
  private projectDir: string;

  // Progress tracking
  public totalFiles = 0;
  public processedFiles = 0;
  public startTime = 0;

  constructor(db: DB, projectDir: string) {
    this.db = db;
    // Explicit canonical traversal root — never depend on process.cwd() or a
    // symlink spelling matching the daemon's project directory.
    this.projectDir = canonicalDirectory(projectDir);
  }

  public startFullIndex(config: IndexConfig): Promise<void> {
    // Single-flight: activeFullIndex is cleared in .finally() when the run ends,
    // so any non-null value here means a full index is still running.
    if (activeFullIndex) {
      console.log('[BackgroundIndexer] Full index already running — skipping duplicate trigger.');
      return activeFullIndex;
    }
    this.isIndexing = true;
    activeFullIndex = this.runFullIndex(config).finally(() => {
      this.isIndexing = false;
      activeFullIndex = null;
    });
    return activeFullIndex;
  }

  private async runFullIndex(config: IndexConfig): Promise<void> {
    const statusFile = path.join(this.projectDir, '.contextos', 'status.json');
    this.startTime = Date.now();
    this.processedFiles = 0;
    this.totalFiles = 0;

    console.log('[BackgroundIndexer] Starting full repository index...');

    try {
      const indexIgnore = createIndexIgnore(this.projectDir, config.ignorePatterns || []);
      this.indexer = new Indexer(this.db, this.projectDir, config.ignorePatterns || []);

      const allRepoFiles = new Set<string>();
      for (const pattern of config.indexablePatterns) {
        const files = await glob(pattern, {
          cwd: this.projectDir,
          ignore: [...indexIgnore.globIgnore],
          absolute: true,
          nodir: true,
          follow: false
        });
        for (const f of files) {
          const lexicalPath = path.resolve(f);
          let stat: fs.Stats;
          try {
            // Do not let a glob's symlink entry become authoritative. Indexer
            // intentionally refuses symlinks, and retaining one here would
            // preserve stale rows forever during reconciliation.
            stat = fs.lstatSync(lexicalPath);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INDEXABLE_FILE_BYTES) {
              continue;
            }
          } catch (error) {
            // An entry disappearing during a scan is absent. Other read
            // failures are transient: keep the existing row until indexing
            // gets a chance to retry it.
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
            allRepoFiles.add(lexicalPath);
            continue;
          }

          let canonicalPath: string;
          try {
            canonicalPath = fs.realpathSync(lexicalPath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
            allRepoFiles.add(lexicalPath);
            continue;
          }
          if (
            canonicalPath !== this.projectDir &&
            !canonicalPath.startsWith(this.projectDir + path.sep)
          ) {
            continue;
          }
          if (indexIgnore.ignores(canonicalPath) || indexIgnore.ignores(lexicalPath)) continue;

          // Keep permanently non-indexable content out of the authoritative
          // set. If a read fails for another reason, treat it as transient and
          // retain the path so a later scan can recover it.
          try {
            const content = fs.readFileSync(canonicalPath, 'utf8');
            if (content.includes('\0')) continue;
            if (isGeneratedFile(canonicalPath, content)) continue;
          } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
            allRepoFiles.add(canonicalPath);
            continue;
          }
          allRepoFiles.add(canonicalPath);
        }
      }

      const files = Array.from(allRepoFiles);
      this.totalFiles = files.length;

      const MAX_FILES = 1_000_000;
      if (this.totalFiles > MAX_FILES) {
        console.error(
          `[BackgroundIndexer] Repository too large: ${this.totalFiles} files found. Maximum allowed is ${MAX_FILES}.`
        );
        writeJsonAtomic(statusFile, {
          error: `Repository too large: ${this.totalFiles} files found. Maximum allowed is ${MAX_FILES}. Please narrow your indexablePatterns in .contextosconfig.`,
          fullIndexCompleted: false
        });
        return;
      }

      console.log(`[BackgroundIndexer] Found ${this.totalFiles} files to index.`);

      // Process in batches yielding to the event loop
      const BATCH_SIZE = 10;
      let skippedTooLarge = 0;

      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (file) => {
            try {
              const fileStat = fs.statSync(file);
              // Same size cap as the incremental/watcher path so coverage does
              // not depend on which indexing route touched a file first.
              if (fileStat.size <= MAX_INDEXABLE_FILE_BYTES) {
                await this.indexer?.indexFile(file, 'repo');
              } else {
                skippedTooLarge++;
              }
            } catch {
              // Silently skip failed parses
            }
            this.processedFiles++;
          })
        );

        // Yield to the event loop so MCP server remains responsive
        await new Promise((resolve) => setImmediate(resolve));

        if (this.processedFiles % 1000 === 0) {
          console.log(`[BackgroundIndexer] Progress: ${this.processedFiles} / ${this.totalFiles}`);
          writeJsonAtomic(statusFile, {
            fullIndexCompleted: false,
            processed: this.processedFiles,
            total: this.totalFiles,
            progressPercentage: Math.round((this.processedFiles / this.totalFiles) * 100)
          });
        }
      }

      if (skippedTooLarge > 0) {
        console.log(
          `[BackgroundIndexer] Skipped ${skippedTooLarge} file(s) larger than ${Math.round(
            MAX_INDEXABLE_FILE_BYTES / 1024
          )}KB.`
        );
      }

      // A successful scan is also a reconciliation point. Remove rows from a
      // previous full scan when a source was deleted or became ignored. Keep
      // other layers (manual facts/workspace/global indexes) untouched.
      await this.indexer?.removeFilesNotIn(files, 'repo');

      // Mark full index as complete
      writeJsonAtomic(statusFile, {
        fullIndexCompleted: true,
        lastIndexTime: Date.now(),
        indexerVersion: INDEXER_VERSION
      });
      console.log(
        `[BackgroundIndexer] Full index completed in ${(Date.now() - this.startTime) / 1000}s`
      );
    } catch (error) {
      console.error(`[BackgroundIndexer] Error during indexing: ${getErrorMessage(error)}`);
    }
  }

  public getStatus() {
    return {
      isIndexing: this.isIndexing,
      processedFiles: this.processedFiles,
      totalFiles: this.totalFiles,
      progressPercentage:
        this.totalFiles > 0 ? Math.round((this.processedFiles / this.totalFiles) * 100) : 0,
      runningTimeMs: this.isIndexing ? Date.now() - this.startTime : 0
    };
  }
}
