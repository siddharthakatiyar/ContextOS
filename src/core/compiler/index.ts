import { RetrievalResult } from '../retrieval/types.js';
import { CompiledContext, CompilerOptions } from './types.js';
import { compressChunks } from './compressor.js';
import { estimateTokens } from '../../utils/tokens.js';
import path from 'path';

export * from './types.js';

export function compile(result: RetrievalResult, opts: CompilerOptions): CompiledContext {
  const compressedChunks = compressChunks(result.chunks, opts.maxTokens);
  
  // Group by layer
  const byLayer: Record<string, typeof compressedChunks> = {
    session: [],
    repo: [],
    workspace: [],
    global: []
  };

  for (const chunk of compressedChunks) {
    byLayer[chunk.layer].push(chunk);
  }

  let output = '## Relevant Context (ContextOS)\n\n';

  const formatChunk = (chunk: any) => {
    let output = '';
    
    // Add title/file context concisely
    if (chunk.symbolName) {
      output += `\`${chunk.symbolKind} ${chunk.symbolName}\` (in \`${path.basename(chunk.sourceFile)}\`):\n`;
    } else if (chunk.sectionTitle) {
      output += `**${chunk.sectionTitle}** (in \`${path.basename(chunk.sourceFile)}\`):\n`;
    } else {
      output += `File: \`${path.basename(chunk.sourceFile)}\`:\n`;
    }

    // Wrap in code block if it's code, else plain
    if (chunk.language) {
      output += `\`\`\`${chunk.language}\n${chunk.content.trim()}\n\`\`\`\n\n`;
    } else {
      output += `${chunk.content.trim()}\n\n`;
    }
    
    return output;
  };

  if (byLayer.session.length > 0) {
    output += '### Session Context\n';
    byLayer.session.forEach(c => output += formatChunk(c));
    output += '\n';
  }

  if (byLayer.repo.length > 0) {
    output += '### Repository Context\n';
    byLayer.repo.forEach(c => output += formatChunk(c));
    output += '\n';
  }

  if (byLayer.workspace.length > 0) {
    output += '### Workspace Context\n';
    byLayer.workspace.forEach(c => output += formatChunk(c));
    output += '\n';
  }

  if (byLayer.global.length > 0) {
    output += '### Global Context\n';
    byLayer.global.forEach(c => output += formatChunk(c));
    output += '\n';
  }

  if (result.expandedEntities.length > 0) {
    output += '### Related Entities (Graphify)\n';
    for (const e of result.expandedEntities) {
      output += `- \`${e.entity}\` (discovered via \`${e.relationshipType}\`)\n`;
    }
  }

  return {
    output,
    tokenCount: estimateTokens(output)
  };
}
