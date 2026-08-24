import { describe, expect, it } from "vitest";

import {
  parseFollowersReconcileCursorState,
  parseFollowersReconcileProgressState,
} from "../apps/runtime/src/services/sync/cursor-state.ts";

const LEGACY_STATE = {
  revision: 4,
  generation: 613,
  offset: 100,
  observedCount: 100,
  pageCount: 2,
  sourceFollowerCount: 100,
  snapshotRestartCount: 0,
  restartReason: null,
  verificationPending: false,
};

describe("followers reconcile cursor state", () => {
  it("shows legacy progress without allowing the unsafe sweep to resume", () => {
    expect(parseFollowersReconcileProgressState(LEGACY_STATE, 4)).toEqual({
      ...LEGACY_STATE,
      fullSweepStartedAt: null,
    });
    expect(parseFollowersReconcileCursorState(LEGACY_STATE, 4)).toBeNull();
  });

  it("parses a fenced cursor for both execution and progress", () => {
    const state = {
      ...LEGACY_STATE,
      fullSweepStartedAt: "2026-08-24T20:00:00.000Z",
    };

    expect(parseFollowersReconcileProgressState(state, 4)).toEqual(state);
    expect(parseFollowersReconcileCursorState(state, 4)).toEqual(state);
  });
});
