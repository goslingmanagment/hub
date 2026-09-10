import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

import { DmShadowCorpusAnalyzer } from "./corpus.ts";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) throw new Error("Usage: analyze-corpus.ts INPUT.jsonl OUTPUT.json");
const manifest = JSON.parse(await readFile(`${inputPath}.manifest.json`, "utf8"));
const windowMs = Date.parse(manifest.to) - Date.parse(manifest.from);
if (!Number.isFinite(windowMs) || windowMs <= 0 || windowMs > 8 * 86_400_000 ||
  !/^[a-f0-9]{64}$/.test(manifest.sha256 ?? "") ||
  manifest.operation !== "corpus" || typeof manifest.sha256 !== "string" ||
  !Number.isSafeInteger(manifest.records) || !manifest.completedAt) {
  throw new Error("A completed corpus export manifest is required");
}
const hash = createHash("sha256");
const input = createReadStream(inputPath);
input.on("data", (chunk) => hash.update(chunk));
const analyzers = [1, 3, 5].flatMap((depth) => [0, 60_000, 300_000].map((overlapMs) =>
  new DmShadowCorpusAnalyzer({ depth, overlapMs })
));
let records = 0;
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  if (!line.trim()) continue;
  const record: unknown = JSON.parse(line);
  for (const analyzer of analyzers) analyzer.accept(record);
  records += 1;
}
if (records !== manifest.records || hash.digest("hex") !== manifest.sha256) {
  throw new Error("Corpus content does not match its completed export manifest");
}
const result = {
  createdAt: new Date().toISOString(), inputPath, records, inputManifest: manifest,
  scope: "Raw-to-raw heads, timestamps, unread, flags and tiers; certified full predecessors only",
  uncovered: [
    "Business apply and repaired fields are not reconstructed from raw responses",
    "Material receipts, history age, visibility and discovery-to-reader latency are unavailable",
    "Mutable offset can miss delete+insert above the current offset without duplicate or total drift",
    "Hypothetical list-page savings are not measured physical HTTP savings or an A1 acceptance",
  ],
  sensitivity: analyzers.map((analyzer) => analyzer.report()),
};
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(`Analyzed ${records} retained pages at 9 depth/overlap settings.\n`);
