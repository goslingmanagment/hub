import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createDurableFanslyAttemptBudget,
  FanslyDailyAttemptBudgetExhaustedError,
} from "../apps/runtime/src/services/sync/fansly-lane.ts";

const ROOT = join(__dirname, "..");

/** The response classifiers of the Sync Engine's lib. */
function engineLibSource(file: string) {
  return readFileSync(
    join(ROOT, "apps/runtime/src/sync/fansly/lib", file),
    "utf8",
  );
}

describe("Fansly lane scaffold ratchet", () => {
  it("keeps every response family on the shared three-way classifier", () => {
    expect(engineLibSource("stats-rules.ts")).toContain("classifyFanslyResponse");
    expect(engineLibSource("media-stats-rules.ts")).toContain("classifyStatsWindow");
    for (const file of [
      "notifications-rules.ts",
      "catalog-rules.ts",
      "post-replies-rules.ts",
      "payouts-rules.ts",
      "purchase-history.ts",
    ]) {
      expect(engineLibSource(file), `${file} must use the shared response classifier`)
        .toContain("classifyFanslyResponse");
    }
  });
});

/** Every TypeScript source file under `dir`, relative to the repository root. */
function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

// Step 4 (S4-18) deleted the legacy Fansly content lanes. What is left of their
// scaffold serves only the legacy handlers other step-4 PRs delete: the ramp gate
// of fan_earnings and purchase_history and the purchase-history lane runtime
// (S4-16), and the continuation spread of the subscribers and followers walks
// (S4-17). Whichever of those PRs lands last leaves exports nothing calls; this
// keeps them from outliving their last caller.
describe("the legacy lane scaffold remainder", () => {
  const runtime = [...sourceFiles("apps/runtime/src"), ...sourceFiles("packages")]
    .map((path) => ({ path, source: withoutComments(readFileSync(join(ROOT, path), "utf8")) }));

  it.each([
    "apps/runtime/src/services/sync/fansly-stream-gate.ts",
    "apps/runtime/src/services/sync/fansly-lane.ts",
  ])("%s exports nothing its last caller left behind", (file) => {
    const own = withoutComments(readFileSync(join(ROOT, file), "utf8"));
    const exported = [...own.matchAll(/^export (?:async )?(?:function|const|class) (\w+)/gm)].map((match) => match[1]!);
    expect(exported.length).toBeGreaterThan(0);
    const orphans = exported.filter((name) => {
      const usedInFile = (own.match(new RegExp(`\\b${name}\\b`, "g")) ?? []).length > 1;
      const word = new RegExp(`\\b${name}\\b`);
      return !usedInFile && !runtime.some((entry) => entry.path !== file && word.test(entry.source));
    });
    expect(
      orphans,
      `${file}: no runtime code calls ${orphans.join(", ")} any more — delete them (and the file once it is empty, `
        + "with its tests); when the ramp gate goes, mark fanslyFanEarningsSyncEnabled, "
        + "fanslyPurchaseHistorySyncEnabled and fanslyNewStreamPageAllowlist retired as well",
    ).toEqual([]);
  });
});

describe("Fansly lane attempt budget", () => {
  const started = (attemptNumber: number) => ({
    requestId: "account_stats:1",
    state: "started" as const,
    operation: "account_stats",
    endpointTemplate: "/api/v1/it/amoie/stats",
    method: "GET",
    attemptNumber,
    timestamp: new Date("2026-08-20T05:01:00.000Z"),
  });

  it("keeps attempts held back out of a request's retry allowance and its admission", async () => {
    let state = { utcDay: "2026-08-20", callsToday: 1 };
    const budget = createDurableFanslyAttemptBudget({
      dailyCap: 3,
      getState: () => state,
      setState: (next) => {
        state = next;
      },
      saveProgress: async () => {},
    });
    const holding = budget.holdingBack(1);

    // Two attempts left today, one of them held for a later request: this one
    // may make one attempt, so the adapter allows it no retry.
    expect(budget.remainingAttempts()).toBe(2);
    expect(holding.remainingAttempts()).toBe(1);
    expect(holding.hasCapacity()).toBe(true);
    await holding.observer.onRequestEvent(started(1));
    expect(state.callsToday).toBe(2);

    // An adapter that retries past its allowance is refused before the wire.
    expect(holding.remainingAttempts()).toBe(0);
    expect(holding.hasCapacity()).toBe(false);
    await expect(holding.observer.onRequestEvent(started(2)))
      .rejects.toBeInstanceOf(FanslyDailyAttemptBudgetExhaustedError);
    expect(state.callsToday).toBe(2);

    // The held attempt is still there for the request it was held for.
    expect(budget.hasCapacity()).toBe(true);
    await budget.observer.onRequestEvent(started(1));
    expect(state.callsToday).toBe(3);
    expect(budget.holdingBack(0).remainingAttempts()).toBe(0);
  });
});
