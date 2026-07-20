import fs from "fs";
import path from "path";

export interface ChangelogBullet {
  raw: string;
  lead: string | null;
  rest: string;
  breaking: boolean;
}

export interface ChangelogSection {
  heading: string;
  bullets: ChangelogBullet[];
}

export interface ChangelogEntry {
  version: string;
  slug: string;
  date: string;
  summary: string | null;
  sections: ChangelogSection[];
  hasBreakingChange: boolean;
}

const VERSION_HEADING_RE = /^## \[(\d+\.\d+\.\d+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
const SECTION_HEADING_RE = /^### (.+)$/;
const BULLET_RE = /^- (.+)$/;
const LEAD_RE = /^\*\*(.+?)\*\*:\s*(.*)$/;

function parseBullet(text: string): ChangelogBullet {
  const match = LEAD_RE.exec(text);
  return {
    raw: text,
    lead: match ? match[1] : null,
    rest: match ? match[2] : text,
    breaking: /breaking change/i.test(text),
  };
}

let cache: ChangelogEntry[] | null = null;

export function getChangelog(): ChangelogEntry[] {
  if (cache) return cache;

  const changelogPath = path.join(process.cwd(), "..", "CHANGELOG.md");
  const raw = fs.readFileSync(changelogPath, "utf-8");
  const lines = raw.split("\n");

  const entries: ChangelogEntry[] = [];
  let current: ChangelogEntry | null = null;
  let currentSection: ChangelogSection | null = null;
  let summaryLines: string[] = [];
  let sawSection = false;

  const flushSummary = () => {
    if (current && !sawSection) {
      const summary = summaryLines.join(" ").trim();
      current.summary = summary.length > 0 ? summary : null;
    }
  };

  for (const line of lines) {
    const versionMatch = VERSION_HEADING_RE.exec(line);
    if (versionMatch) {
      flushSummary();
      const [, version, date] = versionMatch;
      current = {
        version,
        slug: `v${version}`,
        date,
        summary: null,
        sections: [],
        hasBreakingChange: false,
      };
      entries.push(current);
      currentSection = null;
      summaryLines = [];
      sawSection = false;
      continue;
    }

    if (!current) continue;

    const sectionMatch = SECTION_HEADING_RE.exec(line);
    if (sectionMatch) {
      sawSection = true;
      currentSection = { heading: sectionMatch[1].trim(), bullets: [] };
      current.sections.push(currentSection);
      continue;
    }

    const bulletMatch = BULLET_RE.exec(line);
    if (bulletMatch && currentSection) {
      const bullet = parseBullet(bulletMatch[1].trim());
      currentSection.bullets.push(bullet);
      if (bullet.breaking) current.hasBreakingChange = true;
      continue;
    }

    if (!sawSection && line.trim().length > 0) {
      summaryLines.push(line.trim());
    }
  }
  flushSummary();

  cache = entries;
  return entries;
}

export function getChangelogEntry(slug: string): ChangelogEntry | undefined {
  return getChangelog().find((entry) => entry.slug === slug);
}

export function formatReleaseDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
