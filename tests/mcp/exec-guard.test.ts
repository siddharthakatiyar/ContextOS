import { describe, it, expect, afterEach } from 'vitest';
import { repoScriptsAllowed } from '../../src/mcp/tools/execute.js';

describe('ctx_execute repo-script gate (execAllowRepoScripts)', () => {
  const orig = process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
  afterEach(() => {
    if (orig === undefined) delete process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
    else process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = orig;
  });

  it('defaults to allowed when the env var is unset', () => {
    delete process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
    expect(repoScriptsAllowed()).toBe(true);
  });

  it('is disabled by CONTEXTOS_EXEC_ALLOW_SCRIPTS=0', () => {
    process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = '0';
    expect(repoScriptsAllowed()).toBe(false);
  });

  it('is disabled by CONTEXTOS_EXEC_ALLOW_SCRIPTS=false', () => {
    process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = 'false';
    expect(repoScriptsAllowed()).toBe(false);
  });

  it('is enabled by CONTEXTOS_EXEC_ALLOW_SCRIPTS=1', () => {
    process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS = '1';
    expect(repoScriptsAllowed()).toBe(true);
  });
});
