#!/usr/bin/env node
// Kernel Stage 26 ratchet: counts raw global-`fetch(` call sites in runtime
// source outside the egress resolver's own modules, and fails when the count
// EXCEEDS the recorded budget. Every outbound platform call must resolve its
// transport through services/egress/resolveEgress — the count's target
// trajectory is 0 (the remaining budget is the recorded OFAPI, Fansly-adapter,
// and Anthropic transport debt; Telegram and ElevenLabs use the egress seam).
// Decreases are recorded by updating scripts/raw-fetch-budget.json.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function countRawFetchSites() {
  let output;
  try {
    output = execFileSync(
      "grep",
      ["-rnE", "(^|[^.\\w$])fetch\\(", "--include=*.ts", "apps/runtime/src", "packages"],
      { cwd: root, encoding: "utf8" },
    );
  } catch {
    return { count: 0, offenders: [] };
  }
  const offenders = output
    .split("\n")
    .filter((line) => line.trim() !== "")
    // The resolver's own modules are the one legal home for raw transport.
    .filter((line) => !line.startsWith("apps/runtime/src/services/egress/"))
    // Type/interface positions ("fetch(" in a signature) and comments still
    // count on purpose: the ratchet is deliberately blunt — renaming a local
    // is cheaper than a leak.
    .filter((line) => !line.includes("check-raw-fetch"));
  return { count: offenders.length, offenders };
}

const { budget } = JSON.parse(readFileSync(join(root, "scripts/raw-fetch-budget.json"), "utf8"));
const { count, offenders } = countRawFetchSites();

if (count > budget) {
  console.error(`raw fetch( sites: ${count} > budget ${budget}`);
  console.error(offenders.map((line) => `  ${line.split(":").slice(0, 2).join(":")}`).join("\n"));
  process.exit(1);
}
console.log(`raw fetch( sites: ${count} (budget ${budget})`);
if (count < budget) {
  console.log("count dropped — update scripts/raw-fetch-budget.json to ratchet down");
}
