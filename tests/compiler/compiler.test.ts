import { describe, it, expect, vi } from 'vitest';
import * as configModule from '../../src/config/index.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { compile } from '../../src/core/compiler/index.js';
import { RetrievalResult, ScoredChunk } from '../../src/core/retrieval/types.js';

function makeChunk(id: string, content: string, score: number): ScoredChunk {
  return {
    id,
    sourceFile: 'test.ts',
    content,
    score,
    tokenCount: content.length / 4,
    startLine: 1,
    endLine: 10,
    symbolName: 'foo',
    layer: 'repo',
    language: 'typescript',
    workspaceName: null,
    sectionTitle: null,
    sectionDepth: 0,
    summary: null,
    keywords: null,
    hash: id,
    importance: 1,
    createdAt: 1,
    updatedAt: 1
  };
}

const intent: RetrievalResult['intent'] = {
  concepts: [],
  identifiers: [],
  quotedTerms: [],
  intentType: 'general',
  rawPrompt: ''
};

describe('Compiler', () => {
  it('compiles full bodies when within token budget', () => {
    const chunk1 = makeChunk('1', 'console.log("hello");', 10);
    const chunk2 = makeChunk('2', 'const a = 1;', 5);

    const result: RetrievalResult = {
      chunks: [chunk1, chunk2],
      expandedEntities: [],
      intent,
      latencyMs: 10
    };

    const compiled = compile(result, { maxTokens: 1000 });

    expect(compiled.output).toContain('console.log("hello");');
    expect(compiled.output).toContain('const a = 1;');
  });

  it('downgrades chunks to stubs when outside token budget', () => {
    const chunk1Text = 'word '.repeat(300);
    const chunk2Text = 'other '.repeat(300);

    const chunk1 = makeChunk('1', chunk1Text, 10);
    const chunk2 = makeChunk('2', chunk2Text, 5);
    chunk2.sourceFile = 'other.ts';

    const result: RetrievalResult = {
      chunks: [chunk1, chunk2],
      expandedEntities: [],
      intent,
      latencyMs: 10
    };

    const compiled = compile(result, { maxTokens: 600 });

    expect(compiled.output).toContain(chunk1Text.slice(0, 100)); // Make sure chunk 1 is present
    expect(compiled.output).not.toContain(chunk2Text); // Make sure chunk 2 was stubbed/truncated out
    expect(compiled.output).toContain('### Also');
  });

  it('renders XML when requested', () => {
    const result: RetrievalResult = {
      chunks: [makeChunk('xml-1', 'export const xmlValue = true;', 10)],
      expandedEntities: [],
      intent,
      latencyMs: 2
    };

    const compiled = compile(result, { maxTokens: 1000, outputFormat: 'xml' });

    expect(compiled.output).toContain('<contextos_context>');
    expect(compiled.output).toContain('<chunk id="xml-1"');
    expect(compiled.output).toContain('<![CDATA[');
    expect(compiled.output).toContain('</contextos_context>');
  });

  it('uses configured framing reserve and preserves explicit caller overrides', () => {
    const config = vi.spyOn(configModule, 'loadConfig').mockReturnValue({
      ...structuredClone(defaultConfig),
      framingReserve: 123
    });
    try {
      const result: RetrievalResult = {
        chunks: [makeChunk('framing', 'export const framing = true;', 10)],
        expandedEntities: [],
        intent,
        latencyMs: 1
      };
      expect(compile(result, { maxTokens: 1000, explain: true }).diagnostics).toMatchObject({
        framingReserve: 123,
        firstPassChunkBudget: 877
      });
      expect(
        compile(result, { maxTokens: 1000, framingReserve: 17, explain: true }).diagnostics
      ).toMatchObject({ framingReserve: 17, firstPassChunkBudget: 983 });
    } finally {
      config.mockRestore();
    }
  });

  it.each([100, 400, 1200, 4000])(
    'includes repository citation framing in the %i-token Markdown limit',
    (budget) => {
      const chunks = Array.from({ length: 8 }, (_, index) => ({
        ...makeChunk(
          `budget-${index}`,
          'export const request = "rate limit";\n'.repeat(140),
          20 - index
        ),
        sourceFile: `service-${index}/internal/handler/requests.ts`,
        repoName: `throttlex-service-${index}`,
        relativePath: 'internal/handler/requests.ts',
        projectId: `project-${index}`,
        worktreeId: `worktree-${index}`,
        branch: 'feature/long-citation-budget',
        viewId: `view-${index}`
      }));
      const result: RetrievalResult = { chunks, expandedEntities: [], intent, latencyMs: 1 };
      const ordinary = compile(result, { maxTokens: budget, maxExactTokens: budget });
      const explained = compile(result, {
        maxTokens: budget,
        maxExactTokens: budget,
        explain: true
      });
      expect(ordinary.tokenCount).toBeLessThanOrEqual(budget);
      expect(explained.tokenCount).toBeLessThanOrEqual(budget);
      expect((ordinary.output.match(/^```/gm) ?? []).length % 2).toBe(0);
      for (const item of explained.diagnostics?.includedChunks ?? []) {
        const chunk = chunks.find((chunk) => chunk.id === item.id)!;
        expect(explained.output).toContain(chunk.repoName);
      }
    }
  );

  it('keeps XML output within a strict budget by dropping whole elements', () => {
    const result: RetrievalResult = {
      chunks: Array.from({ length: 100 }, (_, index) =>
        makeChunk(`xml-${index}`, `export const value${index} = ${index};`, 100 - index)
      ),
      expandedEntities: [],
      intent,
      latencyMs: 2
    };

    const compiled = compile(result, { maxTokens: 400, outputFormat: 'xml' });

    expect(compiled.tokenCount).toBeLessThanOrEqual(400);
    expect(compiled.output).toMatch(/^<contextos_context>[\s\S]*<\/contextos_context>\n$/);
  });

  it('reports the effective token budget and chunks actually compiled only when requested', () => {
    const result: RetrievalResult = {
      chunks: [makeChunk('inspected', 'export const inspected = true;', 10)],
      expandedEntities: [],
      intent,
      latencyMs: 2
    };

    const ordinary = compile(result, { maxTokens: 900 });
    const inspected = compile(result, { maxTokens: 900, explain: true });

    expect(ordinary.diagnostics).toBeUndefined();
    expect(inspected.diagnostics).toMatchObject({
      tier: 'explore',
      outputFormat: 'markdown',
      configuredMaxTokens: 900,
      effectiveMaxTokens: 900,
      firstPassChunkBudget: 852,
      framingReserve: 48,
      includedChunks: [{ id: 'inspected', representation: 'body' }],
      omittedChunkIds: []
    });
  });

  it('keeps generated stub provenance when trimming an earlier source heading', () => {
    const first = makeChunk(
      'source-heading',
      `### Also\n${'const first = true;\n'.repeat(160)}\n### More\n${'const later = true;\n'.repeat(2)}`,
      10
    );
    first.sourceFile = 'first.ts';
    const second = makeChunk('trimmed-stub', 'const second = true;\n'.repeat(200), 9);
    second.sourceFile = 'second.ts';
    const result: RetrievalResult = {
      chunks: [first, second],
      expandedEntities: [],
      intent,
      latencyMs: 2
    };

    const compiled = compile(result, { maxTokens: 330, explain: true });

    expect(compiled.output).toContain('### More');
    expect(compiled.output).toContain('second.ts:1-10');
    expect(compiled.diagnostics?.includedChunks).toContainEqual({
      id: 'trimmed-stub',
      representation: 'stub'
    });
    expect(compiled.diagnostics?.omittedChunkIds).not.toContain('trimmed-stub');
  });
});
