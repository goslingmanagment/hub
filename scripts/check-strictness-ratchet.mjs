// Stage 35 — the strictness ratchet.
//
// tsconfig.base.json enables exactOptionalPropertyTypes + noUncheckedIndexedAccess;
// the pre-existing debt those flags surfaced is snapshotted PER FILE in
// scripts/strictness-ratchet.json. This script runs tsc and enforces:
//   - a file may never have MORE errors than its snapshot budget;
//   - a file absent from the snapshot must be clean;
//   - when a file drops below budget, the snapshot must be shrunk in the same
//     change (run with --update) — the count only ever goes down.
// So new code is held to the full standard while the old debt burns down
// without blocking. `pnpm typecheck` runs this script; a zero-debt snapshot
// means this is exactly `tsc --noEmit`.

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
for (const line of output.split("\n")) {
  const match = /^(.+?)\(\d+,\d+\): error TS\d+/.exec(line);
  if (match) counts[match[1]] = (counts[match[1]] ?? 0) + 1;
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);

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
  console.error("strictness-ratchet: type errors over budget (fix them — the count only goes down):");
  for (const { file, count, budget } of overBudget) {
    console.error(`  ${file}: ${count} error(s), budget ${budget}`);
    for (const line of output.split("\n")) if (line.startsWith(`${file}(`)) console.error(`    ${line}`);
  }
  process.exit(1);
}

// The shrink demand only applies when the FULL workspace is visible — the
// production Docker build context excludes tests/ (and the snapshot's files
// with them), which makes the total drop without any debt being paid. Files
// that exist are still held to their per-file budgets above.
const fullWorkspace = Object.keys(snapshot).every((file) => existsSync(join(root, file)));
if (fullWorkspace && total < snapshotTotal) {
  console.error(
    `strictness-ratchet: debt shrank (${snapshotTotal} → ${total}) — lock it in: pnpm typecheck:ratchet-update, commit the snapshot.`,
  );
  process.exit(1);
}
if (!fullWorkspace) {
  console.log("strictness-ratchet: partial workspace (some snapshot files absent) — per-file budgets enforced, shrink check skipped.");
}

console.log(`strictness-ratchet: OK — ${total} known error(s) within budget (${Object.keys(counts).length} file(s) with debt).`);
