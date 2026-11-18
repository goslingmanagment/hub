#!/usr/bin/env node
// The two append-only barrels keep their `export … from` statements sorted by
// module path (plain code-unit order): two PRs that each add a module then
// touch different lines instead of colliding on the same last one. A
// statement's comment block sits directly above it and moves with it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BARRELS = ["packages/db/src/index.ts", "packages/contracts/src/index.ts"];

let failed = false;
for (const file of BARRELS) {
  const lines = readFileSync(join(root, file), "utf8").split("\n");
  let start = 0;
  let previous = null;
  let count = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim().startsWith("//")) continue;
    if (line.startsWith("export")) start = index + 1;
    const from = line.match(/\bfrom\s+(["'])([^"']+)\1;?\s*$/);
    if (!from) continue;
    const entry = { specifier: from[2], line: start };
    count += 1;
    if (previous && entry.specifier < previous.specifier) {
      console.error(`${file}:${entry.line}: '${entry.specifier}' must come before '${previous.specifier}' (line ${previous.line}): move line ${entry.line} to its sorted place.`);
      failed = true;
      break;
    }
    previous = entry;
  }
  if (count === 0) {
    console.error(`${file}: no \`export … from\` statement found`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log("barrels sorted");
