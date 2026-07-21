import { Metadata } from "next";
import { buildMetadata } from "@/lib/seo";
export const metadata: Metadata = buildMetadata({
  title: "API Stability & SemVer",
  description: "ContextOS versioning, stability guarantees, and deprecation policy for v1.0 and beyond.",
  path: "/docs/stability",
});

export default function StabilityPage() {
  return (
    <div className="flex flex-col gap-12">
      <header className="flex flex-col gap-4">
        <h1 className="text-4xl font-bold tracking-tight">API Stability & Versioning</h1>
        <p className="text-xl text-neutral-400 font-mono">
          Guarantees for the CLI, MCP, and Configuration.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold tracking-tight border-b border-neutral-900 pb-2">Semantic Versioning (SemVer)</h2>
        <div className="prose prose-invert prose-neutral max-w-none">
          <p>
            ContextOS adheres strictly to <a href="https://semver.org/" target="_blank" rel="noreferrer">Semantic Versioning</a>. 
            Starting from <code>v1.0.0</code>, version numbers dictate the nature of changes:
          </p>
          <ul>
            <li><strong>MAJOR (<code>v2.0.0</code>):</strong> Incompatible, breaking changes (e.g., removing deprecated CLI flags, breaking MCP tool signatures).</li>
            <li><strong>MINOR (<code>v1.1.0</code>):</strong> Backwards-compatible new features (e.g., adding a new LLM provider, introducing new configuration keys).</li>
            <li><strong>PATCH (<code>v1.0.1</code>):</strong> Backwards-compatible bug fixes, performance improvements, and security patches.</li>
          </ul>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold tracking-tight border-b border-neutral-900 pb-2">Stability Guarantees</h2>
        <div className="prose prose-invert prose-neutral max-w-none">
          <p>The following surfaces are considered the <strong>Public API</strong> of ContextOS and are protected by our SemVer guarantees in all <code>v1.x</code> releases:</p>
          
          <h3>1. CLI Commands</h3>
          <p>
            Commands (<code>init</code>, <code>serve</code>, <code>query</code>, etc.) and their primary flags will not be removed or functionally altered in a breaking way.
          </p>

          <h3>2. MCP Tool Interface</h3>
          <p>
            The names, arguments, and general return structures of the official MCP tools (<code>get_context</code>, <code>reindex_context</code>, etc.) are stable. Tools will not be removed, and required parameters will not be added to existing tools without a major version bump.
          </p>

          <h3>3. Configuration File</h3>
          <p>
            Keys defined in the official configuration schema will not be removed or have their types changed. We publish a JSON schema for validating your <code>.contextosrc</code>.
          </p>
          <pre className="bg-neutral-900 border border-neutral-800 p-4 rounded-lg overflow-x-auto text-sm mt-4">
            <code className="text-neutral-300">
{`// In your .contextosrc
{
  "$schema": "https://raw.githubusercontent.com/siddharthakatiyar/ContextOS/main/config.schema.json",
  "maxTokenBudget": 2000
}`}
            </code>
          </pre>
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-2xl font-bold tracking-tight border-b border-neutral-900 pb-2">Deprecation Policy</h2>
        <div className="prose prose-invert prose-neutral max-w-none">
          <p>
            When we need to retire a feature, we follow a strict deprecation lifecycle:
          </p>
          <ol>
            <li><strong>Announcement:</strong> The deprecation is announced in a MINOR release. A warning will be logged to the console/daemon when the deprecated feature is used.</li>
            <li><strong>Grace Period:</strong> The feature will remain fully functional for at least <strong>6 months</strong> or until the next MAJOR release (whichever is longer).</li>
            <li><strong>Removal:</strong> The feature is completely removed in a MAJOR release.</li>
          </ol>
        </div>
      </section>
    </div>
  );
}
