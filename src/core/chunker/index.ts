import crypto from 'crypto';
import { ParsedDocument, Section } from '../parser/types.js';
import { Chunk } from '../storage/types.js';
import { loadConfig } from '../../config/index.js';
import { ChunkCreationOptions } from './types.js';
import { estimateTokens } from '../../utils/tokens.js';
import { hashContent } from '../../utils/hash.js';
import { STOPWORDS } from '../../utils/stopwords.js';

export function chunkDocument(doc: ParsedDocument, options: ChunkCreationOptions): Chunk[] {
  const chunks: Chunk[] = [];
  const maxTokens = options.maxChunkTokens || loadConfig().maxChunkTokens;

  // Titles must be unique per file or two chunks collide on the same stable ID
  // and one silently overwrites the other in the DB (e.g. two "Installation"
  // H2 sections). Mirrors the existing `#seg` convention.
  const usedTitleKeys = new Set<string>();
  const uniqueTitle = (base: string): string => {
    if (!usedTitleKeys.has(base)) {
      usedTitleKeys.add(base);
      return base;
    }
    let n = 1;
    while (usedTitleKeys.has(`${base}#dup${n}`)) n++;
    const key = `${base}#dup${n}`;
    usedTitleKeys.add(key);
    return key;
  };

  function traverse(sections: Section[], breadcrumbs: string[] = []) {
    for (const section of sections) {
      const currentBreadcrumbs = section.title ? [...breadcrumbs, section.title] : breadcrumbs;

      // Only chunk leaf sections (sections without children), or if there is content before children
      if (section.content.trim().length > 0) {
        let titleContext = '';
        if (currentBreadcrumbs.length > 3) {
          titleContext = [
            currentBreadcrumbs[0],
            '...',
            currentBreadcrumbs[currentBreadcrumbs.length - 2],
            currentBreadcrumbs[currentBreadcrumbs.length - 1]
          ].join(' > ');
        } else {
          titleContext = currentBreadcrumbs.join(' > ');
        }
        titleContext = uniqueTitle(titleContext);
        const tokens = estimateTokens(section.content);

        if (tokens > maxTokens) {
          // split by paragraphs if too long — never cutting through fenced code
          const blocks = splitBlocksRespectingFences(section.content);
          let currentChunkContent = '';
          let currentTokens = 0;

          let segIndex = 0;
          const flushChunk = () => {
            if (currentChunkContent.trim().length === 0) return;
            const segTitleContext = `${titleContext}#seg${segIndex++}`;
            chunks.push(
              createChunk(
                currentChunkContent.trim(),
                segTitleContext,
                section.depth,
                doc.filePath,
                options,
                doc.frontmatter
              )
            );
            currentChunkContent = '';
            currentTokens = 0;
          };

          for (const block of blocks) {
            const blockTokens = estimateTokens(block);

            // A single paragraph larger than the budget cannot make progress by
            // accumulation — hard-split it by lines so the budget contract holds.
            if (blockTokens > maxTokens && !block.includes('```') && !block.includes('~~~')) {
              flushChunk();
              for (const piece of hardSplitByLines(block, maxTokens)) {
                const segTitleContext = `${titleContext}#seg${segIndex++}`;
                chunks.push(
                  createChunk(
                    piece.trim(),
                    segTitleContext,
                    section.depth,
                    doc.filePath,
                    options,
                    doc.frontmatter
                  )
                );
              }
              continue;
            }

            if (currentTokens + blockTokens > maxTokens && currentChunkContent.trim().length > 0) {
              flushChunk();
            }
            currentChunkContent += block + '\n\n';
            currentTokens += blockTokens;
          }
          flushChunk();
        } else {
          chunks.push(
            createChunk(
              section.content,
              titleContext,
              section.depth,
              doc.filePath,
              options,
              doc.frontmatter
            )
          );
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

/**
 * Split content on blank lines WITHOUT ever breaking inside a fenced code block.
 * Blank lines inside ``` / ~~~ fences stay attached to their block; the fence
 * delimiters themselves are preserved verbatim in the returned block content.
 */
export function splitBlocksRespectingFences(content: string): string[] {
  const lines = content.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let fenceChar: '`' | '~' | null = null;
  let fenceLength = 0;

  for (const line of lines) {
    if (fenceChar) {
      // CommonMark closers use the same marker, contain at least as many marker
      // characters as the opener, and have only whitespace after the marker.
      const closeMatch = /^ {0,3}(`{3,}|~{3,})[\t ]*$/.exec(line);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLength) {
        fenceChar = null;
        fenceLength = 0;
      }
    } else {
      // CommonMark permits up to three leading spaces. Backtick info strings
      // cannot themselves contain a backtick.
      const openMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (openMatch) {
        const marker = openMatch[1];
        const markerChar = marker[0] as '`' | '~';
        const info = openMatch[2];
        if (markerChar === '~' || !info.includes('`')) {
          fenceChar = markerChar;
          fenceLength = marker.length;
        }
      }
    }

    if (!fenceChar && line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current.join('\n'));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join('\n'));
  return blocks;
}

/** Hard-split text into pieces of at most ~maxTokens (by lines, then words). */
function hardSplitByLines(text: string, maxTokens: number): string[] {
  const pieces: string[] = [];
  let buf: string[] = [];
  let tokens = 0;

  const flushBuf = () => {
    if (buf.length === 0) return;
    pieces.push(buf.join('\n'));
    buf = [];
    tokens = 0;
  };

  for (const line of text.split('\n')) {
    const lineTokens = estimateTokens(line);
    if (tokens + lineTokens > maxTokens && buf.length > 0) {
      flushBuf();
    }

    if (lineTokens > maxTokens) {
      // A single line over budget (e.g. a space-joined mega-paragraph): fall
      // back to whole-word splitting so progress is always possible.
      let cur = '';
      let curTokens = 0;
      for (const word of line.split(/\s+/)) {
        const wordTokens = estimateTokens(word);
        if (curTokens + wordTokens + 1 > maxTokens && cur.length > 0) {
          pieces.push(cur);
          cur = '';
          curTokens = 0;
        }
        cur = cur ? `${cur} ${word}` : word;
        curTokens += wordTokens + 1;
      }
      if (cur.length > 0) pieces.push(cur);
      continue;
    }

    buf.push(line);
    tokens += lineTokens;
  }
  flushBuf();
  return pieces;
}

function createChunk(
  content: string,
  titleContext: string,
  depth: number,
  filePath: string,
  options: ChunkCreationOptions,
  frontmatter?: Record<string, unknown>
): Chunk {
  const keywords = extractKeywords(content, titleContext);

  if (frontmatter) {
    const customKeys = Array.isArray(frontmatter.triggers)
      ? frontmatter.triggers
      : typeof frontmatter.triggers === 'string'
        ? frontmatter.triggers.split(',')
        : [];
    const customKws = Array.isArray(frontmatter.keywords)
      ? frontmatter.keywords
      : typeof frontmatter.keywords === 'string'
        ? frontmatter.keywords.split(',')
        : [];

    for (const k of [...customKeys, ...customKws]) {
      if (typeof k === 'string') keywords.push(k.trim().toLowerCase());
    }
  }

  const contentHashVal = hashContent(content);
  // Stable ID: survives content edits (B7). hash field still tracks content changes.
  const id = crypto.createHash('md5').update(`${filePath}:${titleContext}`).digest('hex');

  const base = filePath.replace(/\\/g, '/').split('/').pop() || filePath;
  const fileStem = base.includes('.') ? base.replace(/\.[^.]+$/, '') : base;

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
    fileType: 'markdown',
    fileStem,
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

  return Array.from(keywords).filter((w) => !STOPWORDS.has(w));
}
