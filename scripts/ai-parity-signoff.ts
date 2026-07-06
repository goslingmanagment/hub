// Stage 30 Task 5 — the runnable parity sign-off (passport: compare
// assembled prompts; differences are blockers). Run with:
//   node --import tsx/esm scripts/ai-parity-signoff.ts
// Exits nonzero on any freeze violation or prompt difference.

import { execFileSync } from "node:child_process";

import {
  DESKTOP_ROOT,
  FROZEN_DESKTOP_COMMIT,
  checkManifestAgainstSources,
  compareAssembledPrompts,
  desktopRepoPresent,
} from "../tests/helpers/ai-parity.ts";

async function main() {
  if (!desktopRepoPresent()) {
    console.error(
      `FAIL: desktop prompt sources not found under ${DESKTOP_ROOT} — either the ` +
      'sibling checkout is absent, or Stage 31 Task 3 deleted the desktop prompt ' +
      'library post-cutover (the manifest remains the historical sign-off record).',
    );
    process.exit(1);
  }

  const head = execFileSync("git", ["log", "-1", "--format=%H"], {
    cwd: DESKTOP_ROOT,
    encoding: "utf8",
  }).trim();
  console.log(`desktop HEAD:    ${head}`);
  console.log(`frozen snapshot: ${FROZEN_DESKTOP_COMMIT}`);
  console.log(head === FROZEN_DESKTOP_COMMIT
    ? "HEAD matches the snapshot commit."
    : "NOTE: HEAD moved since the snapshot — source hashes below decide.");

  let failed = false;

  console.log("\n── Freeze guard (source sha256 vs manifest) ──");
  for (const result of checkManifestAgainstSources()) {
    if (!result.ok) {
      failed = true;
    }
    console.log(`${result.ok ? "  ok " : "  FAIL"}  ${result.file}${result.ok ? "" : ` — ${result.detail}`}`);
  }

  console.log("\n── Assembled-prompt parity (kernel vs desktop) ──");
  for (const comparison of await compareAssembledPrompts()) {
    if (!comparison.equal) {
      failed = true;
    }
    console.log(`${comparison.equal ? "  ok " : "  FAIL"}  ${comparison.fixture}${comparison.equal ? "" : ` — ${comparison.firstDifference}`}`);
  }

  console.log(failed
    ? "\nSIGN-OFF: FAILED — differences are blockers (stage-30 §2)."
    : "\nSIGN-OFF: PASS — kernel assembly is byte-identical to the frozen desktop assembly.");
  process.exit(failed ? 1 : 0);
}

await main();
