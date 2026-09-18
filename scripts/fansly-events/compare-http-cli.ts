import { open } from "node:fs/promises";
import { compareHttpSnapshots, parseHttpSnapshot } from "./compare-http.ts";
import { readPrivateFile } from "../fansly-ws/private-file.ts";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const [baselinePath, currentPath, outputPath, ...pages] = process.argv.slice(2);

try {
  if (!baselinePath || !currentPath || !outputPath || pages.length === 0) {
    throw new Error("invalid_comparison_arguments");
  }
  async function snapshot(path: string) {
    const bytes = await readPrivateFile(path, MAX_REPORT_BYTES);
    const manifest = JSON.parse((await readPrivateFile(`${path}.manifest.json`, 16_384)).toString("utf8"));
    return parseHttpSnapshot(bytes, manifest);
  }
  const baseline = await snapshot(baselinePath);
  const current = await snapshot(currentPath);
  const result = compareHttpSnapshots(baseline, current, pages);
  const serialized = JSON.stringify(result, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error("comparison_output_limit");
  const output = await open(outputPath, "wx", 0o600);
  try { await output.writeFile(serialized); }
  finally { await output.close(); }
  process.stdout.write("Wrote HTTP comparison; inspect eligibility and blockers. Savings and latency remain unverified.\n");
} catch {
  process.stderr.write("HTTP comparison failed. Use private report/manifest pairs and a new output path.\n"
    + "Usage: compare-http-cli.ts BASELINE_REPORT CURRENT_REPORT OUTPUT PAGE_LABEL [PAGE_LABEL...]\n");
  process.exitCode = 1;
}
