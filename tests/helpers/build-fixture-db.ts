import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import crypto from 'crypto';
import { DB } from '../../src/core/storage/database.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { loadConfig } from '../../src/config/index.js';

export async function buildFixtureDb(): Promise<string> {
  const cwd = process.cwd();
  const cacheDir = path.join(cwd, 'node_modules', '.cache', 'contextos-fixture');
  const dbPath = path.join(cacheDir, 'index.db');
  const hashPath = path.join(cacheDir, 'db-hash.txt');
  
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  const config = loadConfig();
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
  ];
  const ignore = [...new Set([...SAFETY_IGNORE, ...(config.ignorePatterns || [])])];
  
  const allRepoFiles = new Set<string>();
  for (const pattern of config.indexablePatterns) {
    const files = await glob(pattern, { cwd, ignore, absolute: true, nodir: true });
    for (const f of files) allRepoFiles.add(f);
  }

  // Fast hash of file sizes + mtimes
  let hashStr = '';
  for (const file of Array.from(allRepoFiles).sort()) {
    try {
      const stat = fs.statSync(file);
      hashStr += `${file}:${stat.size}:${stat.mtimeMs}\n`;
    } catch (e) {}
  }
  
  const currentHash = crypto.createHash('sha256').update(hashStr).digest('hex');
  
  if (fs.existsSync(dbPath) && fs.existsSync(hashPath)) {
    const cachedHash = fs.readFileSync(hashPath, 'utf8');
    if (cachedHash === currentHash) {
      return dbPath; // Already built
    }
  }

  // Rebuild needed
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  
  process.env.CONTEXTOS_EMBEDDINGS = '1'; // enable embeddings for semantic backfills in generic queries
  
  const db = new DB(dbPath);
  const indexer = new Indexer(db);

  for (const file of allRepoFiles) {
    try {
      const fileStat = fs.statSync(file);
      if (fileStat.size <= 100 * 1024) {
        await indexer.indexFile(file, 'repo');
      }
    } catch (e) {}
  }
  db.close();

  fs.writeFileSync(hashPath, currentHash);
  return dbPath;
}
