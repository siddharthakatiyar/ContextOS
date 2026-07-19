import fs from "fs";
import path from "path";
import { generateReport } from "./lib/report.mjs";

console.log("Starting Benchmark v2");
// In a real run, this would import all flows and topics and run them.
// Currently acts as a stub to validate the structure.
generateReport([], path.join(process.cwd(), "scripts/results"));
console.log("Done.");
