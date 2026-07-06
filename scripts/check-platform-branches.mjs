#!/usr/bin/env node
// Kernel Stage 18 ratchet: counts strict `platform ===` branch sites outside
// the adapter packages and fails when the count EXCEEDS the recorded budget.
// Decreases are recorded by updating scripts/platform-branch-budget.json.
// Also runnable in CI; the test suite wraps the same logic.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function countPlatformBranches() {
  let output = "";
  try {
    output = execFileSync(
      "grep",
      ["-rn", "platform ===", "--include=*.ts", "apps", "packages", "tests"],
      { cwd: root, encoding: "utf8" },
    );
  } catch {
    return { count: 0, offenders: [] };
  }
  const offenders = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !/^packages\/(onlyfans|fansly)\//.test(line))
    // The ratchet's own infrastructure mentions the pattern literally.
    .filter((line) => !line.includes("platform-registry.test.ts"));
  return { count: offenders.length, offenders };
}

const { budget } = JSON.parse(readFileSync(join(root, "scripts/platform-branch-budget.json"), "utf8"));
const { count, offenders } = countPlatformBranches();

if (count > budget) {
  console.error(`platform === branch sites: ${count} > budget ${budget}`);
  console.error(offenders.map((line) => `  ${line.split(":").slice(0, 2).join(":")}`).join("\n"));
  process.exit(1);
}
console.log(`platform === branch sites: ${count} (budget ${budget})`);
if (count < budget) {
  console.log("count dropped — update scripts/platform-branch-budget.json to ratchet down");
}
