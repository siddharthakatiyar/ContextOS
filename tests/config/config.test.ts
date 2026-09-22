import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig, mergeDeep, validateConfigJson } from '../../src/config/index.js';

describe('config mergeDeep', () => {
  it('union-merges arrays by default', () => {
    const target = { ignorePatterns: ['a/**', 'b/**'] };
    const source = { ignorePatterns: ['b/**', 'c/**'] };
    const result = mergeDeep(structuredClone(target), source);
    expect(result.ignorePatterns.sort()).toEqual(['a/**', 'b/**', 'c/**']);
  });

  it('replaces arrays when key ends with !', () => {
    const target = { ignorePatterns: ['a/**', 'b/**', 'node_modules/**'] };
    // Keys ending with `!` REPLACE the array instead of union-merging.
    const source = { 'ignorePatterns!': ['only/**'] };
    const result = mergeDeep(structuredClone(target), source);
    expect(result.ignorePatterns).toEqual(['only/**']);
    expect(result['ignorePatterns!']).toBeUndefined();
  });

  it('still deep-merges nested objects', () => {
    const target = { cursor: { autoGenerateConfig: true }, ftsLimit: 15 };
    const source = { cursor: { autoGenerateConfig: false } };
    const result = mergeDeep(structuredClone(target), source);
    expect(result.cursor.autoGenerateConfig).toBe(false);
    expect(result.ftsLimit).toBe(15);
  });
});

describe('validateConfigJson', () => {
  it('accepts known keys', () => {
    const result = validateConfigJson({ maxChunkTokens: 2000, ignorePatterns: ['x/**'] });
    expect(result).not.toBeNull();
    expect(result!.maxChunkTokens).toBe(2000);
    expect(result!.ignorePatterns).toEqual(['x/**']);
  });

  it('keeps ! override keys for known base keys', () => {
    const result = validateConfigJson({ 'ignorePatterns!': ['only/**'] });
    expect(result).not.toBeNull();
    expect(result!['ignorePatterns!']).toEqual(['only/**']);
  });

  it('strips unknown keys', () => {
    const result = validateConfigJson({ maxChunkTokens: 100, totallyUnknown: true });
    expect(result).not.toBeNull();
    expect(result!.maxChunkTokens).toBe(100);
    expect(result!.totallyUnknown).toBeUndefined();
  });

  it('rejects invalid types', () => {
    const result = validateConfigJson({ maxChunkTokens: 'nope' });
    expect(result).toBeNull();
  });

  it('accepts pipeline config block with all stage flags', () => {
    const result = validateConfigJson({
      pipeline: {
        graphExpansion: false,
        embeddingFusion: false,
        containmentDedup: false,
        diversityFilter: false
      }
    });
    expect(result).not.toBeNull();
    const p = result!.pipeline as Record<string, unknown>;
    expect(p.graphExpansion).toBe(false);
    expect(p.embeddingFusion).toBe(false);
    expect(p.containmentDedup).toBe(false);
    expect(p.diversityFilter).toBe(false);
  });

  it('accepts partial pipeline config block', () => {
    const result = validateConfigJson({ pipeline: { graphExpansion: false } });
    expect(result).not.toBeNull();
    const p = result!.pipeline as Record<string, unknown>;
    expect(p.graphExpansion).toBe(false);
    expect(p.embeddingFusion).toBeUndefined(); // not provided = use default
  });

  it('rejects invalid pipeline flag type', () => {
    const result = validateConfigJson({ pipeline: { graphExpansion: 'yes' } });
    expect(result).toBeNull();
  });

  it('merges pipeline config block with deep merge', () => {
    const target = { pipeline: { graphExpansion: true, diversityFilter: true } };
    const source = { pipeline: { graphExpansion: false } };
    const result = mergeDeep(structuredClone(target), source);
    expect(result.pipeline.graphExpansion).toBe(false);
    expect(result.pipeline.diversityFilter).toBe(true); // untouched
  });
});

describe('loadConfig cache isolation', () => {
  it('keeps repository-specific settings separate within one process', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-config-cache-'));
    const repoA = path.join(parent, 'repo-a');
    const repoB = path.join(parent, 'repo-b');
    fs.mkdirSync(path.join(repoA, '.contextos'), { recursive: true });
    fs.mkdirSync(path.join(repoB, '.contextos'), { recursive: true });
    fs.writeFileSync(
      path.join(repoA, '.contextos', 'config.json'),
      JSON.stringify({ maxChunkTokens: 1111 })
    );
    fs.writeFileSync(
      path.join(repoB, '.contextos', 'config.json'),
      JSON.stringify({ maxChunkTokens: 2222 })
    );

    try {
      expect(loadConfig({ cwd: repoA }).maxChunkTokens).toBe(1111);
      expect(loadConfig({ cwd: repoB }).maxChunkTokens).toBe(2222);
      // A second read of A must not inherit B's repository override.
      expect(loadConfig({ cwd: repoA }).maxChunkTokens).toBe(1111);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });
});
