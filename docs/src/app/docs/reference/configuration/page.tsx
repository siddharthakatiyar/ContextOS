import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Configuration",
  description: "Configuring the ContextOS retrieval engine via .contextos/config.json.",
  path: "/docs/reference/configuration",
});

export default function ConfigurationDocs() {
  return (
    <DocPage
      title="Configuration"
      description="Configuring the ContextOS retrieval engine via .contextos/config.json."
      prev={{ title: "CLI Commands", href: "/docs/reference/cli" }}
      next={{ title: "Architecture", href: "/docs/architecture" }}
    >
      <SourceLink path="src/config/defaults.ts" />

      <h2>The config file</h2>
      <p>
        ContextOS works out of the box with zero configuration. To fine-tune the
        engine, add a <code>.contextos/config.json</code> file in your repository, or a
        global <code>~/.contextos/config.json</code>. Repo config overrides global,
        which overrides the built-in defaults in <code>src/config/defaults.ts</code>.
      </p>

      <pre>
        <code className="language-json">
{`{
  "ignorePatterns": ["**/tests/fixtures/**", "**/*.generated.ts"],
  "maxTokenBudget": 1200,
  "maxRetrievalResults": 25,
  "graphExpansionDepth": 2,
  "graphExpansionMaxNodes": 20,
  "embeddingsEnabled": true,
  "embeddingsRetrieval": false,
  "pipeline": {
    "graphExpansion": true,
    "containmentDedup": true,
    "diversityFilter": true
  }
}`}
        </code>
      </pre>

      <h2>Configuration options</h2>

      <h3><code>ignorePatterns</code></h3>
      <p>
        Glob patterns for files/directories to skip during indexing. Noisy
        directories (<code>node_modules</code>, <code>.git</code>, <code>dist</code>,{" "}
        <code>__pycache__</code>, …) are always excluded, so use this only for
        repo-specific noise. Use an <code>ignorePatterns!</code> key (trailing{" "}
        <code>!</code>) to replace the defaults instead of merging.
      </p>

      <h3>Token &amp; retrieval budgets</h3>
      <ul>
        <li><code>maxTokenBudget</code> (number): default compile budget. Default <code>1200</code>; a per-call <code>get_context</code> <code>max_tokens</code> accepts up to <code>8000</code>.</li>
        <li><code>maxRetrievalResults</code> (number): cap on scored chunks before compile. Default <code>25</code>.</li>
        <li><code>ftsLimit</code> (number): per-query FTS5 hit limit. Default <code>15</code>.</li>
        <li><code>maxChunkTokens</code> / <code>maxSymbolChunkTokens</code> (number): soft caps when creating chunks. Defaults <code>1500</code> / <code>900</code>.</li>
      </ul>

      <h3>Graph expansion</h3>
      <ul>
        <li><code>graphExpansionDepth</code> (number): relationship walk depth. Default <code>2</code>.</li>
        <li><code>graphExpansionMaxNodes</code> (number): cap on expanded entities. Default <code>20</code>.</li>
      </ul>

      <h3>Embeddings</h3>
      <p>
        ContextOS uses a local MiniLM model (<code>@xenova/transformers</code>) — there
        is no external/OpenAI provider and no API key.
      </p>
      <ul>
        <li><code>embeddingsEnabled</code> (boolean): generate index-time embeddings. Default <code>true</code>.</li>
        <li><code>embeddingsRetrieval</code> (boolean): fuse embedding kNN into query-time retrieval. Default <code>false</code> — the keyword/RRF path is the accuracy baseline; embeddings act as a confidence-gated fallback.</li>
      </ul>

      <h3><code>pipeline</code></h3>
      <p>Toggle individual query-time stages.</p>
      <ul>
        <li><code>graphExpansion</code> (boolean, default <code>true</code>)</li>
        <li><code>embeddingFusion</code> (boolean): when unset, follows <code>embeddingsRetrieval</code>; set <code>true</code>/<code>false</code> to force.</li>
        <li><code>containmentDedup</code> (boolean, default <code>true</code>)</li>
        <li><code>diversityFilter</code> (boolean, default <code>true</code>)</li>
      </ul>

      <h3><code>execAllowRepoScripts</code></h3>
      <p>
        Whether the <code>ctx_execute</code> tool may run the indexed repository&apos;s own
        scripts (<code>npm test</code>, <code>npm run build|lint</code>,{" "}
        <code>npx vitest|jest</code>). Default <code>true</code>. Set to <code>false</code>{" "}
        (or export <code>CONTEXTOS_EXEC_ALLOW_SCRIPTS=0</code>) when indexing untrusted
        repositories, since those scripts execute repo-controlled code.
      </p>

      <h2>Environment variables</h2>
      <ul>
        <li><code>CONTEXTOS_EMBEDDINGS=0</code>: disable index-time embeddings.</li>
        <li><code>CONTEXTOS_EMBEDDINGS_RETRIEVAL=1</code>: enable embedding fusion at query time.</li>
        <li><code>CONTEXTOS_EXEC_ALLOW_SCRIPTS=0</code>: disable <code>ctx_execute</code> script execution.</li>
        <li><code>CONTEXTOS_REPO_ROOT</code>: the repository root the MCP server operates on.</li>
        <li><code>CONTEXTOS_WORKSPACE</code>: workspace name for multi-project isolation.</li>
      </ul>
    </DocPage>
  );
}
