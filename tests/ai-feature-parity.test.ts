import { describe, expect, it } from "vitest";

import {
  checkManifestAgainstSources,
  compareAssembledPrompts,
  desktopRepoPresent,
} from "./helpers/ai-parity.ts";

// Stage 30 Task 5 — the parity harness (passport rule: compare ASSEMBLED
// PROMPTS, not outputs). Runs against the live desktop checkout under the
// declared prompt freeze (owner, 2026-07-06); skips gracefully where the
// sibling repo is absent (the sign-off CLI is the authoritative run).
// Differences are BLOCKERS, not notes.

describe("AI feature prompt parity (Stage 30)", () => {
  it("desktop sources still match the frozen snapshot (freeze guard)", (context) => {
    if (!desktopRepoPresent()) {
      context.skip();
      return;
    }
    const results = checkManifestAgainstSources();
    const violations = results.filter((result) => !result.ok);
    expect(violations, violations.map((v) => `${v.file}: ${v.detail}`).join("\n")).toEqual([]);
  });

  it("kernel and desktop assemble byte-identical prompts for every feature fixture", async (context) => {
    if (!desktopRepoPresent()) {
      context.skip();
      return;
    }
    const comparisons = await compareAssembledPrompts();
    expect(comparisons.length).toBeGreaterThanOrEqual(9);
    const diffs = comparisons.filter((comparison) => !comparison.equal);
    expect(
      diffs,
      diffs.map((diff) => `${diff.fixture}: ${diff.firstDifference}`).join("\n"),
    ).toEqual([]);
  });
});
