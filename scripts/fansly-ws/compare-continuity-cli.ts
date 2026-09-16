import { open } from "node:fs/promises";
import { compareContinuityObservation } from "./compare-continuity.ts";
import { readPrivateFile } from "./private-file.ts";

const args = process.argv.slice(2);
try {
  if (args.length !== 4 || args.some(arg => arg.startsWith("-"))) {
    throw new Error("invalid_comparison_arguments");
  }
  const browser = JSON.parse((await readPrivateFile(args[0]!, 32 * 1024 * 1024)).toString("utf8"));
  const windows = JSON.parse((await readPrivateFile(args[2]!, 4096)).toString("utf8"));
  const report = await compareContinuityObservation(browser, args[1]!, windows);
  const serialized = JSON.stringify(report, null, 2) + "\n";
  if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new Error("comparison_output_limit");
  const output = await open(args[3]!, "wx", 0o600);
  try { await output.writeFile(serialized); }
  finally { await output.close(); }
  process.stdout.write("Wrote continuity reference comparison; live gates remain unverified.\n");
} catch {
  process.stderr.write("Continuity comparison failed; check private inputs, a complete phase, matching keys and a new output path.\n");
  process.exitCode = 1;
}
