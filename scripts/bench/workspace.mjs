#!/usr/bin/env node
/** Local-only comparison against an already built baseline checkout. Never publishes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const root = path.resolve(import.meta.dirname, '../..');
const baseline = arg('--baseline-dir');
if (!baseline) throw new Error('Pass --baseline-dir <built v1.1.0 checkout>');
const output = arg('--output', path.join(root, 'validation', 'contextos-1.1.1-workspace.json'));
const load = (base, file) => import(pathToFileURL(path.join(base, 'dist', 'src', file)).href);
const [
  { WorkspaceRegistry },
  { WorkspaceRuntime },
  { retrieveWorkspace },
  { ChunksRepo },
  { RelationshipsRepo },
  { RetrievalEngine: BaselineEngine }
] = await Promise.all([
  load(root, 'core/workspace/registry.js'),
  load(root, 'core/workspace/runtime.js'),
  load(root, 'core/workspace/retrieval.js'),
  load(root, 'core/storage/chunks-repo.js'),
  load(root, 'core/storage/relationships-repo.js'),
  load(baseline, 'core/retrieval/index.js')
]);
const temp = fs.mkdtempSync(
  path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'cwb-')
);
const originalHome = os.homedir;
os.homedir = () => path.join(temp, 'home');
const originalEmbedding = process.env.CONTEXTOS_EMBEDDINGS;
process.env.CONTEXTOS_EMBEDDINGS = '0';
const log = console.log;
console.log = (...values) => process.stderr.write(values.join(' ') + '\n');
const registry = new WorkspaceRegistry();
const runtime = new WorkspaceRuntime(registry);
const p95 = (values) => values.slice().sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
const signature = (result) =>
  result.chunks.map((c) => [c.sourceFile, c.symbolName, c.sectionTitle]);
try {
  for (const name of ['backend', 'frontend', 'shared-types', 'infrastructure']) {
    const directory = path.join(temp, name);
    fs.cpSync(path.join(root, 'tests/fixtures/workspace', name), directory, { recursive: true });
    const source = registry.register(directory);
    await runtime.get(source).index();
  }
  const sources = registry.list();
  const query = 'Where is payment status defined, processed, and displayed?';
  const localScopes = sources.map((source) =>
    registry.select({ repo: [source.repoId] }, source.rootPath)
  );
  const workspaceScope = registry.select({ allRepos: true }, registry.resolve('backend').rootPath);
  const engines = sources.map((source) => {
    const db = runtime.get(source).db.getInstance();
    return new BaselineEngine(new ChunksRepo(db), new RelationshipsRepo(db));
  });
  const baselineTimes = [],
    candidateTimes = [],
    workspaceTimes = [],
    individualSums = [];
  let exactMatches = 0,
    comparisons = 0;
  const prompts = [query, 'PaymentStatus', 'processPaymentStatus', 'displayPaymentStatus'];
  for (let iteration = 0; iteration < 120; iteration++) {
    let sum = 0;
    for (let i = 0; i < sources.length; i++) {
      const prompt = prompts[iteration % prompts.length];
      const callBaseline = () => engines[i].retrieve(prompt, { repoRoot: sources[i].rootPath });
      const callCandidate = () =>
        retrieveWorkspace(runtime, localScopes[i], prompt, { repoRoot: sources[i].rootPath });
      let start = performance.now();
      const a = await callBaseline();
      const aTime = performance.now() - start;
      start = performance.now();
      const b = await callCandidate();
      const bTime = performance.now() - start;
      if (iteration >= 20) {
        baselineTimes.push(aTime);
        candidateTimes.push(bTime);
        sum += bTime;
        comparisons++;
        if (JSON.stringify(signature(a)) === JSON.stringify(signature(b))) exactMatches++;
      }
    }
    const start = performance.now();
    await retrieveWorkspace(runtime, workspaceScope, prompts[iteration % prompts.length]);
    if (iteration >= 20) {
      workspaceTimes.push(performance.now() - start);
      individualSums.push(sum);
    }
  }
  const result = await retrieveWorkspace(runtime, workspaceScope, query);
  const roles = ['backend', 'frontend', 'shared-types'];
  const covered = new Set(result.chunks.slice(0, 10).map((c) => c.repoName));
  const baselineP95 = p95(baselineTimes),
    candidateP95 = p95(candidateTimes),
    workspaceP95 = p95(workspaceTimes),
    individualSumP95 = p95(individualSums);
  const metrics = {
    version: '1.1.1',
    baselineVersion: JSON.parse(fs.readFileSync(path.join(baseline, 'package.json'), 'utf8'))
      .version,
    baselineReference: arg('--baseline-reference', 'built baseline checkout'),
    nodeVersion: process.version,
    corpus: 'four-repository payment fixture',
    embeddingMode: 'disabled for deterministic keyword baseline',
    warmupIterations: 20,
    measuredIterations: 100,
    scopedComparisons: comparisons,
    identicalScopedRankings: exactMatches,
    paymentRoleRecallAt10: roles.filter((role) => covered.has(role)).length / roles.length,
    latencyMs: {
      baselineSingleP95: baselineP95,
      candidateSingleP95: candidateP95,
      workspaceP95,
      individualSumP95,
      singleRatio: candidateP95 / baselineP95,
      workspaceRatio: workspaceP95 / individualSumP95
    },
    gates: {
      identicalScopedRankings: exactMatches === comparisons,
      paymentRoleCoverage: roles.every((role) => covered.has(role)),
      singleLatency: candidateP95 <= baselineP95 * 1.1,
      workspaceLatency: workspaceP95 <= individualSumP95 * 1.2
    }
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(metrics, null, 2) + '\n');
  log(JSON.stringify(metrics, null, 2));
  if (Object.values(metrics.gates).some((value) => !value)) process.exitCode = 1;
} finally {
  await runtime.close();
  registry.close();
  os.homedir = originalHome;
  console.log = log;
  if (originalEmbedding === undefined) delete process.env.CONTEXTOS_EMBEDDINGS;
  else process.env.CONTEXTOS_EMBEDDINGS = originalEmbedding;
  fs.rmSync(temp, { recursive: true, force: true });
}
