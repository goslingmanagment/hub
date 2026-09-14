import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { correlationKeyFingerprint, readCorrelationKey } from "./correlation-key.ts";
import { diagnoseReceivedRecord } from "./diagnostic.ts";
import { readPrivateFile } from "./private-file.ts";

const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_LINES = 10000;

export async function writeDiagnosticReport(inputPath: string, keyPath: string, outputPath: string) {
  const key = await readCorrelationKey(keyPath);
  const input = await readPrivateFile(inputPath, MAX_INPUT_BYTES);
  const text = input.toString("utf8");
  const header = {
    schemaVersion: 1,
    evidenceKind: "offline_diagnostic",
    generatedAt: new Date().toISOString(),
    scope: "received_frame_metadata_only",
    accountBinding: "unverified",
    correlationKeyFingerprint: correlationKeyFingerprint(key),
  };
  const prefix = `${JSON.stringify(header, null, 2).slice(0, -2)},\n  "records": [\n`;
  const suffix = "\n  ]\n}\n";
  const records: string[] = [];
  let reportBytes = Buffer.byteLength(prefix + suffix);
  let offset = 0;
  let lineCount = 0;
  while (offset < text.length) {
    if (++lineCount > MAX_LINES) throw new Error("too_many_lines");
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    offset = end + 1;
    if (line.trim().length === 0) continue;
    let result: unknown;
    try { result = diagnoseReceivedRecord(JSON.parse(line) as unknown, key); }
    catch { result = { excluded: "invalid_record" }; }
    // One frame is bounded before serialization; enforce the total before
    // retaining the next result, not after millions of nodes accumulate.
    const serialized = JSON.stringify(result, null, 2).split("\n").map((part) => `    ${part}`).join("\n");
    reportBytes += Buffer.byteLength(serialized) + (records.length === 0 ? 0 : 2);
    if (reportBytes > MAX_INPUT_BYTES) throw new Error("report_too_large");
    records.push(serialized);
  }
  const output = await open(outputPath, "wx", 0o600);
  try { await output.writeFile(prefix + records.join(",\n") + suffix); }
  finally { await output.close(); }
  return { records: records.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args.some((arg) => arg.startsWith("-"))) {
    process.stderr.write("Usage: report.ts <private-received.jsonl> <private-32-byte-key> <new-report.json>\n");
    process.exitCode = 1;
  } else {
    try {
      const result = await writeDiagnosticReport(args[0]!, args[1]!, args[2]!);
      process.stdout.write(`Wrote ${result.records} diagnostic records.\n`);
    } catch {
      // Filesystem/JSON errors can contain secret-bearing paths or input text.
      process.stderr.write("Diagnostic export failed; check private inputs and a new output path.\n");
      process.exitCode = 1;
    }
  }
}
