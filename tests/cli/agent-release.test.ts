import path from 'node:path';
import { describe, expect, it } from 'vitest';

const harness = await import(path.resolve('scripts/agent-release-test.mjs'));
const source = 'contextos:api:chunk:1234';
const target = 'contextos:store:chunk:5678';
const link = { id: 'verified-link-id', source, target, type: 'imports' };
function call(id: string, phase: string, tool: string, args: object = {}) {
  return { kind: 'mcp_call', id, client: 'codex', phase, tool, args, at: 10 };
}
function reply(id: string, phase: string, tool: string, structured: unknown, isError = false) {
  return {
    kind: 'mcp_result',
    id,
    client: 'codex',
    phase,
    tool,
    structured,
    text: JSON.stringify(structured),
    isError,
    at: 11
  };
}
function initial() {
  return [
    call('1', 'initial', 'get_context'),
    reply('1', 'initial', 'get_context', {
      chunks: [
        { ref: source, relativePath: 'src/handlers.ts' },
        { ref: target, relativePath: 'src/captures.ts' }
      ]
    }),
    call('2', 'initial', 'ctx_link', { group: 'fixture', relationship: 'imports', source, target }),
    reply('2', 'initial', 'ctx_link', link)
  ];
}
describe('fresh-session release evidence', () => {
  it('never treats empty transcripts or a rejected retrieval as success', () => {
    expect(harness.evaluateProtocol({})).toMatchObject({
      retrievalBeforeBroadSearch: false,
      correctLinkSaved: false,
      reusedInNewSession: false,
      evidenceInvalidationChecked: false
    });
    expect(
      harness.evaluateProtocol({
        mcpEvents: [
          call('1', 'initial', 'get_context'),
          reply('1', 'initial', 'get_context', {}, true)
        ]
      }).retrievalBeforeBroadSearch
    ).toBe(false);
  });
  it('uses opaque endpoint references and successful responses to verify saving and reuse', () => {
    const events = [
      ...initial(),
      call('3', 'reuse', 'ctx_links', { group: 'fixture' }),
      reply('3', 'reuse', 'ctx_links', { links: [link] })
    ];
    expect(harness.evaluateProtocol({ mcpEvents: events })).toMatchObject({
      correctLinkSaved: true,
      reusedInNewSession: true,
      evidenceInvalidationChecked: false,
      savedLinkId: link.id
    });
    events[events.length - 1] = reply('3', 'reuse', 'ctx_links', { links: [] });
    expect(harness.evaluateProtocol({ mcpEvents: events }).reusedInNewSession).toBe(false);
  });
  it('requires an empty link response in the correct scope after invalidation', () => {
    const events = [
      ...initial(),
      call('3', 'invalidation', 'ctx_links'),
      reply('3', 'invalidation', 'ctx_links', { links: [] })
    ];
    expect(harness.evaluateProtocol({ mcpEvents: events }).evidenceInvalidationChecked).toBe(false);
    events[events.length - 2] = call('3', 'invalidation', 'ctx_links', { group: 'fixture' });
    expect(harness.evaluateProtocol({ mcpEvents: events }).evidenceInvalidationChecked).toBe(true);
    events[events.length - 1] = reply('3', 'invalidation', 'ctx_links', { links: [link] });
    expect(harness.evaluateProtocol({ mcpEvents: events }).evidenceInvalidationChecked).toBe(false);
  });
  it('rejects cross-client response IDs and observes broad searches before completed retrieval', () => {
    const events = initial();
    events[3] = { ...events[3], client: 'claude' };
    expect(harness.evaluateProtocol({ mcpEvents: events }).correctLinkSaved).toBe(false);
    expect(
      harness.evaluateProtocol({
        mcpEvents: initial(),
        agentEvents: [{ phase: 'initial', actionKind: 'command', command: 'rg --files', at: 5 }]
      }).retrievalBeforeBroadSearch
    ).toBe(false);
  });
  it('classifies native policy and quota errors without relying on an agent claim', () => {
    const denied = JSON.stringify({
      item: {
        type: 'mcp_tool_call',
        error: { message: 'MCP tool call requires approval, but approval policy is never' }
      }
    });
    expect(harness.classifyBlockedSession(denied)).toContain('approval policy');
    expect(
      harness.classifyBlockedSession(
        JSON.stringify({ type: 'error', message: 'Usage limit reached' })
      )
    ).toContain('usage');
    expect(
      harness.classifyBlockedSession(
        JSON.stringify({ type: 'agent_message', text: 'I am blocked' })
      )
    ).toBeNull();
  });
});
