import { execSync } from "child_process";
import fs from "fs";
import path from "path";

export function generateReport(results, outputDir) {
  const harnessGitSha = execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  const productVersion = packageJson.version;
  const tokenizer = "cl100k_base";
  
  const report = {
    metadata: {
      harnessGitSha,
      productVersion,
      tokenizer,
      timestamp: new Date().toISOString()
    },
    runs: results
  };
  
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  
  const reportPath = path.join(outputDir, `benchmark-v2-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report written to ${reportPath}`);
  
  return report;
}
