import fs from 'node:fs';
import path from 'node:path';
import { MCP_SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';

export const AGENT_BLOCK_START = '<!-- contextos:managed:start -->';
export const AGENT_BLOCK_END = '<!-- contextos:managed:end -->';
export function agentInstructionsBlock(): string {
  return `${AGENT_BLOCK_START}\n## ContextOS (managed instructions v1.1.1)\n\n${MCP_SERVER_INSTRUCTIONS}\n${AGENT_BLOCK_END}`;
}
/** Rewrites only recognizable generated sections, preserving user-authored guidance. */
export function rewriteManagedInstructions(previous: string, replacement: string): string {
  const managed = /<!-- contextos:managed:start -->[\s\S]*?<!-- contextos:managed:end -->/g;
  const legacy =
    /<!-- (?:CONTEXTOS|contextos)(?::| )START -->[\s\S]*?<!-- (?:CONTEXTOS|contextos)(?::| )END -->/g;
  // v1.1.0/v1.1.1 generated this exact unmarked section. Match its full body,
  // never a general ContextOS heading that may contain user-authored guidance.
  const oldInstructions =
    'Before searching or exploring code in this workspace with grep, file search, or a general-purpose search/explore agent, call get_context first for questions about where or how something is implemented, service relationships, or conventions. It returns precise, indexed answers directly from this workspace and is faster and more accurate than ad-hoc file search for those questions. Fall back to broad file search only for tasks get_context does not cover (e.g. renaming across files, running commands, or content get_context returns no results for).';
  const oldSection = `## ContextOS\n${oldInstructions}`;
  let inserted = false;
  let next = previous.replace(managed, () => {
    if (inserted) return '';
    inserted = true;
    return replacement;
  });
  next = next.replace(legacy, () => {
    if (inserted) return '';
    inserted = true;
    return replacement;
  });
  next = next.replace(oldSection, () => {
    if (inserted) return '';
    inserted = true;
    return replacement;
  });
  return !inserted && replacement ? appendSection(next, replacement) : next;
}

export function appendSection(previous: string, section: string): string {
  return `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${previous ? '\n' : ''}${section}\n`;
}

function readInstructions(file: string): string {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
  if (stat.isSymbolicLink())
    throw new Error(
      `${path.basename(file)} is a symlink; update the target instructions explicitly.`
    );
  return fs.readFileSync(file, 'utf8');
}

/** Claude imports are active outside Markdown code spans and fenced code blocks. */
export function hasAgentsImport(content: string): boolean {
  let fence: { character: string; length: number } | undefined;
  const prose: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      )
        fence = undefined;
      continue;
    }
    if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
      continue;
    }
    prose.push(line);
  }
  const withoutCode = prose.join('\n').replace(/(`+)[\s\S]*?\1/g, '');
  return /(?:^|[\s(])@(?:\.\/)?AGENTS\.md(?=$|[\s),;:!?]|\.(?=\s|$))/m.test(withoutCode);
}

/** Installs shared AGENTS.md guidance and migrates generated CLAUDE.md sections to an import. */
export function installAgentInstructions(root: string): { file: string; changed: boolean } {
  const file = path.join(root, 'AGENTS.md');
  const claudeFile = path.join(root, 'CLAUDE.md');
  // Validate both files before writing either, including dangling symlinks.
  const previous = readInstructions(file);
  const previousClaude = readInstructions(claudeFile);
  const next = rewriteManagedInstructions(previous, agentInstructionsBlock());
  let nextClaude = rewriteManagedInstructions(previousClaude, '');
  if (!hasAgentsImport(nextClaude)) nextClaude = appendSection(nextClaude, '@AGENTS.md');
  if (next !== previous) fs.writeFileSync(file, next, { mode: 0o644 });
  if (nextClaude !== previousClaude) fs.writeFileSync(claudeFile, nextClaude, { mode: 0o644 });
  return { file, changed: next !== previous || nextClaude !== previousClaude };
}
