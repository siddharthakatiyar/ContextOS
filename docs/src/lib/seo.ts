import type { Metadata } from "next";

export const SITE_URL = "https://contextos.siddhartha.work";
export const SITE_NAME = "ContextOS";
export const SITE_DESCRIPTION =
  "An intelligent retrieval engine that transforms entire codebases into surgical context packages for LLMs.";

interface BuildMetadataOptions {
  title: string;
  description: string;
  path: string;
}

export function buildMetadata({ title, description, path }: BuildMetadataOptions): Metadata {
  const url = path === "/" ? SITE_URL : `${SITE_URL}${path}`;

  return {
    title,
    description,
    alternates: {
      canonical: url,
    },
    openGraph: {
      title,
      description,
      url,
      siteName: SITE_NAME,
      type: "website",
      locale: "en_US",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}
