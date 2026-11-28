import ctx_review from './registered/ctx-review.js';
import type { WorkspaceToolContext } from './workspace-tools.js';
import type { WorkspaceKnowledgeContext } from './tools/knowledge.js';
import get_context from './registered/get-context.js';
import ctx_read_file from './registered/ctx-read-file.js';
import ctx_expand from './registered/ctx-expand.js';
import ctx_execute from './registered/ctx-execute.js';
import ctx_symbol from './registered/ctx-symbol.js';
import ctx_topics from './registered/ctx-topics.js';
import get_neighbors from './registered/get-neighbors.js';
import get_symbol from './registered/get-symbol.js';
import ctx_list_topics from './registered/ctx-list-topics.js';
import ctx_read_topic from './registered/ctx-read-topic.js';
import save_context from './registered/save-context.js';
import reindex_context from './registered/reindex-context.js';
import contextos_status from './registered/contextos-status.js';
import get_status from './registered/get-status.js';
import ctx_scope from './registered/ctx-scope.js';
import ctx_link from './registered/ctx-link.js';
import ctx_links from './registered/ctx-links.js';
import ctx_impact from './registered/ctx-impact.js';
import ctx_trace from './registered/ctx-trace.js';
import ctx_resolve_import from './registered/ctx-resolve-import.js';
import ctx_contract from './registered/ctx-contract.js';
import ctx_unlink from './registered/ctx-unlink.js';
import ctx_remember from './registered/ctx-remember.js';
import ctx_forget from './registered/ctx-forget.js';
import learn_fact from './registered/learn-fact.js';
import forget_fact from './registered/forget-fact.js';
import rate_chunk from './registered/rate-chunk.js';
import contextos_update_status from './registered/contextos-update-status.js';

type Entry =
  | { name: string; kind: 'workspace'; register: (context: WorkspaceToolContext) => void }
  | { name: string; kind: 'knowledge'; register: (context: WorkspaceKnowledgeContext) => void };
/** Add a tool module and one entry here. Both serving and catalog generation use this list. */
export const workspaceToolRegistry: readonly Entry[] = [
  { name: 'ctx_review', kind: 'knowledge', register: ctx_review },
  { name: 'get_context', kind: 'workspace', register: get_context },
  { name: 'ctx_read_file', kind: 'workspace', register: ctx_read_file },
  { name: 'ctx_expand', kind: 'workspace', register: ctx_expand },
  { name: 'ctx_execute', kind: 'workspace', register: ctx_execute },
  { name: 'ctx_symbol', kind: 'workspace', register: ctx_symbol },
  { name: 'ctx_topics', kind: 'workspace', register: ctx_topics },
  { name: 'get_neighbors', kind: 'workspace', register: get_neighbors },
  { name: 'get_symbol', kind: 'workspace', register: get_symbol },
  { name: 'ctx_list_topics', kind: 'workspace', register: ctx_list_topics },
  { name: 'ctx_read_topic', kind: 'workspace', register: ctx_read_topic },
  { name: 'save_context', kind: 'workspace', register: save_context },
  { name: 'reindex_context', kind: 'workspace', register: reindex_context },
  { name: 'contextos_status', kind: 'workspace', register: contextos_status },
  { name: 'get_status', kind: 'workspace', register: get_status },
  { name: 'ctx_scope', kind: 'knowledge', register: ctx_scope },
  { name: 'ctx_link', kind: 'knowledge', register: ctx_link },
  { name: 'ctx_links', kind: 'knowledge', register: ctx_links },
  { name: 'ctx_impact', kind: 'workspace', register: ctx_impact },
  { name: 'ctx_trace', kind: 'knowledge', register: ctx_trace },
  { name: 'ctx_resolve_import', kind: 'knowledge', register: ctx_resolve_import },
  { name: 'ctx_contract', kind: 'knowledge', register: ctx_contract },
  { name: 'ctx_unlink', kind: 'knowledge', register: ctx_unlink },
  { name: 'ctx_remember', kind: 'knowledge', register: ctx_remember },
  { name: 'ctx_forget', kind: 'knowledge', register: ctx_forget },
  { name: 'learn_fact', kind: 'workspace', register: learn_fact },
  { name: 'forget_fact', kind: 'workspace', register: forget_fact },
  { name: 'rate_chunk', kind: 'workspace', register: rate_chunk },
  { name: 'contextos_update_status', kind: 'workspace', register: contextos_update_status }
];
