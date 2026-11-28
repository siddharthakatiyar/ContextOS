import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { ensurePrivateStateDir } from '../../utils/secure-state.js';

/** Synchronous migration constructors must wait for the asynchronous SQLite online backup.
 * Run BEFORE the migration transaction, only for existing databases needing an upgrade.
 * A child owns its connection; no raw live database copying or async constructor race.
 */
export function backupBeforeMigration(dbPath: string): string | undefined {
  if (!dbPath || dbPath === ':memory:' || !fs.existsSync(dbPath)) return undefined;
  let output: string | undefined;
  try {
    const root = ensurePrivateStateDir(path.join(path.dirname(dbPath), 'pre-migration-backups'));
    const prefix = `${path.basename(dbPath)}-`;
    output = path.join(
      root,
      `${prefix}${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}.db`
    );
    const module = createRequire(import.meta.url).resolve('better-sqlite3');
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `const Database=require(process.argv[1]); const db=new Database(process.argv[2],{readonly:true}); db.backup(process.argv[3]).then(()=>db.close()).catch(e=>{console.error(e.message);db.close();process.exitCode=1});`,
        module,
        dbPath,
        output
      ],
      { encoding: 'utf8', timeout: 30000 }
    );
    if (result.error || result.status !== 0)
      throw new Error(result.error?.message ?? result.stderr.trim());
    fs.chmodSync(output, 0o600);
    const backups = fs
      .readdirSync(root)
      .filter((n) => n.startsWith(prefix) && n.endsWith('.db'))
      .sort()
      .reverse();
    for (const name of backups.slice(3)) fs.rmSync(path.join(root, name));
    return output;
  } catch (error) {
    try {
      if (output) fs.rmSync(output, { force: true });
    } catch {
      // A cleanup failure must not turn a best-effort backup into a migration blocker.
    }
    console.warn(`Pre-migration backup failed for ${dbPath}: ${(error as Error).message}`);
    return undefined;
  }
}
