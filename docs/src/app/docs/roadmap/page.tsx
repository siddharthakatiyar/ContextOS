import { buildMetadata } from "@/lib/seo";
import { RoadmapContent } from "./roadmap-content";

export const metadata = buildMetadata({
  title: "Roadmap",
  description: "The high-level roadmap and future direction of ContextOS following the v1.0 stable release.",
  path: "/docs/roadmap",
});

export default function RoadmapDocs() {
  return <RoadmapContent />;
}
