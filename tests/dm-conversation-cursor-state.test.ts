// The cursor codecs the status readers and the legacy targeted thread
// backfill still read: a dm_conversations sweep cursor across the G3 version
// boundary (the sweep itself is gone since step 4, S4-14; its last cursors stay
// as records the sync monitor shows), and the dm_messages walk cursor.

import { describe, expect, it } from "vitest";

import {
  emptyDmMessagesCursorState,
  parseDmConversationCursorState,
  parseDmMessagesCursorState,
} from "../apps/runtime/src/services/sync/cursor-state.ts";

const V2_STATE = {
  version: 2,
  mode: "full_scan",
  generation: 7,
  offset: 200,
  observedCount: 200,
  pageCount: 2,
  providerTotalMode: "present",
  providerReportedTotal: 512,
  unchangedPageStreak: 1,
  fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
  lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
} as const;

function v1State(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    mode: "full_scan",
    generation: 7,
    offset: 200,
    pageCount: 2,
    providerTotalMode: "present",
    providerReportedTotal: 512,
    unchangedPageStreak: 1,
    fullSweepStartedAt: "2026-03-10T00:00:00.000Z",
    lastFullSweepCompletedAt: "2026-03-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("dm_conversations cursor state (G3), as the status readers see it", () => {
  it("round-trips a v2 state unchanged", () => {
    expect(parseDmConversationCursorState({ ...V2_STATE })).toEqual({ ...V2_STATE });
  });

  it("refuses a v2 state with no observed count", () => {
    const { observedCount: _observedCount, ...withoutCount } = V2_STATE;
    expect(parseDmConversationCursorState(withoutCount)).toBeNull();
  });

  it("refuses a version it does not know", () => {
    expect(parseDmConversationCursorState({ ...V2_STATE, version: 3 })).toBeNull();
    expect(parseDmConversationCursorState({ ...V2_STATE, version: 0 })).toBeNull();
  });

  it("refuses a completed sweep state as an in-progress cursor", () => {
    // A completed state carries no `mode`: the monitor shows no sweep in progress.
    expect(parseDmConversationCursorState({
      version: 2,
      generation: 7,
      observedCount: 200,
      destructiveFinalization: true,
      lastFullSweepCompletedAt: "2026-03-10T02:00:00.000Z",
    })).toBeNull();
  });

  it("migrates a v1 state by adopting its id array's length as the observed count", () => {
    const migrated = parseDmConversationCursorState(v1State({
      snapshotConversationIds: Array.from({ length: 200 }, (_, index) => `group-${index}`),
    }));

    expect(migrated).toEqual({ ...V2_STATE });
    expect(migrated).not.toHaveProperty("snapshotConversationIds");
  });

  it("prefers the v1 array's length over a stored observedCount", () => {
    // They agree in every state the pre-G3 writer produced; if they ever did
    // not, the array is what that sweep actually decided with.
    const migrated = parseDmConversationCursorState(v1State({
      observedCount: 3,
      snapshotConversationIds: ["group-a", "group-b"],
    }));

    expect(migrated?.observedCount).toBe(2);
  });

  it("migrates a v1 state that has only the scalar count", () => {
    const migrated = parseDmConversationCursorState(v1State({ observedCount: 200 }));

    expect(migrated).toEqual({ ...V2_STATE });
  });

  it("reads a v1 state with neither count representation at a zero count", () => {
    expect(parseDmConversationCursorState(v1State())?.observedCount).toBe(0);
  });

  it("refuses a malformed v1 array", () => {
    expect(parseDmConversationCursorState(v1State({ snapshotConversationIds: ["group-a", 7] }))).toBeNull();
  });

  it("refuses a negative observed count", () => {
    expect(parseDmConversationCursorState({ ...V2_STATE, observedCount: -1 })).toBeNull();
  });
});

describe("dm_messages cursor state: normalization debt", () => {
  const walking = {
    version: 1,
    currentConversationId: 777,
    currentPlatformConversationId: "group-1",
    currentBeforeMessageId: "m-2",
    currentMode: "backfill",
  } as const;

  it("round-trips the debt flag, so a multi-chunk walk remembers a skipped message", () => {
    const state = { ...walking, normalizationDebt: true };
    expect(parseDmMessagesCursorState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("keeps only an explicit true, and an older checkpoint parses without it", () => {
    for (const normalizationDebt of [false, "true", 1, null]) {
      expect(parseDmMessagesCursorState({ ...walking, normalizationDebt })).toEqual(walking);
    }
    expect(parseDmMessagesCursorState({ ...walking })).toEqual(walking);
  });

  it("is cleared by the empty state every completion and reset writes", () => {
    expect(emptyDmMessagesCursorState()).not.toHaveProperty("normalizationDebt");
  });
});

describe("dm_messages cursor state: new-thread history pages", () => {
  const walking = {
    version: 1,
    currentConversationId: 777,
    currentPlatformConversationId: "group-1",
    currentBeforeMessageId: "m-25",
    currentMode: "backfill",
  } as const;

  it("round-trips the counter, so the extra-page cap holds across chunks", () => {
    const state = { ...walking, newThreadHistoryPages: 3 };
    expect(parseDmMessagesCursorState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("drops a zero, negative, fractional or non-numeric counter, and an older checkpoint parses without it", () => {
    for (const newThreadHistoryPages of [0, -1, 1.5, "2", null]) {
      expect(parseDmMessagesCursorState({ ...walking, newThreadHistoryPages })).toEqual(walking);
    }
    expect(parseDmMessagesCursorState({ ...walking })).toEqual(walking);
    expect(emptyDmMessagesCursorState()).not.toHaveProperty("newThreadHistoryPages");
  });
});

describe("dm_messages cursor head-read time", () => {
  const walking = {
    version: 1,
    currentConversationId: 777,
    currentPlatformConversationId: "group-1",
    currentBeforeMessageId: "m-2",
    currentMode: "incremental",
  } as const;

  it("round-trips the head-read time, so a multi-chunk walk certifies its head only as of that read", () => {
    const state = { ...walking, headReadAt: "2026-09-22T00:11:00.000Z" };
    expect(parseDmMessagesCursorState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("drops a missing or unparseable time, which preserves last_message_sync_at instead of stamping now", () => {
    for (const headReadAt of ["not-a-date", "", 1_770_000_000_000, null, true]) {
      expect(parseDmMessagesCursorState({ ...walking, headReadAt })).toEqual(walking);
    }
    expect(parseDmMessagesCursorState({ ...walking })).toEqual(walking);
  });

  it("is cleared by the empty state every completion and reset writes", () => {
    expect(emptyDmMessagesCursorState()).not.toHaveProperty("headReadAt");
  });
});
