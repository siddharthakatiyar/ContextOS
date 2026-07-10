import Database from 'better-sqlite3';
import { ChunksRepo } from './src/core/storage/chunks-repo.js';
import { KeywordMatcher } from './src/core/retrieval/keyword-matcher.js';
import { scoreChunks } from './src/core/retrieval/scorer.js';
import fs from 'fs';
import path from 'path';
import { getContextOSHome } from './src/core/storage/database.js';

const dbPath = path.join(getContextOSHome(), 'index.db');
const db = new Database(dbPath);
const repo = new ChunksRepo(db);

const matcher = new KeywordMatcher(repo);
const intent = {
  intentType: 'fix',
  concepts: ['api', 'error', 'conventions'],
  identifiers: [],
  quotedTerms: []
};

console.log("Matching chunks...");
const chunks = matcher.matchChunks(intent as any, { layers: ['global'] });

console.log(`Found ${chunks.length} chunks before filtering.`);

const scored = scoreChunks(chunks, []);
console.log(`Found ${scored.length} chunks AFTER filtering.`);

for (const c of scored.slice(0, 5)) {
  console.log(`- ${c.sourceFile} (score: ${c.score})`);
}

db.close();
