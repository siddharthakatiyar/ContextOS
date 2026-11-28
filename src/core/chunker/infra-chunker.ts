import crypto from 'node:crypto';
import path from 'node:path';
import type { InfraDocument } from '../parser/infra-parser.js';
import type { Chunk } from '../storage/types.js';
import type { ChunkCreationOptions } from './types.js';
import { hashContent } from '../../utils/hash.js';
import { estimateTokens } from '../../utils/tokens.js';

/** Only accepts sanitized structural documents; no raw source fallback or file-summary chunk. */
export function chunkInfra(
  file: string,
  doc: InfraDocument,
  options: ChunkCreationOptions
): Chunk[] {
  return doc.sections.map((section, i) => ({
    id: crypto.createHash('md5').update(`${file}:${doc.kind}:${section.name}:${i}`).digest('hex'),
    sourceFile: file,
    layer: options.layer,
    workspaceName: options.workspaceName || null,
    sectionTitle: section.name,
    sectionDepth: 1,
    content: section.content,
    summary: null,
    keywords: `${doc.kind}, ${section.name}`,
    hash: hashContent(section.content),
    importance: options.importance ?? 5,
    tokenCount: estimateTokens(section.content),
    fileType: 'config',
    language: doc.kind,
    symbolName: section.name,
    startLine: section.startLine,
    endLine: section.endLine,
    fileStem: path.basename(file),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }));
}
