import fs from 'fs';
import path from 'path';
import { DB } from '../storage/database.js';
import { ChunksRepo } from '../storage/chunks-repo.js';
import { FilesRepo } from '../storage/files-repo.js';
import { RelationshipsRepo } from '../storage/relationships-repo.js';
import {
  parseMarkdown,
  parseText,
  parseCode,
  detectLanguage,
  parseConfig
} from '../parser/index.js';
import { chunkDocument } from '../chunker/index.js';
import { chunkCode } from '../chunker/code-chunker.js';
import { extractRelationships, extractImportRelationships } from '../graph/extractor.js';
import { scoreFileImportance } from './importance-scorer.js';
import { hashContent } from '../../utils/hash.js';
import { isBinaryFile, isGeneratedFile } from '../../utils/file-heuristics.js';
import { Layer, Chunk, Relationship } from '../storage/types.js';
import { indexChunkEmbeddings } from '../embeddings/index.js';
import { EmbeddingsStore } from '../embeddings/embeddings-store.js';
import { createIndexIgnore, IndexIgnore } from './ignore.js';

/** Skip files larger than this before reading (B25). Shared by bulk + watcher paths. */
export const MAX_INDEXABLE_FILE_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_FILE_BYTES = MAX_INDEXABLE_FILE_BYTES;

export interface IndexStats {
  filesProcessed: number;
  chunksCreated: number;
  relationshipsFound: number;
  durationMs: number;
}

function isInsideWorkspace(resolvedPath: string, root: string): boolean {
  const rootResolved = path.resolve(root);
  return resolvedPath === rootResolved || resolvedPath.startsWith(rootResolved + path.sep);
}

export class Indexer {
  private chunksRepo: ChunksRepo;
  private filesRepo: FilesRepo;
  private relsRepo: RelationshipsRepo;
  private rootDir: string;
  private indexIgnore: IndexIgnore;

  constructor(db: DB, rootDir?: string, configuredIgnorePatterns: readonly string[] = []) {
    this.chunksRepo = new ChunksRepo(db.getInstance());
    this.filesRepo = new FilesRepo(db.getInstance());
    this.relsRepo = new RelationshipsRepo(db.getInstance());
    // Security root for path-traversal checks. Defaults to process.cwd() but
    // long-lived callers (daemon/watcher) pass their project dir explicitly so
    // indexing never breaks when the process was started from another directory
    // (e.g. via CONTEXTOS_REPO_ROOT).
    const lexicalRoot = rootDir ? path.resolve(rootDir) : process.cwd();
    this.rootDir = fs.existsSync(lexicalRoot) ? fs.realpathSync(lexicalRoot) : lexicalRoot;
    this.indexIgnore = createIndexIgnore(this.rootDir, configuredIgnorePatterns);
  }

  /** Filesystem boundary used for every index operation. */
  public getRootDir(): string {
    return this.rootDir;
  }

  public async indexFile(
    filePath: string,
    layer: Layer,
    workspaceName?: string,
    signal?: AbortSignal
  ): Promise<IndexStats> {
    const startTime = Date.now();
    let chunksCreated = 0;
    let relationshipsFound = 0;

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Path traversal guard.  `workspaceName` is an identity stored on chunks;
    // it is deliberately not a filesystem path.  The constructor owns the
    // canonical repository boundary so labels such as "team-a" cannot change
    // the security root or make valid workspace indexing fail.
    const root = this.rootDir;
    const resolvedPath = path.resolve(filePath);
    let canonicalPath = resolvedPath;
    try {
      canonicalPath = fs.realpathSync(resolvedPath);
    } catch {
      // The existence check above makes this unlikely; retain the lexical path
      // so the resulting error still names the requested file.
    }
    if (!isInsideWorkspace(canonicalPath, root)) {
      throw new Error(`Path traversal blocked: ${filePath} is outside workspace root (${root})`);
    }

    // Apply the same built-in and repository/configured ignore policy used by
    // bulk and watch traversal. Explicit reindex requests must not bypass it.
    if (this.indexIgnore.ignores(canonicalPath)) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    signal?.throwIfAborted();

    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    // Cap file size before read (B25)
    if (stat.size > MAX_FILE_BYTES) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    // Skip binary files using optimized buffer check
    if (isBinaryFile(filePath)) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    signal?.throwIfAborted();
    const content = fs.readFileSync(filePath, 'utf8');

    // Skip generated / minified code
    if (isGeneratedFile(filePath, content)) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    const hash = hashContent(content);

    // Check if changed
    if (!this.filesRepo.isChanged(filePath, hash)) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    const ext = path.extname(filePath).toLowerCase();
    const isMarkdown = ext === '.md';
    const isCode = detectLanguage(filePath) !== 'unknown';

    const isConfig = ['json', 'yaml', 'yml', 'toml', 'ini'].includes(ext.slice(1));

    let chunks: Chunk[] = [];
    let imports: string[] = [];

    // Parse and chunk based on file type
    signal?.throwIfAborted();
    if (isCode) {
      const parsed = await parseCode(filePath, content);
      imports = parsed.imports || [];
      chunks = chunkCode(parsed, { layer, workspaceName });
    } else if (isConfig) {
      const parsed = parseConfig(filePath, content);
      chunks = chunkCode(parsed, { layer, workspaceName }); // Config files are structurally similar to code
    } else if (isMarkdown) {
      const parsed = parseMarkdown(filePath, content);
      chunks = chunkDocument(parsed, { layer, workspaceName });
    } else {
      const parsed = parseText(filePath, content);
      chunks = chunkDocument(parsed, { layer, workspaceName });
    }

    // Apply importance score (preserve existing if any, to keep feedback boosts)
    const existingFile = this.filesRepo.getByPath(filePath);
    const importance = existingFile ? existingFile.importance : scoreFileImportance(filePath);

    // Pass importance down to chunks
    for (const chunk of chunks) {
      chunk.importance = importance;
    }

    // Build graph edges before changing the hash-gated persistent state so the
    // file row, chunks, and relationships can commit or roll back together.
    const allRels: Relationship[] = [];
    for (const chunk of chunks) {
      allRels.push(...extractRelationships(chunk));
    }

    // File-level import edges attached to the File Structure (or first) chunk
    if (imports.length > 0 && chunks.length > 0) {
      const anchor = chunks.find((c) => c.sectionTitle === 'File Structure') || chunks[0];
      const fileStem = path.basename(filePath).replace(/\.[^.]+$/, '');
      allRels.push(...extractImportRelationships(anchor, imports, fileStem));
    }

    // Persist the whole file replacement atomically: file record upsert, stale
    // vector GC, old-chunk deletion and new-chunk insertion must succeed or fail
    // together. Previously a crash between delete and insert left the file row
    // claiming chunk_count > 0 while zero actual chunks existed.
    // (bulkUpsert's internal transaction nests as a savepoint.)
    signal?.throwIfAborted();
    const persistFile = this.chunksRepo.getDatabase().transaction(() => {
      // Update file record first to satisfy foreign key constraints
      this.filesRepo.upsert({
        path: filePath,
        layer,
        workspaceName: workspaceName || null,
        hash,
        lastIndexed: Date.now(),
        importance,
        chunkCount: chunks.length
      });

      // FK cascades remove chunk_embeddings rows, but the sqlite-vec table has no
      // FK support — collect stale chunk IDs first so vectors can be garbage-collected.
      const staleChunkIds = this.chunksRepo.getIdsBySource(filePath);
      if (staleChunkIds.length > 0) {
        new EmbeddingsStore(this.chunksRepo.getDatabase()).deleteByChunkIds(staleChunkIds);
      }

      // Cleanup old chunks and relationships for this file (FK cascade deletes relationships)
      this.chunksRepo.deleteBySource(filePath);

      // Upsert new chunks
      this.chunksRepo.bulkUpsert(chunks);

      // Relationship rows are hash-gated just like chunks. Keeping them in this
      // transaction ensures a failed graph write leaves the previous file hash,
      // chunks, and graph intact so a retry can converge.
      if (allRels.length > 0) {
        this.relsRepo.bulkUpsert(allRels);
      }
    });
    persistFile();
    chunksCreated = chunks.length;
    relationshipsFound = allRels.length;

    // Embeddings are retrieval-side only — never block indexing on model failures
    try {
      signal?.throwIfAborted();
      await indexChunkEmbeddings(this.chunksRepo.getDatabase(), chunks, signal);
    } catch {
      // continue without embeddings
    }

    return {
      filesProcessed: 1,
      chunksCreated,
      relationshipsFound,
      durationMs: Date.now() - startTime
    };
  }

  public async removeFile(filePath: string, expectedLayer?: Layer): Promise<boolean> {
    const db = this.chunksRepo.getDatabase();
    // Take the write lock before checking the row. A full scan can race with a
    // watcher or MCP index request that reassigns the same path to another
    // layer; the layer predicate must cover both the check and all cascades.
    const remove = db.transaction(() => {
      const record = this.filesRepo.getByPath(filePath);
      if (!record || (expectedLayer && record.layer !== expectedLayer)) return false;

      // Clean embedding vectors before the cascade — vec0 has no FK support.
      const staleChunkIds = this.chunksRepo.getIdsBySource(filePath);
      if (staleChunkIds.length > 0) {
        new EmbeddingsStore(db).deleteByChunkIds(staleChunkIds);
      }
      // Delete the file record, which cascades to chunks and relationships.
      this.filesRepo.deleteByPath(filePath);
      return true;
    }).immediate;
    return remove();
  }

  /** Remove files from a layer that were absent from a completed full scan. */
  public async removeFilesNotIn(paths: Iterable<string>, layer: Layer = 'repo'): Promise<number> {
    const current = new Set(Array.from(paths, (filePath) => path.resolve(filePath)));
    const stale = this.filesRepo
      .listByLayer(layer)
      .filter((record) => !current.has(path.resolve(record.path)));
    let removed = 0;
    for (const record of stale) {
      if (await this.removeFile(record.path, layer)) removed++;
    }
    return removed;
  }
}
