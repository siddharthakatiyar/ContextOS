import fs from 'fs';
import path from 'path';
import { DB } from '../storage/database.js';
import { ChunksRepo } from '../storage/chunks-repo.js';
import { FilesRepo } from '../storage/files-repo.js';
import { RelationshipsRepo } from '../storage/relationships-repo.js';
import { parseMarkdown, parseText, parseCode, detectLanguage, parseConfig } from '../parser/index.js';
import { chunkDocument } from '../chunker/index.js';
import { chunkCode } from '../chunker/code-chunker.js';
import { extractRelationships } from '../graph/extractor.js';
import { scoreFileImportance } from './importance-scorer.js';
import { hashContent } from '../../utils/hash.js';
import { Layer, Chunk } from '../storage/types.js';

export interface IndexStats {
  filesProcessed: number;
  chunksCreated: number;
  relationshipsFound: number;
  durationMs: number;
}

export class Indexer {
  private chunksRepo: ChunksRepo;
  private filesRepo: FilesRepo;
  private relsRepo: RelationshipsRepo;

  constructor(db: DB) {
    this.chunksRepo = new ChunksRepo(db.getInstance());
    this.filesRepo = new FilesRepo(db.getInstance());
    this.relsRepo = new RelationshipsRepo(db.getInstance());
  }

  public async indexFile(filePath: string, layer: Layer, workspaceName?: string): Promise<IndexStats> {
    const startTime = Date.now();
    let chunksCreated = 0;
    let relationshipsFound = 0;

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const hash = hashContent(content);

    // Skip binary files (SQLite databases, images, etc.) by checking for null bytes
    if (content.indexOf('\0') !== -1) {
      return {
        filesProcessed: 0,
        chunksCreated: 0,
        relationshipsFound: 0,
        durationMs: Date.now() - startTime
      };
    }

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

    // Parse and chunk based on file type
    if (isCode) {
      const parsed = await parseCode(filePath, content);
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

    // Cleanup old chunks and relationships for this file
    this.chunksRepo.deleteBySource(filePath);

    // Upsert new chunks
    this.chunksRepo.bulkUpsert(chunks);
    chunksCreated = chunks.length;

    // Extract and upsert relationships
    const allRels = [];
    for (const chunk of chunks) {
      const rels = extractRelationships(chunk);
      allRels.push(...rels);
    }
    
    if (allRels.length > 0) {
      this.relsRepo.bulkUpsert(allRels);
      relationshipsFound = allRels.length;
    }

    return {
      filesProcessed: 1,
      chunksCreated,
      relationshipsFound,
      durationMs: Date.now() - startTime
    };
  }

  public async removeFile(filePath: string): Promise<void> {
    // Delete file record, which cascades to chunks and relationships due to SQLite foreign keys
    this.filesRepo.deleteByPath(filePath);
  }
}
