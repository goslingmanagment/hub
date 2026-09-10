import { describe, expect, it } from "vitest";
import { followersReconcileDecision } from "../apps/runtime/src/services/sync/followers-reconcile-decision.ts";

const BASE = {
  activeFollowerCount: 1, sourceFollowerCount: 1, knownFollowId: "old",
  newestFollowId: "new", pageDone: false, sawKnownCheckpoint: true, processedThisChunk: 1,
};

describe("followers reconcile diagnostic branches", () => {
  it.each(Array.from({ length: 8 }, (_, mask) => mask))("preserves OR branches for mask %i", mask => {
    const decision = followersReconcileDecision({
      ...BASE, activeFollowerCount: mask & 1 ? 2 : 1,
      pageDone: Boolean(mask & 2), sawKnownCheckpoint: !(mask & 2),
      newestFollowId: mask & 4 ? "old" : "new",
    });
    expect(decision).toEqual({
      countMismatch: Boolean(mask & 1), exhaustedWithoutKnown: Boolean(mask & 2),
      unchangedHeadWithRows: Boolean(mask & 4), requested: mask !== 0,
    });
  });
  it("does not invent a lost checkpoint or processed row on an initial empty list", () => {
    expect(followersReconcileDecision({
      ...BASE, knownFollowId: null, newestFollowId: null, pageDone: true,
      sawKnownCheckpoint: false, processedThisChunk: 0,
    }).requested).toBe(false);
  });
});
