import { RetrievalResult, ScoredChunk } from '../retrieval/types.js';
import { CompiledContext, CompilerOptions } from './types.js';
import { compressChunks, stubLocLabel } from './compressor.js';
import { estimateTokens } from '../../utils/tokens.js';
import path from 'path';

export * from './types.js';
export { canonicalizeWhitespace, minifyConfigContent, buildSignalRegex, truncatePreservingSignals, stubLocLabel } from './compressor.js';

function escapeXml(unsafe: string | null | undefined): string {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** B18: Escape `]]>` inside XML CDATA sections. */
function escapeCdata(text: string): string {
  return text.replace(/]]>/g, ']]]]><![CDATA[>');
}

/** B20: Prefer summary === '[stub]'; avoid misclassifying one-liners with em-dash. */
function isStub(chunk: ScoredChunk): boolean {
  return chunk.summary === '[stub]';
}

function signatureLine(chunk: ScoredChunk): string {
  const loc = stubLocLabel(chunk);
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

function collectSignalTerms(result: RetrievalResult, opts: CompilerOptions): string[] {
  const terms: string[] = [...(opts.signalTerms || [])];
  const intent = result.intent;
  if (intent) {
    terms.push(...(intent.identifiers || []));
    terms.push(...(intent.concepts || []));
    terms.push(...(intent.quotedTerms || []));
    const raw = intent.rawPrompt || '';
    const camel = raw.match(/[A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]*/g) || [];
    terms.push(...camel);
    const snake = raw.match(/[a-z][a-z0-9]*(?:_[a-z0-9]+)+/gi) || [];
    terms.push(...snake);
    // Filename / path-like tokens (get-context, session-store.ts, defaults.ts)
    const fileish = raw.match(/[A-Za-z][\w.-]*\.(?:ts|tsx|js|jsx|mjs|cjs|md|json|ya?ml)\b/g) || [];
    terms.push(...fileish);
    const kebab = raw.match(/\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi) || [];
    terms.push(...kebab);
  }
  return [...new Set(terms.filter(Boolean))];
}

function locLabel(chunk: ScoredChunk, displayPath: string): string {
  if (chunk.startLine != null && chunk.endLine != null) {
    return `${displayPath}:${chunk.startLine}-${chunk.endLine}`;
  }
  return displayPath;
}

function chunkHeader(chunk: ScoredChunk, displayPath: string): string {
  const loc = locLabel(chunk, displayPath);
  if (chunk.symbolName) {
    if (chunk.parentSymbol) {
      return `\`${chunk.parentSymbol}.${chunk.symbolName}\` (\`${loc}\`):`;
    }
    return `\`${chunk.symbolKind || 'symbol'} ${chunk.symbolName}\` (\`${loc}\`):`;
  }
  if (chunk.sectionTitle) {
    return `**${chunk.sectionTitle}** (\`${loc}\`):`;
  }
  return `\`${loc}\`:`;
}

/** Longest common directory prefix of absolute-ish paths (at least 2 segments). */
function commonDirPrefix(files: string[]): string {
  if (files.length < 2) return '';
  const split = files.map((f) => f.replace(/\\/g, '/').split('/').filter(Boolean));
  const minLen = Math.min(...split.map((s) => s.length));
  if (minLen < 2) return '';
  const prefix: string[] = [];
  for (let i = 0; i < minLen - 1; i++) {
    const part = split[0][i];
    if (split.every((s) => s[i] === part)) prefix.push(part);
    else break;
  }
  // Need a meaningful prefix (e.g. src/core) — at least 2 segments
  if (prefix.length < 2) return '';
  return prefix.join('/');
}

/**
 * Path-alias legend only when exact token count is net-positive.
 * Returns map sourceFile → display path, plus optional legend lines.
 */
function buildPathAliases(chunks: ScoredChunk[]): {
  display: Map<string, string>;
  legend: string;
} {
  const display = new Map<string, string>();
  const files = [...new Set(chunks.map((c) => c.sourceFile).filter((f) => f && f !== 'session' && f !== 'memory.fact'))];
  for (const f of files) display.set(f, path.basename(f));

  const prefix = commonDirPrefix(files);
  if (!prefix || files.length < 2) {
    return { display, legend: '' };
  }

  const aliased = new Map<string, string>();
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    if (norm.includes(prefix + '/')) {
      aliased.set(f, '@/' + norm.slice(norm.indexOf(prefix + '/') + prefix.length + 1));
    } else {
      aliased.set(f, path.basename(f));
    }
  }
  const legend = `@=${prefix}\n`;

  // Compare token cost: basename headers vs aliased+legend (approximate via sample headers)
  const without = files.map((f) => `\`${path.basename(f)}\``).join('\n');
  const withAlias = legend + files.map((f) => `\`${aliased.get(f)}\``).join('\n');
  if (estimateTokens(withAlias) < estimateTokens(without)) {
    return { display: aliased, legend };
  }
  return { display, legend: '' };
}

/** Merge same-file full-body code chunks into one fence where possible. */
function formatMergedFileGroup(chunks: ScoredChunk[], displayPath: string): string {
  if (chunks.length === 0) return '';
  if (chunks.length === 1) {
    const chunk = chunks[0];
    let out = chunkHeader(chunk, displayPath) + '\n';
    if (chunk.language) {
      out += `\`\`\`${chunk.language}\n${chunk.content.trim()}\n\`\`\`\n`;
    } else {
      out += `${chunk.content.trim()}\n`;
    }
    return out;
  }

  // Same language? single fence with separators
  const langs = new Set(chunks.map((c) => c.language || ''));
  const canMerge = langs.size === 1 && [...langs][0] !== '';
  if (!canMerge) {
    return chunks.map((c) => {
      let out = chunkHeader(c, displayPath) + '\n';
      if (c.language) out += `\`\`\`${c.language}\n${c.content.trim()}\n\`\`\`\n`;
      else out += `${c.content.trim()}\n`;
      return out;
    }).join('');
  }

  const lang = chunks[0].language!;
  const labels = chunks
    .map((c) => {
      if (c.symbolName) return c.symbolName;
      if (c.sectionTitle) return c.sectionTitle;
      if (c.startLine != null) return `L${c.startLine}`;
      return '';
    })
    .filter(Boolean)
    .join(', ');
  const loc = locLabel(
    {
      ...chunks[0],
      startLine: chunks[0].startLine,
      endLine: chunks[chunks.length - 1].endLine ?? chunks[0].endLine,
    },
    displayPath,
  );
  let out = labels ? `\`${labels}\` (\`${loc}\`):\n` : `\`${loc}\`:\n`;
  out += `\`\`\`${lang}\n`;
  out += chunks.map((c) => c.content.trim()).join('\n//---\n');
  out += `\n\`\`\`\n`;
  return out;
}

function formatLayerChunks(chunks: ScoredChunk[], pathDisplay: Map<string, string>): string {
  // Group consecutive same-file chunks
  const groups: ScoredChunk[][] = [];
  for (const c of chunks) {
    const last = groups[groups.length - 1];
    if (last && last[0].sourceFile === c.sourceFile && c.language) {
      last.push(c);
    } else {
      groups.push([c]);
    }
  }
  let out = '';
  for (const g of groups) {
    const display = pathDisplay.get(g[0].sourceFile) || path.basename(g[0].sourceFile);
    out += formatMergedFileGroup(g, display);
  }
  return out;
}

/** Group stubs by file for compact listing (path + line ranges for targeted reads). */
function formatStubs(stubs: ScoredChunk[]): string {
  if (stubs.length === 0) return '';
  const byFile = new Map<string, ScoredChunk[]>();
  for (const s of stubs) {
    const key = stubLocLabel({ ...s, startLine: null, endLine: null });
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(s);
  }
  let out = '### Also\n';
  for (const [, list] of byFile) {
    if (list.length === 1) {
      out += `- ${signatureLine(list[0])}\n`;
    } else {
      const fileKey = stubLocLabel({ ...list[0], startLine: null, endLine: null });
      const parts = list.map((s) => {
        const range =
          s.startLine != null && s.endLine != null ? `:${s.startLine}-${s.endLine}` : '';
        if (s.symbolName) return `${s.symbolKind || 'symbol'} ${s.symbolName}${range}`;
        if (s.sectionTitle) return `${s.sectionTitle}${range}`;
        return stubLocLabel(s);
      });
      out += `- \`${fileKey}\`: ${parts.map((p) => `\`${p}\``).join(', ')}\n`;
    }
  }
  out += '\n';
  return out;
}

export function compile(result: RetrievalResult, opts: CompilerOptions): CompiledContext {
  const signalTerms = collectSignalTerms(result, opts);
  // Leave headroom for markdown framing so final output stays ≤ maxTokens
  const compressBudget = Math.max(360, opts.maxTokens - 128);
  const compressedChunks = compressChunks(result.chunks, compressBudget, {
    signalTerms,
    identifiers: result.intent?.identifiers || [],
    concepts: result.intent?.concepts || [],
  });
  const full = compressedChunks.filter((c) => !isStub(c));
  const stubs = compressedChunks.filter((c) => isStub(c));

  const byLayer: Record<string, ScoredChunk[]> = {
    session: [],
    repo: [],
    workspace: [],
    global: [],
  };

  for (const chunk of full) {
    byLayer[chunk.layer]?.push(chunk);
  }

  const entities = result.expandedEntities
    .filter((e) => isIdentifierEntity(e.entity))
    .slice(0, 3);

  const { display: pathDisplay, legend } = buildPathAliases(full);

  if (opts.outputFormat === 'xml') {
    let xmlOutput = `<contextos_context>\n`;

    const formatXmlChunk = (chunk: ScoredChunk) => {
      const src = pathDisplay.get(chunk.sourceFile) || path.basename(chunk.sourceFile);
      let out = `<chunk id="${escapeXml(chunk.id)}" layer="${escapeXml(chunk.layer)}" source="${escapeXml(src)}"`;
      if (chunk.symbolName) out += ` symbol="${escapeXml(chunk.symbolName)}" kind="${escapeXml(chunk.symbolKind)}"`;
      if (chunk.sectionTitle) out += ` section="${escapeXml(chunk.sectionTitle)}"`;
      if (chunk.startLine != null) out += ` start="${chunk.startLine}"`;
      if (chunk.endLine != null) out += ` end="${chunk.endLine}"`;
      out += `>\n`;
      out += `<![CDATA[\n${escapeCdata(chunk.content.trim())}\n]]>\n`;
      out += `</chunk>\n`;
      return out;
    };

    if (legend) {
      xmlOutput += `<path_alias>${escapeXml(legend.trim())}</path_alias>\n`;
    }

    for (const layer of ['session', 'repo', 'workspace', 'global'] as const) {
      if (byLayer[layer].length > 0) {
        xmlOutput += `<layer name="${layer}">\n`;
        byLayer[layer].forEach((c) => (xmlOutput += formatXmlChunk(c)));
        xmlOutput += `</layer>\n`;
      }
    }
    if (stubs.length > 0) {
      xmlOutput += `<stubs>\n`;
      for (const s of stubs) {
        const src = stubLocLabel(s);
        xmlOutput += `  <stub source="${escapeXml(src)}" symbol="${escapeXml(s.symbolName || '')}"`;
        if (s.startLine != null) xmlOutput += ` start="${s.startLine}"`;
        if (s.endLine != null) xmlOutput += ` end="${s.endLine}"`;
        xmlOutput += ` />\n`;
      }
      xmlOutput += `</stubs>\n`;
    }
    if (entities.length > 0) {
      xmlOutput += `<related>\n`;
      for (const e of entities) {
        xmlOutput += `  <entity name="${escapeXml(e.entity)}" rel="${escapeXml(e.relationshipType)}" />\n`;
      }
      xmlOutput += `</related>\n`;
    }
    xmlOutput += `</contextos_context>\n`;

    return {
      output: xmlOutput,
      tokenCount: estimateTokens(xmlOutput),
    };
  }

  // Cap stubs to limit framing tokens
  const cappedStubs = stubs.slice(0, 3);

  // Markdown — compact framing
  let output = legend ? legend : '';

  const layerLabels: Record<string, string> = {
    session: 'Session',
    repo: 'Repo',
    workspace: 'Workspace',
    global: 'Global',
  };

  const populatedLayers = (['session', 'repo', 'workspace', 'global'] as const)
    .filter(l => byLayer[l].length > 0);

  for (const layer of populatedLayers) {
    if (populatedLayers.length > 1) {
      output += `### ${layerLabels[layer]}\n`;
    }
    output += formatLayerChunks(byLayer[layer], pathDisplay);
  }

  // Soft budget for optional framing (stubs/related) so avg stays near baseline
  const softBudget = Math.floor(opts.maxTokens * 0.86);
  const stubsBlock = formatStubs(cappedStubs);
  if (stubsBlock && estimateTokens(output) + estimateTokens(stubsBlock) <= softBudget) {
    output += stubsBlock;
  }

  output = trimOutputToBudget(output, opts.maxTokens);

  // Final hard gate: if still over, drop stub section
  let tok = estimateTokens(output);
  if (tok > opts.maxTokens) {
    output = output.replace(/\n### Also\n[\s\S]*?(?=\n### |\n*$)/, '\n');
  }

  return {
    output,
    tokenCount: estimateTokens(output),
  };
}

/** Drop low-value framing sections when over budget (never touches code fences). */
function trimOutputToBudget(output: string, maxTokens: number): string {
  let tok = estimateTokens(output);
  if (tok <= maxTokens) return output;
  return output.replace(/\n### Also\n[\s\S]*?(?=\n### |\n*$)/, '\n');
}
