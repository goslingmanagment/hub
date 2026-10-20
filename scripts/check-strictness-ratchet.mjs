// Stage 35 — the strictness ratchet.
//
// tsconfig.base.json enables exactOptionalPropertyTypes + noUncheckedIndexedAccess;
// the pre-existing debt those flags surfaced is snapshotted PER FILE in
// scripts/strictness-ratchet.json. This script runs tsc and enforces:
//   - a file may never have MORE errors than its snapshot budget;
//   - a file absent from the snapshot must be clean;
//   - an error without a file location has no budget and always fails.
// Paid-down debt and snapshot entries for deleted files are only reported:
// shrinking the snapshot (`pnpm typecheck:ratchet-update`) is optional
// housekeeping, never a failed check. `pnpm typecheck` runs this script; a
// zero-debt snapshot means this is exactly `tsc --noEmit`.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const snapshotPath = join(root, "scripts", "strictness-ratchet.json");
const update = process.argv.includes("--update");

let output = "";
try {
  execFileSync("pnpm", ["exec", "tsc", "--noEmit", "--pretty", "false"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
} catch (error) {
  output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  if (!/error TS\d+/.test(output)) {
    console.error(output || String(error));
    process.exit(1);
  }
}

const counts = {};
const unlocated = [];
for (const line of output.split("\n")) {
  const match = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
  if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
  else if (/error TS\d+/.test(line)) unlocated.push(line);
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

// A global diagnostic (a missing type library or global type, an unknown
// option, a root file not found) carries no file(line,col), so no budget can
// hold it — and tsc skips the per-file check after one, so the counts above
// come back empty and a partial workspace would pass. Fail, in --update too:
// the snapshot cannot record it.
if (unlocated.length > 0) {
  console.error("strictness-ratchet: tsc reported error(s) without a file location — no budget covers them, fix them:");
  for (const line of unlocated) console.error(`  ${line}`);
  process.exit(1);
}

if (update) {
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(snapshotPath, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`strictness-ratchet: snapshot updated — ${total} error(s) across ${Object.keys(counts).length} file(s).`);
  process.exit(0);
}

let snapshot;
try {
  snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
} catch {
  console.error(`strictness-ratchet: missing/unreadable ${snapshotPath} — run with --update to create it.`);
  process.exit(1);
}

const overBudget = [];
for (const [file, count] of Object.entries(counts)) {
  const budget = snapshot[file] ?? 0;
  if (count > budget) overBudget.push({ file, count, budget });
}
const snapshotTotal = Object.values(snapshot).reduce((a, b) => a + b, 0);

if (overBudget.length > 0) {
  console.error("strictness-ratchet: new type errors (tsc, strict flags) — fix them; only after renaming a file with old debt run pnpm typecheck:ratchet-update:");
  for (const { file, count, budget } of overBudget) {
    console.error(`  ${file}: ${count} error(s), budget ${budget}`);
    for (const line of output.split("\n")) if (line.startsWith(`${file}(`)) console.error(`    ${line}`);
  }
  process.exit(1);
}

// Housekeeping hints only: a snapshot that names deleted files or still
// budgets debt that was paid down is stale, not wrong.
const missing = Object.keys(snapshot).filter((file) => !existsSync(join(root, file)));
if (total < snapshotTotal || missing.length > 0) {
  console.log(
    `strictness-ratchet: note — the snapshot can shrink (${snapshotTotal} → ${total}); optional: pnpm typecheck:ratchet-update.`,
  );
}

console.log(`strictness-ratchet: OK — ${total} known error(s) within budget (${Object.keys(counts).length} file(s) with debt).`);
