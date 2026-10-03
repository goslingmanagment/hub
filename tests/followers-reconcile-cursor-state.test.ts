import { describe, expect, it } from "vitest";

import { parseFollowersReconcileProgressState } from "../apps/runtime/src/services/sync/cursor-state.ts";

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
  it("shows legacy progress without fabricating a sweep start", () => {
    expect(parseFollowersReconcileProgressState(LEGACY_STATE, 4)).toEqual({
      ...LEGACY_STATE,
      fullSweepStartedAt: null,
    });
  });

  it("shows a fenced cursor's progress with its sweep start", () => {
    const state = {
      ...LEGACY_STATE,
      fullSweepStartedAt: "2026-08-24T20:00:00.000Z",
    };

    expect(parseFollowersReconcileProgressState(state, 4)).toEqual(state);
  });
});
