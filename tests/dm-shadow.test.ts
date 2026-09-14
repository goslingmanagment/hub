import { describe, expect, it } from "vitest";

import { advanceDmShadow, type DmShadowConversation } from
  "../apps/runtime/src/services/sync/dm-shadow.ts";
import { createDmShadowState, parseDmShadowState } from
  "../apps/runtime/src/services/sync/dm-shadow-state.ts";

const START = Date.UTC(2026, 8, 1, 12);
const BOUNDARY = START - 60_000;

function initial(depth = 1, overlapMs = 0) {
  return createDmShadowState({
    startedAtMs: START,
    boundaryMs: BOUNDARY,
    completeCoverage: true,
    policy: { depth, overlapMs },
  });
}

function head(change: Partial<DmShadowConversation> = {}): DmShadowConversation {
  return {
    reasons: [],
    listMessageId: "known",
    embeddedMessageId: "known",
    timestampMs: BOUNDARY - 60_000,
    previousTimestampMs: BOUNDARY - 60_000,
    previousMessageId: "known",
    materialConfirmed: true,
    discoveryToCaptureMs: null,
    historyPending: false,
    lastHistorySyncAtMs: null,
    ...change,
  };
}

function page(...conversations: DmShadowConversation[]) {
  return { observedAtMs: START + 1000, responseBytes: 500, conversations };
}

describe("DM virtual-stop diagnostics", () => {
  it("charges the stopping page and counts changes on all later pages", () => {
    const source = initial();
    const stopped = advanceDmShadow(source, page(head()));
    expect(source.stopPage).toBeNull();
    expect(stopped.stopPage).toBe(1);
    expect(stopped.pagesBelowStop).toBe(0);

    const result = advanceDmShadow(stopped, page(head({
      reasons: ["last_message_id", "unread_count", "conversation_flags"],
      listMessageId: "new",
      embeddedMessageId: "new",
      materialConfirmed: false,
    })));
    expect(result).toMatchObject({
      pagesBelowStop: 1,
      bytesBelowStop: 500,
      changedHeadsBelowStop: 1,
      stateChangesBelowStop: 1,
      unreadChangesBelowStop: 1,
      flagsChangesBelowStop: 1,
      missingHotHeadsBelowStop: 1,
    });
  });

  it.each([
    { listMessageId: null },
    { embeddedMessageId: null },
    { embeddedMessageId: "contradiction" },
    { timestampMs: null },
    { timestampMs: Number.NaN },
  ])("does not stop on an unknown or conflicting marker: %j", (change) => {
    const result = advanceDmShadow(initial(), page(head(change)));
    expect(result.stopPage).toBeNull();
    expect(result.invalidMarkers).toBe(1);
  });

  it("requires strictly older timestamps, including across an overlap window", () => {
    expect(advanceDmShadow(initial(), page(head({ timestampMs: BOUNDARY }))).stopPage)
      .toBeNull();
    const result = advanceDmShadow(initial(1, 60_000), page(head()));
    expect(result.stopPage).toBeNull();
    expect(advanceDmShadow(initial(1, 59_999), page(head())).stopPage).toBe(1);
  });

  it("restarts its own streak on flags without changing the legacy predicate", () => {
    let state = advanceDmShadow(initial(2), page(head()));
    state = advanceDmShadow(state, page(head({ reasons: ["conversation_flags"] })));
    state = advanceDmShadow(state, page(head()));
    expect(state.stopPage).toBeNull();
    expect(advanceDmShadow(state, page(head())).stopPage).toBe(4);
  });

  it("counts both unread reasons once per conversation and ignores changes before the stop", () => {
    const change = head({ reasons: ["unread_count", "last_unread_message_id", "visibility"] });
    const beforeStop = advanceDmShadow(initial(), page(change));
    expect(beforeStop).toMatchObject({
      stopPage: null, stateChangesBelowStop: 0,
      unreadChangesBelowStop: 0, visibilityChangesBelowStop: 0,
    });
    const stopped = advanceDmShadow(beforeStop, page(head()));
    const result = advanceDmShadow(stopped, page(change));
    expect(result).toMatchObject({
      stateChangesBelowStop: 1, unreadChangesBelowStop: 1, visibilityChangesBelowStop: 1,
    });
    expect(stopped.unreadChangesBelowStop).toBe(0);
  });

  it("counts new rows, sender changes and null head IDs below the stop", () => {
    const stopped = advanceDmShadow(initial(), page(head()));
    const result = advanceDmShadow(stopped, page(
      head({ reasons: ["missing_row"], previousMessageId: null }),
      head({ reasons: ["last_message_sender_id"] }),
      head({ reasons: ["last_message_id"], listMessageId: null, embeddedMessageId: null }),
    ));
    expect(result).toMatchObject({
      newHeadsBelowStop: 1,
      stateChangesBelowStop: 3,
      headRollbacksBelowStop: 1,
      invalidMarkersBelowStop: 1,
    });
  });

  it("survives restart and an outage longer than an hour with a scalar cursor", () => {
    const stopped = advanceDmShadow(initial(), page(head()));
    const restored = parseDmShadowState(JSON.parse(JSON.stringify(stopped)));
    expect(restored).toEqual(stopped);
    const result = advanceDmShadow(restored!, {
      ...page(head({ reasons: ["last_message_id"] })),
      observedAtMs: START + 2 * 3_600_000,
    });
    expect(result.changedHeadsBelowStop).toBe(1);
    expect(result.maxObservationGapMs).toBe(2 * 3_600_000 - 1000);
    expect(Object.values(result).every((value) => value === null || typeof value !== "object"))
      .toBe(true);
  });

  it("cannot manufacture a boundary or complete coverage from missing evidence", () => {
    const state = createDmShadowState({
      startedAtMs: START,
      boundaryMs: null,
      completeCoverage: false,
    });
    const result = advanceDmShadow(state, page(head()));
    expect(result.stopPage).toBeNull();
    expect(result.completeCoverage).toBe(false);
    expect(parseDmShadowState({ ...state, pageCount: -1 })).toBeUndefined();
  });

  it("keeps pending history with unknown age visible, even when never synced", () => {
    const result = advanceDmShadow(initial(), page(
      head({ historyPending: true }),
      head({ historyPending: true, lastHistorySyncAtMs: START - 3_600_000 }),
    ));
    expect(result).toMatchObject({
      pendingHistoryCount: 2,
      unknownHistoryAgeCount: 2,
      maxHistorySyncAgeMs: 3_601_000,
    });
  });

  it("keeps reader state separate from hot presence, counts below stop and never mutates the prior cursor", () => {
    const source = initial();
    const stopped = advanceDmShadow(source, page(head({ readerHead: {
      state: "materialized", source: "hot", liveHotCopy: true,
    } })));
    const result = advanceDmShadow(stopped, page(
      ...(["materialized", "missing", "deleted", "content_pending"] as const).map(state => head({
        materialConfirmed: false, readerHead: { state, source: "message_archive", liveHotCopy: false },
      })), head(), head({ listMessageId: null }),
    ));
    expect(result).toMatchObject({ readerHeadsChecked: 5, unknownReaderHeadChecks: 1,
      readerMaterializedHeadsBelowStop: 1, readerMissingHeadsBelowStop: 1, readerDeletedHeadsBelowStop: 1,
      readerPendingHeadsBelowStop: 1, readerArchiveOnlyHeadsBelowStop: 1 });
    expect(result.missingHotHeadsBelowStop).toBe(4);
    expect(stopped.readerHeadsChecked).toBe(1);
    expect(source.readerHeadsChecked).toBe(0);
    expect(result.stopPage).toBe(stopped.stopPage);
  });

});
