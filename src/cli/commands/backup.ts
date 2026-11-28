import { Command, InvalidArgumentError } from 'commander';
import {
  createBackup,
  listBackups,
  pruneBackups,
  restoreBackup,
  verifyBackup,
  type BackupScope,
  type BackupKind
} from '../../core/backup/index.js';

function output(result: unknown, json: boolean): void {
  console.log(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
}
async function run(action: () => unknown | Promise<unknown>, json: boolean): Promise<void> {
  try {
    output(await action(), json);
  } catch (error) {
    if (json) console.log(JSON.stringify({ error: (error as Error).message }));
    else console.error((error as Error).message);
    process.exitCode = 1;
  }
}
export const backupCommand = new Command('backup')
  .description('Online SQLite backups, verification and recovery')
  .option('--out <dir>', 'New backup directory')
  .option('--scope <scope...>', 'all, group <name>, or project <name>')
  .option('--no-indexes', 'Omit rebuildable view indexes')
  .option('--json', 'Machine-readable output')
  .action(async (options: { out?: string; scope?: string[]; indexes: boolean; json?: boolean }) => {
    await run(async () => {
      const parts = options.scope ?? ['all'];
      let scope: BackupScope;
      if (parts.length === 1 && parts[0] === 'all') scope = { kind: 'all' };
      else if (parts.length === 2 && (parts[0] === 'group' || parts[0] === 'project'))
        scope = { kind: parts[0], name: parts[1] };
      else throw new Error('--scope must be all, group <name>, or project <name>');
      return createBackup({ out: options.out, scope, indexes: options.indexes });
    }, !!options.json);
  });
backupCommand
  .command('list')
  .description('List saved backups')
  .action(async () => run(() => listBackups(), !!backupCommand.opts().json));
backupCommand
  .command('verify <dir>')
  .description('Verify checksums and SQLite integrity')
  .action(async (dir: string) =>
    run(() => {
      const result = verifyBackup(dir);
      if (!result.ok) process.exitCode = 1;
      return result;
    }, !!backupCommand.opts().json)
  );
backupCommand
  .command('restore <dir>')
  .description('Restore after taking a safety backup')
  .option('--dry-run', 'Verify and show destinations without writing')
  .option('--only <kind>', 'knowledge, registry, or indexes', (value: string) => {
    if (!['knowledge', 'registry', 'indexes'].includes(value))
      throw new InvalidArgumentError('Expected knowledge, registry, or indexes');
    return value as BackupKind;
  })
  .option('--force', 'Allow restore while a daemon is running')
  .action(async (dir: string, options: { dryRun?: boolean; only?: BackupKind; force?: boolean }) =>
    run(() => restoreBackup(dir, options), !!backupCommand.opts().json)
  );
backupCommand
  .command('prune')
  .description('Keep the newest N backups')
  .requiredOption('--keep <N>', 'Number to retain', (value: string) => {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new InvalidArgumentError('Expected a non-negative integer');
    return Number(value);
  })
  .action(async (options: { keep: number }) =>
    run(() => ({ removed: pruneBackups(options.keep) }), !!backupCommand.opts().json)
  );
