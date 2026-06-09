import crypto from 'crypto';
import { ParsedDocument, Section } from '../parser/types.js';
import { Chunk } from '../storage/types.js';
import { ChunkCreationOptions } from './types.js';
import { estimateTokens } from '../../utils/tokens.js';
import { hashContent } from '../../utils/hash.js';
import { STOPWORDS } from '../../utils/stopwords.js';

export function chunkDocument(doc: ParsedDocument, options: ChunkCreationOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const maxTokens = options.maxChunkTokens || 1500;

  function traverse(sections: Section[], breadcrumbs: string[] = []) {
    for (const section of sections) {
      const currentBreadcrumbs = section.title ? [...breadcrumbs, section.title] : breadcrumbs;

      // Only chunk leaf sections (sections without children), or if there is content before children
      if (section.content.trim().length > 0) {
        let titleContext = '';
        if (currentBreadcrumbs.length > 3) {
          titleContext = [currentBreadcrumbs[0], '...', currentBreadcrumbs[currentBreadcrumbs.length - 2], currentBreadcrumbs[currentBreadcrumbs.length - 1]].join(' > ');
        } else {
          titleContext = currentBreadcrumbs.join(' > ');
        }
        let tokens = estimateTokens(section.content);

        if (tokens > maxTokens) {
          // split by paragraphs if too long
          const paragraphs = section.content.split(/\n\s*\n/);
          let currentChunkContent = '';
          let currentTokens = 0;

          for (const para of paragraphs) {
            const pTokens = estimateTokens(para);
            if (currentTokens + pTokens > maxTokens && currentChunkContent.trim().length > 0) {
              chunks.push(createChunk(currentChunkContent.trim(), titleContext, section.depth, doc.filePath, options));
              currentChunkContent = para + '\n\n';
              currentTokens = pTokens;
            } else {
              currentChunkContent += para + '\n\n';
              currentTokens += pTokens;
            }
          }
          if (currentChunkContent.trim().length > 0) {
            chunks.push(createChunk(currentChunkContent.trim(), titleContext, section.depth, doc.filePath, options));
          }
        } else {
          chunks.push(createChunk(section.content, titleContext, section.depth, doc.filePath, options));
        }
      }

      if (section.children.length > 0) {
        traverse(section.children, currentBreadcrumbs);
      }
    }
  }

  traverse(doc.sections);
  return chunks;
}

function createChunk(content: string, titleContext: string, depth: number, filePath: string, options: ChunkCreationOptions): Chunk {
  const keywords = extractKeywords(content, titleContext);
  const contentHashVal = hashContent(content);
  const idStr = `${filePath}:${titleContext}:${contentHashVal}`;
  const id = crypto.createHash('md5').update(idStr).digest('hex');
  
  return {
    id,
    sourceFile: filePath,
    layer: options.layer,
    workspaceName: options.workspaceName || null,
    sectionTitle: titleContext || null,
    sectionDepth: depth,
    content,
    summary: null,
    keywords: keywords.join(', '),
    hash: contentHashVal,
    importance: options.importance ?? 5,
    tokenCount: estimateTokens(content),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
}

export function extractKeywords(content: string, title: string | null): string[] {
  const keywords = new Set<string>();

  // 1. Heading words
  if (title) {
    const titleWords = title.split(/\W+/);
    for (const w of titleWords) {
      if (w.length > 2) keywords.add(w.toLowerCase());
    }
  }

  // 2. Inline code tokens
  const codeTokens = content.match(/`([^`]+)`/g);
  if (codeTokens) {
    for (const t of codeTokens) {
      const cleaned = t.replace(/`/g, '').trim();
      if (cleaned.length > 2) {
        // split camelCase and snake_case
        const parts = cleaned.split(/(?=[A-Z])|_|-|\./);
        for (const p of parts) {
          if (p.length > 2) keywords.add(p.toLowerCase());
        }
        keywords.add(cleaned.toLowerCase());
      }
    }
  }

  // 3. Capitalized words
  const capitalWords = content.match(/\b[A-Z][a-zA-Z]+\b/g);
  if (capitalWords) {
    for (const w of capitalWords) {
      if (w.length > 2) keywords.add(w.toLowerCase());
    }
  }

  return Array.from(keywords).filter(w => !STOPWORDS.has(w));
}
