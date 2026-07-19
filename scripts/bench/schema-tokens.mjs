import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { tok } from "./lib/tokens.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");
const TOOLS_DIR = path.join(ROOT, "src/mcp/tools");

const tools = ["get-context.ts"]; // and others if needed
let totalTokens = 0;

for (const t of tools) {
  const p = path.join(TOOLS_DIR, t);
  if (fs.existsSync(p)) {
    const text = fs.readFileSync(p, "utf8");
    const m = text.match(/description:\s*['"`]([\s\S]*?)['"`]/);
    if (m) {
      totalTokens += tok(m[1]);
    }
  }
}

console.log(`MCP Schema Surface Tokens: ${totalTokens}`);
