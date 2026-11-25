import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB } from '../storage/database.js';
import { Indexer, MAX_INDEXABLE_FILE_BYTES } from '../indexer/index.js';
import { createIndexIgnore } from '../indexer/ignore.js';
import { getErrorMessage } from '../../utils/errors.js';
import { canonicalDirectory, writePrivateStateFile } from '../../utils/secure-state.js';
import { pLimit } from '../../utils/async.js';
import { isGeneratedFile } from '../../utils/file-heuristics.js';

interface IndexConfig {
  ignorePatterns: string[];
  indexablePatterns: string[];
}

export const INDEXER_VERSION = 2;
export const MAX_INDEX_FAILURE_DETAILS = 100;

interface FileFailure {
  path: string;
  error: string;
}

// Single-flight guard at module level: the daemon's startup indexer and any
// watcher-burst indexer share one process, so a per-instance flag allowed two
// full indexes to run concurrently (duplicate work + racing status writes).
const activeFullIndexes = new Map<string, Promise<void>>();
const scheduleFullIndex = pLimit(2);

export async function waitForBackgroundIndexing(root?: string): Promise<void> {
  const prefix = root ? canonicalDirectory(root) + '\0' : undefined;
  while (true) {
    const pending = [...activeFullIndexes.entries()]
      .filter(([key]) => !prefix || key.startsWith(prefix))
      .map(([, job]) => job);
    if (!pending.length) return;
    await Promise.all(pending);
  }
}

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

  constructor(
    db: DB,
    projectDir: string,
    private stateDir?: string,
    private assertCurrent?: () => void,
    private log: (message: string) => void = (message) => console.error(message)
  ) {
    this.db = db;
    // Explicit canonical traversal root — never depend on process.cwd() or a
    // symlink spelling matching the daemon's project directory.
    this.projectDir = canonicalDirectory(projectDir);
  }

  public startFullIndex(config: IndexConfig, failedOnly = false): Promise<void> {
    const key = this.projectDir + '\0' + this.db.getInstance().name;
    const active = activeFullIndexes.get(key);
    if (active) return active;
    this.isIndexing = true;
    this.lastError = null;
    const job = scheduleFullIndex(() => this.runFullIndex(config, failedOnly)).finally(() => {
      this.isIndexing = false;
      activeFullIndexes.delete(key);
    });
    activeFullIndexes.set(key, job);
    return job;
  }

  public lastError: string | null = null;

  private async runFullIndex(config: IndexConfig, failedOnly: boolean): Promise<void> {
    const statusFile = path.join(
      this.stateDir ?? path.dirname(this.db.getInstance().name),
      'status.json'
    );
    const failuresFile = path.join(path.dirname(statusFile), 'failed-index-files.json');
    const failures: FileFailure[] = [];
    let previous:
      | {
          failedFileCount?: number;
          failedFiles?: FileFailure[];
          failureDetailsTruncated?: boolean;
          successfulFiles?: number;
          error?: string;
          fileFailuresOnly?: boolean;
        }
      | undefined;
    let pending: FileFailure[] | undefined;
    const completed = new Set<string>();
    let completeFailureList = false;
    let retainedSuccesses = 0;
    let fileFailuresOnly = false;
    const progress = () => ({
      processed: this.processedFiles,
      total: this.totalFiles,
      progressPercentage: this.totalFiles
        ? Math.round((this.processedFiles / this.totalFiles) * 100)
        : this.lastError
          ? 0
          : 100,
      failedFileCount: failures.length,
      failedFiles: failures.slice(0, MAX_INDEX_FAILURE_DETAILS),
      failureDetailsTruncated: failures.length > MAX_INDEX_FAILURE_DETAILS,
      scanType: failedOnly ? 'failed-files' : 'full'
    });
    this.startTime = Date.now();
    this.processedFiles = 0;
    this.totalFiles = 0;

    this.log('[BackgroundIndexer] Starting full repository index...');

    try {
      if (failedOnly) {
        previous = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
        retainedSuccesses = previous?.successfulFiles ?? 0;
        pending = previous?.failedFileCount
          ? JSON.parse(fs.readFileSync(failuresFile, 'utf8'))
          : [];
        if (previous?.error && !previous.fileFailuresOnly)
          throw new Error('The previous scan had a scan/storage failure; run a full reindex.');
      }
      const indexIgnore = createIndexIgnore(this.projectDir, config.ignorePatterns || []);
      this.assertCurrent?.();
      this.indexer = new Indexer(
        this.db,
        this.projectDir,
        config.ignorePatterns || [],
        this.assertCurrent
      );

      const allRepoFiles = new Set<string>();
      if (failedOnly) {
        for (const failure of pending ?? []) {
          const file = path.resolve(failure.path);
          if (!file.startsWith(this.projectDir + path.sep))
            throw new Error('Failed-file retry path is outside the project');
          allRepoFiles.add(file);
        }
      }
      for (const pattern of failedOnly ? [] : config.indexablePatterns) {
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
        throw new Error(
          `Repository too large: ${this.totalFiles} files found. Maximum allowed is ${MAX_FILES}. Please narrow your indexablePatterns in .contextosconfig.`
        );
      }

      this.log(`[BackgroundIndexer] Found ${this.totalFiles} files to index.`);
      writeJsonAtomic(statusFile, {
        fullIndexCompleted: false,
        processed: 0,
        total: this.totalFiles,
        progressPercentage: 0
      });

      // Process in batches yielding to the event loop
      const BATCH_SIZE = 10;
      let skippedTooLarge = 0;
      let successfulFiles = retainedSuccesses;
      let fatalError: unknown;

      for (let i = 0; i < files.length; i += BATCH_SIZE) {
        this.assertCurrent?.();
        const batch = files.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batch.map(async (file) => {
            try {
              if (failedOnly && indexIgnore.ignores(file)) {
                await this.indexer?.removeFile(file, 'repo');
                successfulFiles++;
                return;
              }
              let fileStat: fs.Stats;
              try {
                fileStat = fs.statSync(file);
              } catch (error) {
                // A deleted failed file is resolved. Permission and other I/O
                // errors must remain failures rather than deleting stale rows.
                if (!failedOnly || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                await this.indexer?.removeFile(file, 'repo');
                successfulFiles++;
                return;
              }
              // Same size cap as the incremental/watcher path so coverage does
              // not depend on which indexing route touched a file first.
              if (fileStat.size <= MAX_INDEXABLE_FILE_BYTES) {
                await this.indexer?.indexFile(file, 'repo');
                successfulFiles++;
              } else {
                skippedTooLarge++;
                if (failedOnly) {
                  await this.indexer?.removeFile(file, 'repo');
                  successfulFiles++;
                }
              }
            } catch (error) {
              console.error(`[BackgroundIndexer] Failed ${file}: ${getErrorMessage(error)}`);
              failures.push({ path: file, error: getErrorMessage(error).slice(0, 1000) });
              // SQLite errors invalidate the whole scan; checkout/lease checks run below.
              if (
                String((error as NodeJS.ErrnoException).code ?? '').startsWith('SQLITE_') ||
                /database.*(?:closed|not open)/i.test(getErrorMessage(error))
              )
                fatalError = error;
            } finally {
              completed.add(file);
              this.processedFiles++;
            }
          })
        );

        this.assertCurrent?.();
        if (fatalError) throw fatalError;

        // Yield to the event loop so MCP server remains responsive
        await new Promise((resolve) => setImmediate(resolve));

        if (this.processedFiles % 1000 === 0) {
          this.log(`[BackgroundIndexer] Progress: ${this.processedFiles} / ${this.totalFiles}`);
          writeJsonAtomic(statusFile, {
            fullIndexCompleted: false,
            processed: this.processedFiles,
            total: this.totalFiles,
            progressPercentage: Math.round((this.processedFiles / this.totalFiles) * 100)
          });
        }
      }

      if (skippedTooLarge > 0) {
        this.log(
          `[BackgroundIndexer] Skipped ${skippedTooLarge} file(s) larger than ${Math.round(
            MAX_INDEXABLE_FILE_BYTES / 1024
          )}KB.`
        );
      }

      completeFailureList = true;
      writeJsonAtomic(failuresFile, failures);
      if (failures.length > 0 && successfulFiles === 0) {
        fileFailuresOnly = true;
        throw new Error(
          `All ${failures.length} file(s) failed to index; retry with contextos reindex --failed.`
        );
      }
      this.assertCurrent?.();
      // A successful scan is also a reconciliation point. Remove rows from a
      // previous full scan when a source was deleted or became ignored. Keep
      // other layers (manual facts/workspace/global indexes) untouched.
      if (!failedOnly) await this.indexer?.removeFilesNotIn(files, 'repo');

      // Mark full index as complete
      writeJsonAtomic(statusFile, {
        ...progress(),
        successfulFiles,
        partial: failures.length > 0,
        warning: failures.length
          ? `${failures.length} file(s) failed to index; retry with contextos reindex --failed.`
          : null,
        fullIndexCompleted: true,
        lastIndexTime: Date.now(),
        indexerVersion: INDEXER_VERSION
      });
      if (failures.length)
        this.log(
          `[BackgroundIndexer] ${failures.length} file(s) failed; retry with contextos reindex --failed.`
        );
      this.log(
        `[BackgroundIndexer] Full index completed in ${(Date.now() - this.startTime) / 1000}s`
      );
    } catch (error) {
      this.lastError = getErrorMessage(error);
      if (!failedOnly || completeFailureList) {
        writeJsonAtomic(failuresFile, failures);
      } else if (pending && completed.size) {
        // Preserve every unattempted retry when a lease/storage failure aborts a batch.
        failures.push(...pending.filter((entry) => !completed.has(path.resolve(entry.path))));
        writeJsonAtomic(failuresFile, failures);
      }
      writeJsonAtomic(statusFile, {
        ...progress(),
        ...(!completeFailureList && failedOnly && previous
          ? {
              failedFileCount: previous.failedFileCount ?? 0,
              failedFiles: previous.failedFiles ?? [],
              failureDetailsTruncated: previous.failureDetailsTruncated ?? false
            }
          : {}),
        fileFailuresOnly,
        successfulFiles: retainedSuccesses,
        fullIndexCompleted: false,
        error: this.lastError
      });
      console.error(`[BackgroundIndexer] Error during indexing: ${getErrorMessage(error)}`);
    }
  }

  public getStatus() {
    return {
      isIndexing: this.isIndexing,
      processedFiles: this.processedFiles,
      totalFiles: this.totalFiles,
      progressPercentage:
        this.totalFiles > 0
          ? Math.round((this.processedFiles / this.totalFiles) * 100)
          : this.startTime > 0 && !this.isIndexing && !this.lastError
            ? 100
            : 0,
      runningTimeMs: this.isIndexing ? Date.now() - this.startTime : 0
    };
  }
}
