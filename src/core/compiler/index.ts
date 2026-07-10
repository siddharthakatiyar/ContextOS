import { RetrievalResult, ScoredChunk } from '../retrieval/types.js';
import { CompiledContext, CompilerOptions } from './types.js';
import { compressChunks } from './compressor.js';
import { estimateTokens } from '../../utils/tokens.js';
import path from 'path';

export * from './types.js';

function escapeXml(unsafe: string | null | undefined): string {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function isStub(chunk: ScoredChunk): boolean {
  return chunk.summary === '[stub]' || (chunk.content.includes(' — ') && chunk.tokenCount <= 40 && !chunk.content.includes('\n'));
}

function signatureLine(chunk: ScoredChunk): string {
  const loc = path.basename(chunk.sourceFile);
  if (chunk.symbolName) {
    return `\`${chunk.symbolKind || 'symbol'} ${chunk.symbolName}\` — \`${loc}\``;
  }
  if (chunk.sectionTitle) {
    return `**${chunk.sectionTitle}** — \`${loc}\``;
  }
  return `\`${loc}\``;
}

function isIdentifierEntity(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_.-]{2,}$/.test(name) && !/^(select|insert|order|desc|limit|values|update|delete|create)$/i.test(name);
}

export function compile(result: RetrievalResult, opts: CompilerOptions): CompiledContext {
  const compressedChunks = compressChunks(result.chunks, opts.maxTokens);
  const full = compressedChunks.filter(c => !isStub(c));
  const stubs = compressedChunks.filter(c => isStub(c));

  const byLayer: Record<string, ScoredChunk[]> = {
    session: [],
    repo: [],
    workspace: [],
    global: []
  };

  for (const chunk of full) {
    byLayer[chunk.layer]?.push(chunk);
  }

  const entities = result.expandedEntities
    .filter(e => isIdentifierEntity(e.entity))
    .slice(0, 5);

  if (opts.outputFormat === 'xml') {
    let xmlOutput = `<contextos_context>\n`;
    
    const formatXmlChunk = (chunk: any) => {
      let out = `<chunk id="${escapeXml(chunk.id)}" layer="${escapeXml(chunk.layer)}" source="${escapeXml(path.basename(chunk.sourceFile))}"`;
      if (chunk.symbolName) out += ` symbol="${escapeXml(chunk.symbolName)}" kind="${escapeXml(chunk.symbolKind)}"`;
      if (chunk.sectionTitle) out += ` section="${escapeXml(chunk.sectionTitle)}"`;
      out += `>\n`;
      out += `<![CDATA[\n${chunk.content.trim()}\n]]>\n`;
      out += `</chunk>\n`;
      return out;
    };

    for (const layer of ['session', 'repo', 'workspace', 'global'] as const) {
      if (byLayer[layer].length > 0) {
        xmlOutput += `<layer name="${layer}">\n`;
        byLayer[layer].forEach(c => xmlOutput += formatXmlChunk(c));
        xmlOutput += `</layer>\n`;
      }
    }
    if (stubs.length > 0) {
      xmlOutput += `<stubs>\n`;
      for (const s of stubs) {
        xmlOutput += `  <stub source="${escapeXml(path.basename(s.sourceFile))}" symbol="${escapeXml(s.symbolName || '')}" />\n`;
      }
      xmlOutput += `</stubs>\n`;
    }
    if (entities.length > 0) {
      xmlOutput += `<related_entities>\n`;
      for (const e of entities) {
        xmlOutput += `  <entity name="${escapeXml(e.entity)}" relationship="${escapeXml(e.relationshipType)}" score="${e.score}" />\n`;
      }
      xmlOutput += `</related_entities>\n`;
    }
    xmlOutput += `</contextos_context>\n`;
    
    return {
      output: xmlOutput,
      tokenCount: estimateTokens(xmlOutput)
    };
  }

  // Markdown — framing tokens counted via final estimateTokens(output)
  let output = '## Relevant Context (ContextOS)\n\n';

  const formatChunk = (chunk: any) => {
    let out = '';
    
    if (chunk.symbolName) {
      if (chunk.parentSymbol) {
        out += `\`class ${chunk.parentSymbol}\` → \`${chunk.symbolKind} ${chunk.symbolName}\` (in \`${path.basename(chunk.sourceFile)}\`):\n`;
      } else {
        out += `\`${chunk.symbolKind} ${chunk.symbolName}\` (in \`${path.basename(chunk.sourceFile)}\`):\n`;
      }
    } else if (chunk.sectionTitle) {
      out += `**${chunk.sectionTitle}** (in \`${path.basename(chunk.sourceFile)}\`):\n`;
    } else {
      out += `File: \`${path.basename(chunk.sourceFile)}\`:\n`;
    }

    if (chunk.language) {
      out += `\`\`\`${chunk.language}\n${chunk.content.trim()}\n\`\`\`\n\n`;
    } else {
      out += `${chunk.content.trim()}\n\n`;
    }
    
    return out;
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

  if (stubs.length > 0) {
    output += '### Also relevant\n';
    for (const s of stubs) {
      output += `- ${signatureLine(s)}\n`;
    }
    output += '\n';
  }

  if (entities.length > 0) {
    output += '### Related Entities\n';
    output += entities.map(e => `\`${e.entity}\``).join(', ') + '\n';
  }

  return {
    output,
    tokenCount: estimateTokens(output)
  };
}
