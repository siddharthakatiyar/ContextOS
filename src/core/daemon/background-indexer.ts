import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB } from '../storage/database.js';
import { Indexer, MAX_INDEXABLE_FILE_BYTES } from '../indexer/index.js';
import { getErrorMessage } from '../../utils/errors.js';

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
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

export class BackgroundIndexer {
  private db: DB;
  private indexer: Indexer;
  private isIndexing = false;
  private projectDir: string;

  // Progress tracking
  public totalFiles = 0;
  public processedFiles = 0;
  public startTime = 0;

  constructor(db: DB, projectDir: string) {
    this.db = db;
    // Explicit traversal root — never depend on process.cwd() matching projectDir
    this.indexer = new Indexer(db, projectDir);
    this.projectDir = projectDir;
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
      const SAFETY_IGNORE = [
        '**/node_modules/**',
        '**/.git/**',
        '**/dist/**',
        '**/build/**',
        '**/.next/**',
        '**/coverage/**',
        '**/__pycache__/**',
        '**/target/**',
        '**/*.min.js',
        '**/*.min.css',
        '**/*.map',
        '**/*.lock',
        '**/vendor/**',
        // Never index our own internal state directory
        '**/.contextos/**'
      ];
      const userIgnore = config.ignorePatterns || [];
      const ignore = [...new Set([...SAFETY_IGNORE, ...userIgnore])];

      const allRepoFiles = new Set<string>();
      for (const pattern of config.indexablePatterns) {
        const files = await glob(pattern, {
          cwd: this.projectDir,
          ignore,
          absolute: true,
          nodir: true,
          follow: false
        });
        for (const f of files) allRepoFiles.add(f);
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
                await this.indexer.indexFile(file, 'repo');
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
