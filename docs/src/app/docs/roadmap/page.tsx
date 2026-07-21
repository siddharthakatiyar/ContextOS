import { buildMetadata } from "@/lib/seo";
import { RoadmapContent } from "./roadmap-content";

export const metadata = buildMetadata({
  title: "Roadmap",
  description: "The high-level roadmap and future ambitions for ContextOS as we approach v1.0 and beyond.",
  path: "/docs/roadmap",
});

export default function RoadmapDocs() {
  return <RoadmapContent />;
}
