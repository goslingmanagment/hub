import { open } from "node:fs/promises";
import { compareDiagnosticReports } from "./compare.ts";
import { readPrivateFile } from "./private-file.ts";

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const args = process.argv.slice(2);
try {
  if (args.length !== 4 || args.some((arg) => arg.startsWith("-"))) {
    throw new Error("invalid_comparison_arguments");
  }
  const left = JSON.parse((await readPrivateFile(args[0]!, MAX_REPORT_BYTES)).toString("utf8"));
  const right = JSON.parse((await readPrivateFile(args[1]!, MAX_REPORT_BYTES)).toString("utf8"));
  const windows = JSON.parse((await readPrivateFile(args[2]!, 4096)).toString("utf8"));
  const report = compareDiagnosticReports(left, right, windows);
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > MAX_REPORT_BYTES) throw new Error("comparison_output_limit");
  const output = await open(args[3]!, "wx", 0o600);
  try { await output.writeFile(serialized); }
  finally { await output.close(); }
  process.stdout.write("Wrote reference comparison; live gates remain unverified.\n");
} catch {
  process.stderr.write("Comparison failed; check private reports, matching keys, overlapping windows and a new output path.\n");
  process.exitCode = 1;
}
