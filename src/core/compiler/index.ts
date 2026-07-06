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

  if (opts.outputFormat === 'xml') {
    let xmlOutput = `<contextos_context>\n`;
    
    const formatXmlChunk = (chunk: any) => {
      let out = `<chunk id="${chunk.id}" layer="${chunk.layer}" source="${path.basename(chunk.sourceFile)}"`;
      if (chunk.symbolName) out += ` symbol="${chunk.symbolName}" kind="${chunk.symbolKind}"`;
      if (chunk.sectionTitle) out += ` section="${chunk.sectionTitle}"`;
      out += `>\n`;
      out += `<![CDATA[\n${chunk.content.trim()}\n]]>\n`;
      out += `</chunk>\n`;
      return out;
    };

    if (byLayer.session.length > 0) {
      xmlOutput += `<layer name="session">\n`;
      byLayer.session.forEach(c => xmlOutput += formatXmlChunk(c));
      xmlOutput += `</layer>\n`;
    }
    if (byLayer.repo.length > 0) {
      xmlOutput += `<layer name="repo">\n`;
      byLayer.repo.forEach(c => xmlOutput += formatXmlChunk(c));
      xmlOutput += `</layer>\n`;
    }
    if (byLayer.workspace.length > 0) {
      xmlOutput += `<layer name="workspace">\n`;
      byLayer.workspace.forEach(c => xmlOutput += formatXmlChunk(c));
      xmlOutput += `</layer>\n`;
    }
    if (byLayer.global.length > 0) {
      xmlOutput += `<layer name="global">\n`;
      byLayer.global.forEach(c => xmlOutput += formatXmlChunk(c));
      xmlOutput += `</layer>\n`;
    }
    if (result.expandedEntities.length > 0) {
      xmlOutput += `<related_entities>\n`;
      for (const e of result.expandedEntities) {
        xmlOutput += `  <entity name="${e.entity}" relationship="${e.relationshipType}" score="${e.score}" />\n`;
      }
      xmlOutput += `</related_entities>\n`;
    }
    xmlOutput += `</contextos_context>\n`;
    
    return {
      output: xmlOutput,
      tokenCount: estimateTokens(xmlOutput)
    };
  }

  // Markdown format (default)
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
