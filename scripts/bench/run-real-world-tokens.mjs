import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { executeGetContext } from '../../dist/src/mcp/tools/get-context-core.js';
import { estimateTokens } from '../../dist/src/utils/tokens.js';
import { DB } from '../../dist/src/core/storage/database.js';
import { RetrievalEngine } from '../../dist/src/core/retrieval/index.js';
import { SessionManager } from '../../dist/src/core/session/index.js';
import { KnowledgeStore } from '../../dist/src/core/memory/knowledge-store.js';
import { PromptsRepo } from '../../dist/src/core/storage/prompts-repo.js';
import { SessionStore } from '../../dist/src/core/session/session-store.js';
import { ChunksRepo } from '../../dist/src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../dist/src/core/storage/relationships-repo.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTokenBench() {
  const queriesFile = path.join(__dirname, 'real-world-queries.json');
  const benchData = JSON.parse(fs.readFileSync(queriesFile, 'utf-8'));
  
  const benchmarksDir = path.join(process.cwd(), 'benchmarks');
  
  let grandTotalTokens = 0;
  let grandTotalQueries = 0;

  for (const repoData of benchData) {
    const repoName = repoData.repo.toLowerCase();
    const repoPath = path.join(benchmarksDir, repoName);
    
    if (!fs.existsSync(repoPath)) {
      console.warn(`Repo path ${repoPath} not found. Skipping ${repoData.repo}.`);
      continue;
    }

    const dbPath = path.join(repoPath, '.contextos', 'index.db');
    if (!fs.existsSync(dbPath)) {
      console.warn(`Database not found at ${dbPath}. Skipping ${repoData.repo}.`);
      continue;
    }

    // Initialize DB and Dependencies
    const db = new DB(dbPath);
    const chunksRepos = [new ChunksRepo(db.getInstance())];
    const relsRepos = [new RelationshipsRepo(db.getInstance())];
    const promptsRepo = new PromptsRepo(db.getInstance());
    const sessionStore = new SessionStore(db);
    const sessionManager = new SessionManager(promptsRepo, sessionStore);
    const engine = new RetrievalEngine(chunksRepos, relsRepos);
    const knowledgeStore = new KnowledgeStore(db);

    const deps = { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore };

    console.log(`\n--- Evaluating ${repoData.repo} ---`);
    let repoTotalTokens = 0;

    for (const query of repoData.queries) {
      try {
        const res = await executeGetContext(query, { limit: 10, maxTokens: 4000, repoRoot: repoPath }, deps);
        const resText = res.text || res;
        const tokens = estimateTokens(resText);
        repoTotalTokens += tokens;
        console.log(`[${tokens} tokens] Query: ${query}`);
      } catch (e) {
        console.error(`Error on query "${query}":`, e.message);
      }
    }

    const avgTokens = repoData.queries.length > 0 ? (repoTotalTokens / repoData.queries.length) : 0;
    console.log(`=> Average tokens for ${repoData.repo}: ${avgTokens.toFixed(1)}`);
    
    grandTotalTokens += repoTotalTokens;
    grandTotalQueries += repoData.queries.length;
    
    db.close();
  }

  const overallAvg = grandTotalQueries > 0 ? (grandTotalTokens / grandTotalQueries) : 0;
  console.log(`\n========================================`);
  console.log(`OVERALL AVERAGE: ${overallAvg.toFixed(1)} tokens per query`);
  console.log(`========================================`);
}

runTokenBench().catch(console.error);
