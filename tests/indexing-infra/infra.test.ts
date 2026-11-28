import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { createFixtureGroup } from '../helpers/create-fixture-group.js';
import { Indexer } from '../../src/core/indexer/index.js';
import { parseInfra } from '../../src/core/parser/infra-parser.js';
import { chunkInfra } from '../../src/core/chunker/infra-chunker.js';
import { ChunksRepo } from '../../src/core/storage/chunks-repo.js';
import { chunkCode } from '../../src/core/chunker/code-chunker.js';
import { chunkDocument } from '../../src/core/chunker/index.js';
import { parseCode, parseMarkdown } from '../../src/core/parser/index.js';
import * as embedder from '../../src/core/embeddings/embedder.js';
import { configFingerprint } from '../../src/core/workspace/runtime.js';
import { embedChunkText, indexChunkEmbeddings } from '../../src/core/embeddings/index.js';
import { loadConfig } from '../../src/config/index.js';

const fixtures: Record<string, string> = {
  'docker-compose.prod.yaml': `services:
  api:
    image: node:22
    build: {context: ., args: {BUILD_VALUE: HIDDENbuild}}
    ports: ['8080:80']
    depends_on: {db: {condition: service_started}}
    environment:
      ORDINARY: HIDDENenv
      PASSWORD: HIDDENpass
    volumes: ['./data:/data']
    networks: [backend]
    command: ['node', 'HIDDENargument']
    entrypoint: ['/entrypoint.sh', 'HIDDENentry']
  db:
    image: postgres:16
    environment: ['PLAIN=HIDDENlist', 'URL=postgres://user:HIDDENurl@db']
`,
  Dockerfile: `FROM node:22 AS builder # HIDDENfromcomment
ARG PLAIN=HIDDENarg
ENV NORMAL=HIDDENnormal PASSWORD=HIDDENdockerpass
ENV LEGACY HIDDENlegacy
ENV QUOTED="contains HIDDENquoted=anything"
RUN curl --token HIDDENrun
FROM alpine:3 AS runtime
EXPOSE 8080 # HIDDENexposecomment
ENTRYPOINT ["sh", "HIDDENdockerentry"]
CMD ["HIDDENcmd"]
`,
  'deploy.sh': `#!/bin/sh
export NORMAL=HIDDENshell
password='HIDDENshellpass'
MULTILINE='HIDDENfirst
HIDDENsecond
'
SUBSTITUTION=$(
HIDDENsubstitution
)
BACKTICK=\`
HIDDENbacktick
\`
start() {
  curl --password HIDDENcurl
  cat <<EOFSECRET
HIDDENheredoc
EOFSECRET
}
`,
  'k8s.yaml': `apiVersion: apps/v1
kind: Deployment
metadata: {name: api, namespace: production, annotations: {anything: HIDDENannotation}}
spec:
  template:
    spec:
      containers:
        - name: api
          image: node:22
          ports: [{containerPort: 8080}]
          env:
            - {name: ORDINARY, value: HIDDENk8s}
            - name: FROM_SECRET
              valueFrom: {secretKeyRef: {name: db-password, key: HIDDENsecretkey}}
          envFrom: [{configMapRef: {name: api-config}}]
      volumes: [{name: db, secret: {secretName: db-credentials}}]
---
apiVersion: v1
kind: Secret
metadata: {name: db-credentials}
data: {username: HIDDENbase64}
stringData: {password: HIDDENstring}
`,
  'values.yaml': `image: {repository: HIDDENhelmimage}
env: {NORMAL: HIDDENhelm}
password: |
  HIDDENmultiline
`,
  'main.tf': `resource "aws_instance" "api" {
  image = "HIDDENtf"
  password = "HIDDENtfpass"
  nested { value = "}" }
}
module "worker" {
  source = "HIDDENmodule"
  plain = <<EOT
HIDDENtfheredoc
EOT
}
`,
  '.env.example': `NORMAL=HIDDENexample
PASSWORD="HIDDENexamplepass"
export EXPORTED=HIDDENexport
CONTINUED=\\
HIDDENcontinued=value
`
};
const secrets = Object.values(fixtures)
  .join('\n')
  .match(/HIDDEN\w+/g)!;
const opts = { layer: 'repo' as const };

describe('infrastructure structural indexing', () => {
  it('chunks services, stages, resources, functions and blocks without source secrets', () => {
    const parsed = Object.fromEntries(
      Object.entries(fixtures).map(([file, text]) => [file, parseInfra(file, text)!])
    );
    expect(parsed['docker-compose.prod.yaml'].sections.map((s) => s.name)).toEqual(['api', 'db']);
    expect(parsed.Dockerfile.sections).toHaveLength(2);
    expect(parsed['k8s.yaml'].sections.map((s) => s.name)).toEqual([
      'Deployment/api',
      'Secret/db-credentials'
    ]);
    expect(parsed['main.tf'].sections.map((s) => s.name)).toEqual([
      'resource.aws_instance.api',
      'module.worker'
    ]);
    expect(parsed['deploy.sh'].sections.some((s) => s.name === 'start')).toBe(true);
    const chunks = Object.entries(parsed).flatMap(([file, doc]) => chunkInfra(file, doc, opts));
    const serialized = JSON.stringify(chunks);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('8080');
    expect(serialized).toContain('api-config');
    expect(serialized).toContain('db-credentials');
    expect(serialized).toContain('ORDINARY');
    expect(chunks.every((c) => c.language && c.fileType === 'config')).toBe(true);
  });

  it.each([
    [
      'compose.yaml',
      'services: {api: {image: "${REGISTRY:-hostiledefault}", ports: ["password: hostileport"], environment: ["NORMAL=hostileenv"], command: ["sh", "hostilearg"]}}',
      ['hostiledefault', 'hostileport', 'hostileenv', 'hostilearg']
    ],
    [
      'Dockerfile',
      'FROM alpine:3\nENV NORMAL "hostilelegacy"\nENV QUOTED="hostilequoted=thing"\nARG NORMAL=hostilearg\nRUN echo "hostilerun"',
      ['hostilelegacy', 'hostilequoted', 'hostilearg', 'hostilerun']
    ],
    [
      'entrypoint.sh',
      "NORMAL='hostilefirst\nhostilesecond\n'\ncat <<'END'\nhostileheredoc\nEND\n# --- hostilecomment\ncurl --api-key hostileflag",
      ['hostilefirst', 'hostilesecond', 'hostileheredoc', 'hostilecomment', 'hostileflag']
    ],
    [
      'manifest.yaml',
      '{"apiVersion":"v1", "kind":"Secret", "metadata":{"name":"db"}, "stringData":{"password":"hostilevalue"}}',
      ['hostilevalue']
    ],
    [
      'main.tf',
      '# "hostilecommentlabel"\nresource "test" "api" {\nvalue = <<EOT\nresource "fake" "hostilelabel" { }\nEOT\n}\nmodule "real" { source = "hostilesource" }',
      ['hostilelabel', 'hostilesource', 'hostilecommentlabel']
    ]
  ])('redacts hostile alternate syntax in %s', (file, text, hidden) => {
    const parsed = parseInfra(file, text)!;
    expect(parsed).toBeDefined();
    expect(parsed.sections.length).toBeGreaterThan(0);
    const output = JSON.stringify(chunkInfra(file, parsed, opts));
    for (const value of hidden) expect(output).not.toContain(value);
  });

  it('does not mistake multiline env values or multiple heredoc bodies for syntax', () => {
    for (const [file, text] of [
      ['.env.example', 'NORMAL="first\nhostilesecret=value\n"\nAFTER=value'],
      ['.env.example', 'NORMAL=' + String.fromCharCode(92) + '\nhostilesecret=value\nAFTER=value'],
      ['deploy.sh', 'cat <<A <<B\nfirstbody\nA\nhostilesecret\nB\necho done'],
      ['deploy.sh', 'export NORMAL=' + String.fromCharCode(92) + '\nhostilesecret\necho done'],
      ['deploy.sh', 'NORMAL=$(\nhostilesecret\n)\necho done'],
      ['deploy.sh', 'NORMAL=`\nhostilesecret\n`\necho done'],
      ['Dockerfile', 'FROM alpine\nENV NORMAL=' + String.fromCharCode(92) + '\nRUN hostilesecret']
    ]) {
      const doc = parseInfra(file, text)!;
      expect(doc.sections.length).toBeGreaterThan(0);
      expect(JSON.stringify(doc)).not.toContain('hostilesecret');
    }
  });

  it('fails closed on malformed YAML, alias cycles and alias expansion limits', () => {
    for (const text of [
      'services: [',
      'services: &x {api: *x}',
      'services: ' + '['.repeat(70) + '1' + ']'.repeat(70)
    ]) {
      expect(parseInfra('compose.yaml', text)?.sections).toEqual([]);
    }
  });

  it('persists only sanitized chunks and FTS, and supplies only sanitized embedding input', async () => {
    const group = await createFixtureGroup();
    try {
      const source = group.sources[0],
        runtime = group.runtime.get(source);
      const indexer = new Indexer(runtime.db, source.rootPath);
      for (const [name, text] of Object.entries(fixtures)) {
        const file = path.join(source.rootPath, name);
        fs.writeFileSync(file, text);
        expect((await indexer.indexFile(file, 'repo')).chunksCreated).toBeGreaterThan(0);
      }
      const db = runtime.db.getInstance();
      const rows = db.prepare('SELECT * FROM chunks').all();
      const fts = db.prepare('SELECT * FROM chunks_fts').all();
      const repo = new ChunksRepo(db);
      const chunks = Object.keys(fixtures).flatMap((name) =>
        repo.getByIds(repo.getIdsBySource(path.join(source.rootPath, name)))
      );
      const embeddingTexts = chunks.map(embedChunkText);
      const available = vi.spyOn(embedder, 'isEmbeddingsAvailable').mockReturnValue(true);
      const embed = vi.spyOn(embedder, 'embedTexts').mockImplementation(async (texts) => {
        embeddingTexts.push(...texts);
        return texts.map(() => new Float32Array(384).fill(0.01));
      });
      try {
        await indexChunkEmbeddings(db, chunks, undefined, { embeddingsEnabled: true });
        expect(embed).toHaveBeenCalled();
        expect(db.prepare('SELECT count(*) as n FROM chunk_embeddings').get()).toEqual({
          n: chunks.length
        });
      } finally {
        embed.mockRestore();
        available.mockRestore();
      }
      for (const secret of secrets) {
        expect(JSON.stringify(rows)).not.toContain(secret);
        expect(JSON.stringify(fts)).not.toContain(secret);
        expect(embeddingTexts.join('\n')).not.toContain(secret);
      }
      expect(
        db.prepare("SELECT * FROM chunks_fts WHERE chunks_fts MATCH 'ORDINARY'").all().length
      ).toBeGreaterThan(0);
      // Existing partial/raw infra rows are replaced despite an unchanged source hash.
      db.prepare('UPDATE files SET hash=? WHERE path=?').run(
        'legacy-hash',
        path.join(source.rootPath, 'Dockerfile')
      );
      expect(
        (await indexer.indexFile(path.join(source.rootPath, 'Dockerfile'), 'repo')).filesProcessed
      ).toBe(1);
      expect(
        (await indexer.indexFile(path.join(source.rootPath, 'Dockerfile'), 'repo')).filesProcessed
      ).toBe(0);
    } finally {
      await group.cleanup();
    }
  }, 60000);

  it('enforces safety exclusions, ignore files, caps, and opt-out without raw fallback', async () => {
    const group = await createFixtureGroup();
    try {
      const source = group.sources[0],
        runtime = group.runtime.get(source);
      fs.writeFileSync(path.join(source.rootPath, '.gitignore'), 'ignored.sh\n');
      fs.writeFileSync(path.join(source.rootPath, '.contextosignore'), 'other.sh\n');
      const indexer = new Indexer(runtime.db, source.rootPath);
      for (const name of [
        '.env',
        '.env.local',
        'private.pem',
        'private.key',
        'state.tfstate',
        'state.tfstate.backup',
        'prod.tfvars',
        'prod.tfvars.json',
        'tokens.json',
        'ignored.sh',
        'other.sh'
      ]) {
        const file = path.join(source.rootPath, name);
        fs.writeFileSync(file, 'password=HIDDENexcluded');
        expect((await indexer.indexFile(file, 'repo')).filesProcessed).toBe(0);
      }
      for (const [name, size] of [
        ['large.sh', 256 * 1024 + 1],
        ['Dockerfile.big', 2 * 1024 * 1024 + 1]
      ] as const) {
        const file = path.join(source.rootPath, name);
        fs.writeFileSync(file, 'x'.repeat(size));
        expect((await indexer.indexFile(file, 'repo')).filesProcessed).toBe(0);
      }
      const docker = path.join(source.rootPath, 'Dockerfile');
      fs.writeFileSync(docker, fixtures.Dockerfile);
      expect((await indexer.indexFile(docker, 'repo')).chunksCreated).toBeGreaterThan(0);
      const config = loadConfig({ cwd: source.rootPath });
      config.indexing = { infra: false };
      expect((await indexer.indexFile(docker, 'repo')).chunksCreated).toBe(0);
      expect(
        runtime.db.getInstance().prepare('SELECT * FROM chunks WHERE source_file=?').all(docker)
      ).toEqual([]);
    } finally {
      await group.cleanup();
    }
  }, 60000);

  it('discovers extensionless Dockerfiles, scripts, Terraform and dot env examples in bulk scans', async () => {
    const group = await createFixtureGroup();
    try {
      const source = group.sources[0],
        runtime = group.runtime.get(source);
      for (const [name, content] of Object.entries(fixtures))
        fs.writeFileSync(path.join(source.rootPath, name), content);
      await runtime.index(true);
      const files = runtime.db.getInstance().prepare('SELECT path FROM files').all() as {
        path: string;
      }[];
      for (const name of Object.keys(fixtures))
        expect(files.some((f) => f.path === path.join(source.rootPath, name))).toBe(true);
    } finally {
      await group.cleanup();
    }
  }, 60000);

  it('changes only affected view fingerprints and preserves unchanged source chunks on upgrade', async () => {
    const group = await createFixtureGroup();
    try {
      const affected = group.sources[0],
        unaffected = group.sources[1];
      expect(configFingerprint(affected.rootPath)).not.toBe(
        configFingerprint(affected.rootPath, false)
      );
      expect(configFingerprint(unaffected.rootPath)).toBe(
        configFingerprint(unaffected.rootPath, false)
      );
      const runtime = group.runtime.get(affected);
      const db = runtime.db.getInstance();
      const before = db.prepare("SELECT * FROM chunks WHERE source_file LIKE '%.ts'").all();
      // Simulate the prior release's ready view without changing source contents.
      group.registry.update(affected.repoId, {
        configFingerprint: configFingerprint(affected.rootPath, false)
      });
      db.prepare(
        "UPDATE files SET hash='prior-parser-hash' WHERE path LIKE '%docker-compose.yml'"
      ).run();
      await runtime.index();
      expect(db.prepare("SELECT * FROM chunks WHERE source_file LIKE '%.ts'").all()).toEqual(
        before
      );
      expect(
        db.prepare("SELECT language FROM chunks WHERE source_file LIKE '%docker-compose.yml'").all()
      ).toEqual(Array.from({ length: 4 }, () => ({ language: 'compose-service' })));
      expect(group.registry.resolve(unaffected.repoId).generation).toBe(unaffected.generation);
    } finally {
      await group.cleanup();
    }
  }, 60000);

  it('keeps existing code and document chunks identical to their existing parsers', async () => {
    const group = await createFixtureGroup();
    try {
      const source = group.sources[0],
        runtime = group.runtime.get(source);
      const config = loadConfig({ cwd: source.rootPath });
      const options = {
        ...opts,
        maxChunkTokens: config.maxChunkTokens,
        maxSymbolChunkTokens: config.maxSymbolChunkTokens
      };
      for (const [name, text] of [
        ['unchanged.ts', 'export function greet() { return "hello"; }'],
        ['unchanged.md', '# Guide\n\nExisting documentation.']
      ]) {
        const file = path.join(source.rootPath, name);
        fs.writeFileSync(file, text);
        expect(parseInfra(file, text)).toBeUndefined();
        const expected = name.endsWith('.ts')
          ? chunkCode(await parseCode(file, text), options)
          : chunkDocument(parseMarkdown(file, text), options);
        await new Indexer(runtime.db, source.rootPath).indexFile(file, 'repo');
        const stored = new ChunksRepo(runtime.db.getInstance()).getByIds(
          new ChunksRepo(runtime.db.getInstance()).getIdsBySource(file)
        );
        expect(stored.map((c) => [c.id, c.content, c.language ?? null, c.hash]).sort()).toEqual(
          expected.map((c) => [c.id, c.content, c.language ?? null, c.hash]).sort()
        );
      }
    } finally {
      await group.cleanup();
    }
  }, 60000);
});
