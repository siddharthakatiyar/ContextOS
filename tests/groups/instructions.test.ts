import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_BLOCK_START,
  agentInstructionsBlock,
  installAgentInstructions
} from '../../src/cli/utils/agent-instructions.js';
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-instructions-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('managed agent guidance', () => {
  it('preserves user guidance and is idempotent', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# My project\nDo not change user guidance.\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Shared project guidance\nKeep this too.\n');
    expect(installAgentInstructions(root).changed).toBe(true);
    expect(installAgentInstructions(root).changed).toBe(false);
    const text = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(claude).toBe('# My project\nDo not change user guidance.\n\n@AGENTS.md\n');
    expect(claude).not.toContain(AGENT_BLOCK_START);
    expect(text).toContain('# Shared project guidance\nKeep this too.\n');
    expect(text.split(AGENT_BLOCK_START)).toHaveLength(2);
    expect(text).toContain('ctx_link');
    expect(text).toContain('Do not save candidates');
  });
  it('replaces only marked legacy generated blocks', () => {
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      'User intro\n<!-- CONTEXTOS START -->\nold generated text\n<!-- CONTEXTOS END -->\nUser ending\n'
    );
    installAgentInstructions(root);
    const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(text).not.toContain('old generated text');
    expect(text).toContain('User intro');
    expect(text).toContain('User ending');
    expect(text).toContain('@AGENTS.md');
    expect(text).not.toContain(AGENT_BLOCK_START);
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toContain('ctx_link');
    expect(installAgentInstructions(root).changed).toBe(false);
  });
  it('upgrades the exact unmarked legacy paragraph without duplicate instructions', () => {
    const paragraph =
      'Before searching or exploring code in this workspace with grep, file search, or a general-purpose search/explore agent, call get_context first for questions about where or how something is implemented, service relationships, or conventions. It returns precise, indexed answers directly from this workspace and is faster and more accurate than ad-hoc file search for those questions. Fall back to broad file search only for tasks get_context does not cover (e.g. renaming across files, running commands, or content get_context returns no results for).';
    fs.writeFileSync(
      path.join(root, 'CLAUDE.md'),
      `Custom intro\n\n## ContextOS\n${paragraph}\n\n## My policy\nKeep this custom guidance.\n`
    );
    installAgentInstructions(root);
    const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(text).not.toContain(paragraph);
    expect(text).not.toContain('## ContextOS');
    expect(text).toContain('Custom intro');
    expect(text).toContain('Keep this custom guidance.');
    expect(installAgentInstructions(root).changed).toBe(false);
  });

  it('creates shared instructions and a Claude import for a new project', () => {
    expect(installAgentInstructions(root)).toEqual({
      file: path.join(root, 'AGENTS.md'),
      changed: true
    });
    expect(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8')).toBe(
      `${agentInstructionsBlock()}\n`
    );
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n');
    expect(installAgentInstructions(root).changed).toBe(false);
  });

  it('moves marked instructions out of CLAUDE.md and replaces duplicate managed blocks in AGENTS.md', () => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), `Before\n${agentInstructionsBlock()}\nAfter\n`);
    fs.writeFileSync(
      path.join(root, 'AGENTS.md'),
      `Shared notes\n${agentInstructionsBlock()}\n${agentInstructionsBlock()}\nKeep me.\n`
    );
    installAgentInstructions(root);
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    const claude = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    expect(agents.split(AGENT_BLOCK_START)).toHaveLength(2);
    expect(agents).toContain('Shared notes');
    expect(agents).toContain('Keep me.');
    expect(claude).toContain('Before\n');
    expect(claude).toContain('\nAfter\n');
    expect(claude).not.toContain(AGENT_BLOCK_START);
    expect(installAgentInstructions(root).changed).toBe(false);
  });

  it.each(['@AGENTS.md\n', '@./AGENTS.md\r\n', 'Shared instructions: @AGENTS.md\n'])(
    'preserves an existing Claude import: %s',
    (existing) => {
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), existing);
      installAgentInstructions(root);
      expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(existing);
      expect(installAgentInstructions(root).changed).toBe(false);
    }
  );

  it.each([
    'Example: `@AGENTS.md`\n',
    '```markdown\n@AGENTS.md\n```\n',
    '~~~~markdown\n@AGENTS.md\n~~~~\n',
    '@AGENTS.md.backup\n'
  ])('adds a real import when the existing reference is inactive: %s', (existing) => {
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), existing);
    installAgentInstructions(root);
    expect(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8')).toBe(`${existing}\n@AGENTS.md\n`);
    expect(installAgentInstructions(root).changed).toBe(false);
  });

  it.each(['AGENTS.md', 'CLAUDE.md'])('rejects %s symlinks before changing either file', (name) => {
    const other = name === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
    fs.writeFileSync(path.join(root, other), 'Keep unchanged.\n');
    fs.symlinkSync(path.join(root, 'missing-target.md'), path.join(root, name));
    expect(() => installAgentInstructions(root)).toThrow(`${name} is a symlink`);
    expect(fs.readFileSync(path.join(root, other), 'utf8')).toBe('Keep unchanged.\n');
    expect(fs.existsSync(path.join(root, 'missing-target.md'))).toBe(false);
  });
});
