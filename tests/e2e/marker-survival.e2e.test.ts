import { describe, it, beforeAll, expect, afterAll } from 'vitest';
import { globalSentRegistry } from '../../src/core/session/sent-registry.js';
import { buildFixtureDb } from '../helpers/build-fixture-db.js';
// @ts-ignore
import { TOPIC_DEFS } from '../../scripts/bench/topics/contextos.mjs';
import { DB } from '../../src/core/storage/database.js';
import { executeGetContext } from '../../src/mcp/tools/get-context-core.js';
import { RetrievalEngine } from '../../src/core/retrieval/index.js';
import { SessionManager } from '../../src/core/session/index.js';
import { KnowledgeStore } from '../../src/core/memory/knowledge-store.js';
import { PromptsRepo } from '../../src/core/storage/prompts-repo.js';
import { SessionStore } from '../../src/core/session/session-store.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../src/core/storage/relationships-repo.js';
import fs from 'fs';
import path from 'path';

const BASELINE_PATH = path.join(process.cwd(), 'tests', 'baselines', 'marker-survival.baseline.json');

describe('Marker Survival E2E Gate', () => {
  let db: DB;
  let deps: any;

  beforeAll(async () => {
    const dbPath = await buildFixtureDb();
    db = new DB(dbPath);

    const chunksRepos = [new ChunksRepo(db.getInstance())];
    const relsRepos = [new RelationshipsRepo(db.getInstance())];
    const promptsRepo = new PromptsRepo(db.getInstance());
    const sessionStore = new SessionStore(db);
    const sessionManager = new SessionManager(promptsRepo, sessionStore);
    const engine = new RetrievalEngine(chunksRepos, relsRepos);
    const knowledgeStore = new KnowledgeStore(db);

    deps = { engine, sessionManager, knowledgeStore, promptsRepo, sessionStore };
  }, 60000); // 60s timeout for buildFixtureDb

  afterAll(() => {
    if (db) db.close();
  });

  async function evaluateTopics(type: 'specific' | 'generic') {
    const results = [];
    let passed = 0;
    let totalTokens = 0;

    for (const topic of TOPIC_DEFS) {
      const prompt = topic[type];
      globalSentRegistry.invalidate();
      const { text, compiled, result } = await executeGetContext(prompt, { maxTokens: 8000, repoRoot: process.cwd() }, deps);
      
      let isPass = true;
      let diagnosis = 'pass';
      
      for (const marker of topic.requiredMarkers) {
        if (!text.includes(marker)) {
          isPass = false;
          // Diagnose
          const chunkWithMarker = result.chunks.find(c => c.content.includes(marker));
          
          if (topic.generic === "Where is the server lock acquired?") {
            console.log(`[DEBUG] server-lock retrieved chunks: ${result.chunks.length}`);
            console.log(`[DEBUG] markerInChunks: ${!!chunkWithMarker}`);
            console.log(`[DEBUG] chunks: ${result.chunks.slice(0, 5).map(c => c.symbolName).join(', ')}`);
          }

          if (chunkWithMarker) {
            const chunkIdent = chunkWithMarker.symbolName || path.basename(chunkWithMarker.sourceFile);
            if (text.includes(chunkIdent)) {
              diagnosis = 'retrieved-but-truncated';
            } else {
              diagnosis = 'retrieved-but-cut';
            }
          } else {
            diagnosis = 'not-retrieved';
          }
          
          console.log(`MISSING MARKER: ${marker}, Diagnosis: ${diagnosis}, Topic: ${topic.id}`);
          if (topic.id === 'retrieval-pipeline' && type === 'generic') {
            console.log('TOP CHUNKS FOR RETRIEVAL-PIPELINE:');
            result.chunks.slice(0, 10).forEach((c, i) => {
              console.log(`[${i}] ${c.symbolName} (score: ${c.score}): ${c.content.slice(0, 60).replace(/\n/g, ' ')}`);
            });
          }
          break;
        }
      }

      // Check required files verbatim markers
      for (const reqFile of topic.requiredFiles) {
        const fullPath = path.join(process.cwd(), reqFile);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          for (const marker of topic.requiredMarkers) {
             if (!content.includes(marker)) {
               throw new Error(`[Integrity Error] Marker "${marker}" NOT verbatim in file ${reqFile} for topic ${topic.id}`);
             }
          }
        }
      }

      if (isPass) {
        passed++;
      } else {
        console.log(`[${type}] Failed topic: ${topic.id} - ${diagnosis}`);
      }

      totalTokens += compiled.tokenCount;
      
      // budget limit check
      expect(compiled.tokenCount).toBeLessThanOrEqual(8000 * 1.02);

      results.push({
        id: topic.id,
        isPass,
        diagnosis,
        tokens: compiled.tokenCount
      });
    }

    return {
      passCount: passed,
      passSet: results.filter(r => r.isPass).map(r => r.id),
      avgTokens: totalTokens / TOPIC_DEFS.length,
      results
    };
  }

  it('runs marker survival checks', async () => {
    console.log('Evaluating specific prompts...');
    const specificRun = await evaluateTopics('specific');
    console.log(`Specific passed: ${specificRun.passCount}/${TOPIC_DEFS.length}`);

    console.log('Evaluating generic prompts...');
    const genericRun = await evaluateTopics('generic');
    console.log(`Generic passed: ${genericRun.passCount}/${TOPIC_DEFS.length}`);

    const currentStats = {
      specific: { passCount: specificRun.passCount, passSet: specificRun.passSet, avgTokens: specificRun.avgTokens },
      generic: { passCount: genericRun.passCount, passSet: genericRun.passSet, avgTokens: genericRun.avgTokens }
    };

    if (process.env.UPDATE_BASELINE === '1' || !fs.existsSync(BASELINE_PATH)) {
      if (!fs.existsSync(path.dirname(BASELINE_PATH))) {
        fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      }
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(currentStats, null, 2));
      console.log('Baseline updated.');
    } else {
      const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

      // 1. Pass-set diff (net drop fails)
      const specificDropped = baseline.specific.passSet.filter((id: string) => !currentStats.specific.passSet.includes(id));
      const genericDropped = baseline.generic.passSet.filter((id: string) => !currentStats.generic.passSet.includes(id));

      if (specificDropped.length > 0) {
        console.error('Specific suite dropped topics:', specificDropped);
      }
      if (genericDropped.length > 0) {
        console.error('Generic suite dropped topics:', genericDropped);
      }

      expect(specificDropped.length, `Specific suite regressed on topics: ${specificDropped.join(', ')}`).toBe(0);
      expect(genericDropped.length, `Generic suite regressed on topics: ${genericDropped.join(', ')}`).toBe(0);

      // 2. Specific one-shot must match or exceed baseline
      expect(currentStats.specific.passCount).toBeGreaterThanOrEqual(baseline.specific.passCount);

      // 3. Generic must match or exceed baseline
      expect(currentStats.generic.passCount).toBeGreaterThanOrEqual(baseline.generic.passCount);

      // 4. Avg first-call ceiling (should not increase drastically)
      expect(currentStats.specific.avgTokens).toBeLessThanOrEqual(baseline.specific.avgTokens * 1.05);
      expect(currentStats.generic.avgTokens).toBeLessThanOrEqual(baseline.generic.avgTokens * 1.05);
    }
  }, 120000); // 120s timeout for all queries
});
