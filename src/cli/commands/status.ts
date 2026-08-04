import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { getErrorCode } from '../../utils/errors.js';

interface CountRow {
  count: number;
}

interface IndexingStatus {
  fullIndexCompleted?: boolean;
  processed?: number;
  total?: number;
  progressPercentage?: number;
}

export const statusCommand = new Command('status')
  .description('Show the status of the local ContextOS index')
  .option('--json', 'Output in JSON format')
  .action(async (options) => {
    const cwd = process.cwd();
    const dbs = DB.resolveDatabases(cwd);

    // Check daemon status
    let daemonStatus = 'Stopped';
    let daemonPid: number | null = null;
    const pidPath = path.join(cwd, '.contextos', 'daemon.pid');
    if (fs.existsSync(pidPath)) {
      try {
        const pidStr = fs.readFileSync(pidPath, 'utf-8');
        daemonPid = parseInt(pidStr, 10);
        if (!isNaN(daemonPid)) {
          process.kill(daemonPid, 0); // throws ESRCH if not running
          daemonStatus = 'Running';
        } else {
          daemonPid = null;
        }
      } catch (error) {
        if (getErrorCode(error) === 'ESRCH') {
          daemonStatus = 'Stale PID (Stopped)';
        } else {
          daemonStatus = 'Error reading PID';
        }
      }
    }

    try {
      const results = [];
      let totalSize = 0;
      let totalFiles = 0;
      let totalChunks = 0;
      let totalRels = 0;

      for (const dbInst of dbs) {
        const db = dbInst.getInstance();

        const fileCount = (db.prepare('SELECT COUNT(*) as count FROM files').get() as CountRow)
          .count;
        const chunkCount = (db.prepare('SELECT COUNT(*) as count FROM chunks').get() as CountRow)
          .count;
        const relCount = (
          db.prepare('SELECT COUNT(*) as count FROM relationships').get() as CountRow
        ).count;

        let dbSize = 0;
        if (fs.existsSync(db.name)) {
          dbSize = fs.statSync(db.name).size;
        }

        const layerType = db.name.includes(getContextOSHome()) ? 'Global' : 'Local';

        results.push({
          path: db.name,
          layer: layerType,
          sizeBytes: dbSize,
          sizeMb: (dbSize / (1024 * 1024)).toFixed(2),
          files: fileCount,
          chunks: chunkCount,
          relationships: relCount
        });

        totalSize += dbSize;
        totalFiles += fileCount;
        totalChunks += chunkCount;
        totalRels += relCount;
      }

      let indexingStatus: IndexingStatus | null = null;
      const statusPath = path.join(cwd, '.contextos', 'status.json');
      if (fs.existsSync(statusPath)) {
        try {
          indexingStatus = JSON.parse(fs.readFileSync(statusPath, 'utf-8'));
        } catch {}
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              daemon: {
                status: daemonStatus,
                pid: daemonPid,
                indexing: indexingStatus
              },
              databases: results,
              totals: {
                sizeBytes: totalSize,
                sizeMb: parseFloat((totalSize / (1024 * 1024)).toFixed(2)),
                files: totalFiles,
                chunks: totalChunks,
                relationships: totalRels
              }
            },
            null,
            2
          )
        );
        return;
      }

      console.log(chalk.bold(`\nContextOS Status`));
      console.log(`==================\n`);

      console.log(chalk.magenta.bold(`[Daemon]`));
      console.log(
        `Status:        ${daemonStatus === 'Running' ? chalk.green('Running') : chalk.yellow(daemonStatus)}`
      );
      if (daemonPid) console.log(`PID:           ${daemonPid}`);
      if (indexingStatus && !indexingStatus.fullIndexCompleted) {
        console.log(
          `Indexing:      ${chalk.yellow('In Progress')} (${indexingStatus.processed || 0} / ${indexingStatus.total || '?'} files - ${indexingStatus.progressPercentage || 0}%)`
        );
      } else if (indexingStatus && indexingStatus.fullIndexCompleted) {
        console.log(`Indexing:      ${chalk.green('Completed')}`);
      }
      console.log('');

      for (const res of results) {
        console.log(chalk.blue.bold(`[${res.layer} Database]`));
        console.log(`Path:          ${res.path}`);
        console.log(`Size:          ${res.sizeMb} MB`);
        console.log(`Files Indexed: ${res.files}`);
        console.log(`Chunks:        ${res.chunks}`);
        console.log(`Relationships: ${res.relationships}`);
        console.log('');
      }

      console.log(chalk.green.bold(`[Total Aggregated]`));
      console.log(`Size:          ${(totalSize / (1024 * 1024)).toFixed(2)} MB`);
      console.log(`Files Indexed: ${totalFiles}`);
      console.log(`Chunks:        ${totalChunks}`);
      console.log(`Relationships: ${totalRels}\n`);
    } finally {
      for (const dbInst of dbs) {
        dbInst.close();
      }
    }
  });
