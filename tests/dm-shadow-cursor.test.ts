import { describe, expect, it } from "vitest";
import { parseDmConversationSweepState, serializeDmConversationSweepState }
  from "../apps/runtime/src/services/sync/cursor-state.ts";
import { createDmShadowState } from "../apps/runtime/src/services/sync/dm-shadow-state.ts";
import { advanceDmShadow } from "../apps/runtime/src/services/sync/dm-shadow.ts";

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

  it("keeps missing legacy reason counts unknown through resume and serialization", () => {
    const { visibilityChangesBelowStop: _visibility, unresolvedIdentityChangesBelowStop: _identity,
      exclusionReasonChangesBelowStop: _exclusion, subscriptionTierChangesBelowStop: _tier,
      headTimestampChangesBelowStop: _timestamp, headSenderChangesBelowStop: _sender,
      readerHeadsChecked: _readerHeadsChecked,
      unknownReaderHeadChecks: _unknownReaderHeadChecks,
      readerMaterializedHeadsBelowStop: _readerMaterializedHeadsBelowStop,
      readerMissingHeadsBelowStop: _readerMissingHeadsBelowStop,
      readerDeletedHeadsBelowStop: _readerDeletedHeadsBelowStop,
      readerPendingHeadsBelowStop: _readerPendingHeadsBelowStop,
      readerArchiveOnlyHeadsBelowStop: _readerArchiveOnlyHeadsBelowStop,
      ...legacy } = createDmShadowState({
      startedAtMs: Date.UTC(2026, 8, 10, 12), boundaryMs: null, completeCoverage: true,
    });
    const parsed = parseDmConversationSweepState({
      ...cursor, diagnostics: { ...legacy, pageCount: 1, stopPage: 1, stateChangesBelowStop: 4 },
    })!;
    parsed.diagnostics = advanceDmShadow(parsed.diagnostics!, {
      observedAtMs: Date.UTC(2026, 8, 10, 13), responseBytes: 100,
      conversations: [{
        reasons: ["visibility", "unresolved_identity", "message_sync_excluded_reason",
          "subscription_tier_id", "last_message_at", "last_message_sender_id"],
        listMessageId: "head", embeddedMessageId: "head", previousMessageId: "head",
        timestampMs: 1, previousTimestampMs: 1, materialConfirmed: true,
        discoveryToCaptureMs: null, historyPending: false, lastHistorySyncAtMs: null,
      }],
    });
    const serialized = serializeDmConversationSweepState(parsed);
    expect(serialized.diagnostics).toMatchObject({
      stateChangesBelowStop: 5, visibilityChangesBelowStop: null,
      unresolvedIdentityChangesBelowStop: null, exclusionReasonChangesBelowStop: null,
      subscriptionTierChangesBelowStop: null, headTimestampChangesBelowStop: null,
      headSenderChangesBelowStop: null,
      readerHeadsChecked: null,
      unknownReaderHeadChecks: null,
      readerMaterializedHeadsBelowStop: null,
      readerMissingHeadsBelowStop: null,
      readerDeletedHeadsBelowStop: null,
      readerPendingHeadsBelowStop: null,
      readerArchiveOnlyHeadsBelowStop: null,
    });
    expect({ ...serialized, diagnostics: undefined }).toEqual({ ...cursor, diagnostics: undefined });
  });
});
