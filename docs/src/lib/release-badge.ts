export type ReleaseBadge =
  | "Initial Release"
  | "Major Release"
  | "Minor Release"
  | "Patch Release";

const OVERRIDES: Record<string, ReleaseBadge> = {
  "0.8.0": "Major Release",
  "0.7.1": "Minor Release",
  "0.7.0": "Major Release",
  "0.2.0": "Initial Release",
};

export function getReleaseBadge(version: string, isOldest: boolean): ReleaseBadge {
  if (OVERRIDES[version]) return OVERRIDES[version];
  if (isOldest) return "Initial Release";
  return version.endsWith(".0") ? "Minor Release" : "Patch Release";
}
