import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/seo";
import { getChangelog } from "@/lib/changelog";

export const dynamic = "force-static";

const STATIC_ROUTES: Array<{ path: string; changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"]; priority: number }> = [
  { path: "/", changeFrequency: "weekly", priority: 1 },
  { path: "/docs", changeFrequency: "monthly", priority: 0.9 },
  { path: "/docs/design-decisions", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/architecture", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/initialization", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/troubleshooting", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/examples", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/reference/cli", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/reference/configuration", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/database/schema", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/algorithms/retrieval-pipeline", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/algorithms/graph-expansion", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/algorithms/ranking", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/algorithms/compression", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/benchmarks", changeFrequency: "monthly", priority: 0.7 },
  { path: "/docs/roadmap", changeFrequency: "monthly", priority: 0.6 },
  { path: "/docs/stability", changeFrequency: "monthly", priority: 0.6 },
  { path: "/releases", changeFrequency: "weekly", priority: 0.8 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const staticEntries: MetadataRoute.Sitemap = STATIC_ROUTES.map((route) => ({
    url: `${SITE_URL}${route.path}`,
    changeFrequency: route.changeFrequency,
    priority: route.priority,
  }));

  const releaseEntries: MetadataRoute.Sitemap = getChangelog().map((entry) => ({
    url: `${SITE_URL}/releases/${entry.slug}`,
    lastModified: entry.date,
    changeFrequency: "monthly",
    priority: 0.5,
  }));

  return [...staticEntries, ...releaseEntries];
}
