import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB } from '../storage/database.js';
import { Indexer } from '../indexer/index.js';

export const INDEXER_VERSION = 1;

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
    this.indexer = new Indexer(db);
    this.projectDir = projectDir;
  }

  public async startFullIndex(config: any) {
    if (this.isIndexing) return;
    this.isIndexing = true;
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
        '**/vendor/**'
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
        const statusFile = path.join(this.projectDir, '.contextos', 'status.json');
        fs.writeFileSync(
          statusFile,
          JSON.stringify({
            error: `Repository too large: ${this.totalFiles} files found. Maximum allowed is ${MAX_FILES}. Please narrow your indexablePatterns in .contextosconfig.`,
            fullIndexCompleted: false
          })
        );
        return;
      }

      console.log(`[BackgroundIndexer] Found ${this.totalFiles} files to index.`);

      // Process in batches yielding to the event loop
      const BATCH_SIZE = 10;

      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        const batch = files.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (file) => {
            try {
              const fileStat = fs.statSync(file);
              if (fileStat.size <= 100 * 1024) {
                await this.indexer.indexFile(file, 'repo');
              }
            } catch (e) {
              // Silently skip failed parses
            }
            this.processedFiles++;
          })
        );

        // Yield to the event loop so MCP server remains responsive
        await new Promise((resolve) => setImmediate(resolve));

        if (this.processedFiles % 1000 === 0) {
          console.log(`[BackgroundIndexer] Progress: ${this.processedFiles} / ${this.totalFiles}`);
          const statusFile = path.join(this.projectDir, '.contextos', 'status.json');
          fs.writeFileSync(
            statusFile,
            JSON.stringify({
              fullIndexCompleted: false,
              processed: this.processedFiles,
              total: this.totalFiles,
              progressPercentage: Math.round((this.processedFiles / this.totalFiles) * 100)
            })
          );
        }
      }

      // Mark full index as complete
      const statusFile = path.join(this.projectDir, '.contextos', 'status.json');
      fs.writeFileSync(
        statusFile,
        JSON.stringify({
          fullIndexCompleted: true,
          lastIndexTime: Date.now(),
          indexerVersion: INDEXER_VERSION
        })
      );
      console.log(
        `[BackgroundIndexer] Full index completed in ${(Date.now() - this.startTime) / 1000}s`
      );
    } catch (err: any) {
      console.error(`[BackgroundIndexer] Error during indexing: ${err.message}`);
    } finally {
      this.isIndexing = false;
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
