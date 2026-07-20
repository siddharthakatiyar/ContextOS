import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Configuration",
  description: "Configuring the ContextOS retrieval engine via contextos.json.",
  path: "/docs/reference/configuration",
});

export default function ConfigurationDocs() {
  return (
    <DocPage
      title="Configuration"
      description="Configuring the ContextOS retrieval engine via contextos.json."
      prev={{ title: "CLI Commands", href: "/docs/reference/cli" }}
      next={{ title: "Architecture", href: "/docs/architecture" }}
    >
      <SourceLink path="src/core/parser/config-parser.ts" />

      <h2>The <code>contextos.json</code> File</h2>
      <p>
        ContextOS is designed to work out of the box with zero configuration. However, if you need to fine-tune the engine's behavior, you can create a <code>contextos.json</code> file in the root of your repository (next to your <code>package.json</code> or <code>.git</code> folder).
      </p>

      <pre>
        <code className="language-json">
{`{
  "ignorePatterns": [
    "**/tests/fixtures/**",
    "**/*.generated.ts"
  ],
  "retrieval": {
    "maxDepth": 3,
    "maxNodes": 40
  },
  "embeddings": {
    "enabled": true,
    "provider": "openai",
    "model": "text-embedding-3-small"
  }
}`}
        </code>
      </pre>

      <h2>Configuration Options</h2>

      <h3><code>ignorePatterns</code></h3>
      <p>
        An array of glob patterns specifying files and directories that should be skipped during the <code>init</code> and <code>watch</code> indexing phases. 
      </p>
      <p className="text-sm text-neutral-400">
        <strong>Note:</strong> ContextOS inherently ignores standard noisy directories via a hardcoded <code>SAFETY_IGNORE</code> list (e.g., <code>node_modules</code>, <code>.git</code>, <code>dist</code>, <code>__pycache__</code>). You do not need to specify these. <code>ignorePatterns</code> is strictly for repository-specific noise (like generated API clients or large mock data files).
      </p>

      <h3><code>retrieval</code></h3>
      <p>
        Overrides the default parameters for the Graph Expansion and Context Compilation engines.
      </p>
      <ul>
        <li><code>maxDepth</code> (number): How deep the Breadth-First Search will traverse dependency edges. Default is <code>2</code>.</li>
        <li><code>maxNodes</code> (number): The absolute upper limit on the number of entities pulled into the LLM context window. Default is <code>20</code>.</li>
      </ul>

      <h3><code>embeddings</code></h3>
      <p>
        Configures the semantic vector generation layer. 
      </p>
      <ul>
        <li><code>enabled</code> (boolean): Set to <code>false</code> to completely disable embeddings and rely 100% on the BM25 (FTS5) engine. This drastically speeds up initial indexing.</li>
        <li><code>provider</code> (string): The inference provider. Supported values: <code>openai</code>, <code>local</code> (ONNX), <code>ollama</code>.</li>
        <li><code>model</code> (string): The specific model string to use for the specified provider.</li>
      </ul>

      <h2>Environment Variables</h2>
      <p>
        For secure values like API keys, ContextOS reads from your environment variables or a local <code>.env</code> file.
      </p>
      <ul>
        <li><code>OPENAI_API_KEY</code>: Required if using the OpenAI embeddings provider.</li>
        <li><code>CONTEXTOS_HOME</code>: Overrides the global storage directory (defaults to <code>~/.contextos</code>).</li>
      </ul>

    </DocPage>
  );
}
