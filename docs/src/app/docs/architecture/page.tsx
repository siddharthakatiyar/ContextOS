import { buildMetadata } from "@/lib/seo";
import { ArchitectureContent } from "./architecture-content";

export const metadata = buildMetadata({
  title: "Architecture Overview",
  description: "The end-to-end pipeline of ContextOS, from raw source files to compressed LLM prompts.",
  path: "/docs/architecture",
});

export default function ArchitectureDocs() {
  return <ArchitectureContent />;
}
