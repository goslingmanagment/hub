import { describe, expect, it } from "vitest";
import { DmShadowCorpusAnalyzer } from "../scripts/fansly-events/corpus.ts";

const START = Date.UTC(2026, 8, 1, 12);
function head(n: number) {
  return { groupId: `g${n}`, lastMessageId: `m${n}`, embeddedId: `m${n}`, embeddedMatches: 1,
    timestamp: START - 3_600_000, senderId: "fan", unreadCount: 0, flags: 0,
    lastUnreadMessageId: null, subscriptionTierId: null };
}
function page(id: number, offset: number, heads: ReturnType<typeof head>[], certified = false) {
  return { id, pageLabel: "lilly-2", capturedAt: new Date(START + id * 1000).toISOString(),
    offset, limit: 100, sortOrder: 1, payloadAvailable: true, dataValid: true,
    total: 102, retainedJsonBytes: 1000, heads, runOutcome: "succeeded",
    runFinishedAt: new Date(START + id * 1000).toISOString(),
    certifiedAt: certified ? new Date(START + id * 1000).toISOString() : null };
}
function primed() {
  const analyzer = new DmShadowCorpusAnalyzer({ depth: 1, overlapMs: 0 });
  analyzer.accept(page(1, 0, Array.from({ length: 100 }, (_, n) => head(n))));
  analyzer.accept(page(2, 100, [head(100), head(101)], true));
  return analyzer;
}

describe("retained DM corpus comparison", () => {
  it("uses only a verified full predecessor and reports below-stop differences at several depths", () => {
    const analyzer = primed();
    analyzer.accept(page(3, 0, Array.from({ length: 100 }, (_, n) => head(n))));
    analyzer.accept(page(4, 100, [head(100), { ...head(101), flags: 8 }], true));
    const result = analyzer.report();
    expect(result.sweeps.map((s) => s.status)).toEqual(["priming", "complete"]);
    expect(result.sweeps[1]?.diagnostics).toMatchObject({ stopPage: 1, flagsChangesBelowStop: 1,
      unknownMaterialChecks: 102, missingHotHeadsBelowStop: 0 });
  });

  it.each(["failed", null])("excludes raw from a failed or missing run: %s", (runOutcome) => {
    const analyzer = primed();
    analyzer.accept({ ...page(3, 0, [head(0)], true), runOutcome });
    expect(analyzer.report().sweeps[1]).toMatchObject({ status: "incomplete", reason: "run_unverified" });
  });

  it("keeps truncated, restarted and duplicate sweeps out of the success denominator", () => {
    const analyzer = primed();
    analyzer.accept(page(3, 0, Array.from({ length: 100 }, (_, n) => head(n))));
    analyzer.accept(page(4, 0, [head(0), head(0)], true));
    analyzer.accept(page(5, 0, Array.from({ length: 100 }, (_, n) => head(n))));
    expect(analyzer.report().sweeps.slice(1).map((s) => [s.status, s.reason])).toEqual([
      ["incomplete", "restart_before_completion"], ["incomplete", "duplicate_or_overlap"],
      ["incomplete", "end_of_corpus"],
    ]);
  });

  it("does not infer completion from a short raw response without a certification receipt", () => {
    const analyzer = primed();
    analyzer.accept(page(3, 0, Array.from({ length: 100 }, (_, n) => head(n))));
    analyzer.accept(page(4, 100, [head(100), head(101)]));
    expect(analyzer.report().sweeps[1]).toMatchObject({ status: "incomplete", reason: "completion_unverified" });
  });

  it("refuses ambiguous duplicate aggregation heads even when the first matches", () => {
    const analyzer = primed();
    analyzer.accept(page(3, 0, [{ ...head(0), embeddedMatches: 2 }], true));
    expect(analyzer.report().sweeps[1]).toMatchObject({
      status: "incomplete", reason: "ambiguous_or_missing_head_binding",
    });
  });

  it("exposes the mutable-offset blind spot: delete+insert above the offset can leave no trace below it", () => {
    const analyzer = primed();
    analyzer.accept(page(3, 0, Array.from({ length: 100 }, (_, n) => head(n))));
    // Provider now replaces g50 with g999 above offset 100, keeping total 102.
    // The old first response and unchanged second response cannot reveal it.
    const actualProviderIds = new Set(Array.from({ length: 102 }, (_, n) => `g${n}`));
    actualProviderIds.delete("g50");
    actualProviderIds.add("g999");
    analyzer.accept(page(4, 100, [head(100), head(101)], true));
    const measured = analyzer.report().sweeps[1];
    expect(actualProviderIds.has("g999")).toBe(true);
    expect(measured?.diagnostics.stateChangesBelowStop).toBe(0);
    expect(measured?.status).toBe("complete"); // complete observations, not a safe A1 stop proof
  });
});
