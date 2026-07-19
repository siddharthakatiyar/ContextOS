import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const { estimateTokens } = await import(path.join(ROOT, "dist/src/utils/tokens.js"));

export function tok(text) {
  return estimateTokens(text || "");
}
