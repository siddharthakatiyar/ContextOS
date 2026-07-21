import { buildMetadata } from "@/lib/seo";
import { BenchmarksContent } from "./benchmarks-content";

export const metadata = buildMetadata({
  title: "Benchmarks & Performance",
  description: "Performance metrics, latency, and context compression benchmarks for ContextOS.",
  path: "/docs/benchmarks",
});

export default function BenchmarksDocs() {
  return <BenchmarksContent />;
}
