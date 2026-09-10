import { describe, expect, it } from "vitest";
import { parseDmConversationSweepState, serializeDmConversationSweepState }
  from "../apps/runtime/src/services/sync/cursor-state.ts";
import { createDmShadowState } from "../apps/runtime/src/services/sync/dm-shadow-state.ts";

const cursor = { version: 2, mode: "full_scan", generation: 1, offset: 100,
  observedCount: 100, pageCount: 1, providerTotalMode: "present", providerReportedTotal: 101,
  unchangedPageStreak: 1, fullSweepStartedAt: "2026-09-10T12:00:00Z", lastFullSweepCompletedAt: null };

describe("optional DM shadow cursor", () => {
  it("preserves bounded diagnostics over JSON round trips without changing business version or mode", () => {
    const diagnostics = { ...createDmShadowState({ startedAtMs: Date.now(), boundaryMs: null,
      completeCoverage: true }), pageCount: 1, materialLagSamples: 1, maxDiscoveryToCaptureMs: 12346 };
    const parsed = parseDmConversationSweepState(JSON.parse(JSON.stringify({ ...cursor, diagnostics })));
    expect(parsed?.diagnostics).toEqual(diagnostics);
    expect(serializeDmConversationSweepState(parsed!)).toEqual({ ...cursor, diagnostics });
  });

  it("discards malformed diagnostics while retaining the original resumable business cursor", () => {
    expect(parseDmConversationSweepState({ ...cursor, diagnostics: { version: 99, pageCount: [] } }))
      .toEqual(parseDmConversationSweepState(cursor));
  });
});
