import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { enableGlobalAgentInstructions } from '../../src/cli/utils/global-agent-setup.js';

const homes: string[] = [];
function fixture() {
  // Keep fixture homes canonical while testing symlink rejection below the home.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-global-')));
  homes.push(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const env = { HOME: home, PATH: bin };
  const install = (name: string) =>
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  return { home, env, install };
}
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('global agent instructions', () => {
  it('detects executable clients and directories, preserves text and is idempotent', () => {
    const { home, env, install } = fixture();
    install('codex');
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'My guidance\n');
    const first = enableGlobalAgentInstructions({ env, home });
    expect(first.find((x) => x.agent === 'codex')?.status).toBe('updated');
    expect(first.find((x) => x.agent === 'claude')?.status).toBe('updated');
    expect(first.find((x) => x.agent === 'grok')?.status).toBe('not-installed');
    const content = fs.readFileSync(path.join(home, '.codex', 'AGENTS.md'), 'utf8');
    expect(content).toContain('contextos setup --check --json');
    expect(content).toContain('ask the user once');
    expect(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(
      'My guidance\n\n@AGENTS.md'
    );
    const second = enableGlobalAgentInstructions({ env, home });
    expect(second.find((x) => x.agent === 'codex')?.status).toBe('unchanged');
    expect(second.find((x) => x.agent === 'claude')?.status).toBe('unchanged');
  });
  it('shares Gemini instructions, supports dry runs and ignores non-executable files', () => {
    const { home, env, install } = fixture();
    install('gemini');
    install('agy');
    fs.writeFileSync(path.join(home, 'bin', 'grok'), 'not executable');
    const result = enableGlobalAgentInstructions({ env, home, dryRun: true });
    expect(result.find((x) => x.agent === 'gemini')?.status).toBe('would-update');
    expect(result.find((x) => x.agent === 'grok')?.status).toBe('not-installed');
    expect(fs.existsSync(path.join(home, '.gemini'))).toBe(false);
    enableGlobalAgentInstructions({ env, home });
    expect(
      fs
        .readFileSync(path.join(home, '.gemini', 'GEMINI.md'), 'utf8')
        .match(/contextos:managed:start/g)
    ).toHaveLength(1);
  });
  it('rejects symlink destinations and parents without touching their targets', () => {
    const { home, env, install } = fixture();
    install('codex');
    const target = path.join(home, 'target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(home, '.codex'));
    const [result] = enableGlobalAgentInstructions({ env, home, agent: 'codex' });
    expect(result.status).toBe('error');
    expect(fs.readdirSync(target)).toEqual([]);
  });
  it('postinstall only enables instructions on global installs and respects opt-out', () => {
    const { home, env, install } = fixture();
    install('codex');
    const script = path.resolve('scripts/postinstall.mjs');
    const run = (extra: NodeJS.ProcessEnv) =>
      spawnSync(process.execPath, [script], {
        env: { ...env, CONTEXTOS_SUPPRESS_INSTALL_NOTICE: '1', ...extra },
        encoding: 'utf8'
      });
    expect(run({}).status).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
    expect(run({ npm_config_global: 'true', CONTEXTOS_GLOBAL_INSTRUCTIONS: '0' }).status).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex'))).toBe(false);
    expect(run({ npm_config_global: 'true' }).status).toBe(0);
    expect(fs.existsSync(path.join(home, '.codex', 'AGENTS.md'))).toBe(true);
  });
});
