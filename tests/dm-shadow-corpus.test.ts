import { describe, expect, it } from "vitest";
import { DmShadowCorpusAnalyzer } from "../scripts/fansly-events/corpus.ts";

const START = Date.UTC(2026, 8, 1, 12);
function head(n: number, subscriptionTierId: string | null = null) {
  return { groupId: `g${n}`, lastMessageId: `m${n}`, embeddedId: `m${n}`, embeddedMatches: 1,
    timestamp: START - 3_600_000, senderId: "fan", unreadCount: 0, flags: 0,
    lastUnreadMessageId: null, subscriptionTierId };
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

  it("counts retained metadata changes while leaving runtime-only categories unknown", () => {
    const analyzer = primed();
    analyzer.accept(page(3, 0, Array.from({ length: 100 }, (_, n) => head(n))));
    analyzer.accept(page(4, 100, [head(100), {
      ...head(101, "new-tier"), senderId: "new-sender", timestamp: START - 1_800_000,
    }], true));
    expect(analyzer.report().sweeps[1]).toMatchObject({ status: "complete", diagnostics: {
      stateChangesBelowStop: 1, subscriptionTierChangesBelowStop: 1,
      headTimestampChangesBelowStop: 1, headSenderChangesBelowStop: 1,
      visibilityChangesBelowStop: null, unresolvedIdentityChangesBelowStop: null,
      exclusionReasonChangesBelowStop: null,
    } });
  });

  it("counts a dangling list pointer clearing once across three certified sweeps", () => {
    // Sanitized Lora-1 shape: the embedded head was already unavailable before
    // the list pointer became null. A second null group is an unchanged control.
    const analyzer = new DmShadowCorpusAnalyzer({ depth: 1, overlapMs: 0 });
    const dangling = { ...head(101), embeddedId: null, timestamp: null, senderId: null };
    const cleared = { ...dangling, lastMessageId: null };
    const empty = { ...head(100), lastMessageId: null, embeddedId: null,
      timestamp: null, senderId: null };
    [dangling, cleared, cleared].forEach((target, index) => {
      const id = index * 2 + 1;
      analyzer.accept(page(id, 0, Array.from({ length: 100 }, (_, n) => head(n))));
      analyzer.accept({ ...page(id + 1, 100, [], true), heads: [empty, target] });
    });

    const result = analyzer.report();
    expect(result.invalidRecords).toBe(0);
    expect(result.sweeps.map((sweep) => sweep.status)).toEqual(["priming", "complete", "complete"]);
    expect(result.sweeps[1]?.diagnostics).toMatchObject({
      stopPage: 1, pagesBelowStop: 1, conversationsBelowStop: 2,
      stateChangesBelowStop: 1, changedHeadsBelowStop: 1, headRollbacksBelowStop: 1,
      headTimestampChangesBelowStop: 0, headSenderChangesBelowStop: 0,
      invalidMarkersBelowStop: 2, missingHotHeadsBelowStop: 0, unknownMaterialChecks: 102,
    });
    expect(result.sweeps[2]?.diagnostics).toMatchObject({
      stopPage: 1, stateChangesBelowStop: 0, changedHeadsBelowStop: 0,
      headRollbacksBelowStop: 0, invalidMarkersBelowStop: 2,
      missingHotHeadsBelowStop: 0, unknownMaterialChecks: 102,
    });
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
