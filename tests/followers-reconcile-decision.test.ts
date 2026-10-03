import { describe, expect, it } from "vitest";
import { followersReconcileDecision } from "../apps/runtime/src/sync/fansly/lib/followers-reconcile-decision.ts";

const BASE = {
  activeFollowerCount: 1,
  sourceFollowerCount: 1,
  knownFollowId: "old",
  newestFollowId: "new",
  pageDone: false,
  crossedKnownBoundary: false,
  sawKnownCheckpoint: true,
  processedThisChunk: 1,
};

describe("followers reconcile diagnostic branches", () => {
  it.each([
    { countMismatch: false, exhaustedWithoutKnown: false, unchangedHeadWithRows: false },
    { countMismatch: true, exhaustedWithoutKnown: false, unchangedHeadWithRows: false },
    { countMismatch: false, exhaustedWithoutKnown: true, unchangedHeadWithRows: false },
    { countMismatch: true, exhaustedWithoutKnown: true, unchangedHeadWithRows: false },
    { countMismatch: false, exhaustedWithoutKnown: false, unchangedHeadWithRows: true },
    { countMismatch: true, exhaustedWithoutKnown: false, unchangedHeadWithRows: true },
    { countMismatch: false, exhaustedWithoutKnown: true, unchangedHeadWithRows: true },
    { countMismatch: true, exhaustedWithoutKnown: true, unchangedHeadWithRows: true },
  ])("preserves count=$countMismatch exhausted=$exhaustedWithoutKnown unchanged=$unchangedHeadWithRows", branches => {
    const decision = followersReconcileDecision({
      ...BASE,
      activeFollowerCount: branches.countMismatch ? 2 : 1,
      pageDone: branches.exhaustedWithoutKnown,
      sawKnownCheckpoint: !branches.exhaustedWithoutKnown,
      newestFollowId: branches.unchangedHeadWithRows ? "old" : "new",
    });
    expect(decision).toEqual({
      ...branches,
      requested: Object.values(branches).some(Boolean),
    });
  });

  it.each([
    {
      name: "the known checkpoint is still ahead in an unfinished walk",
      input: { pageDone: false, sawKnownCheckpoint: false },
    },
    {
      name: "the walk ends after finding the known checkpoint",
      input: { pageDone: true, sawKnownCheckpoint: true },
    },
    {
      name: "the head is unchanged but no rows were processed",
      input: { newestFollowId: "old", processedThisChunk: 0 },
    },
    {
      name: "an initial nonempty walk has no checkpoint to lose",
      input: { knownFollowId: null, pageDone: true, sawKnownCheckpoint: false },
    },
    {
      name: "null heads do not represent a known checkpoint",
      input: { knownFollowId: null, newestFollowId: null, processedThisChunk: 1 },
    },
  ])("does not request reconciliation when $name", ({ input }) => {
    expect(followersReconcileDecision({ ...BASE, ...input })).toEqual({
      countMismatch: false,
      exhaustedWithoutKnown: false,
      unchangedHeadWithRows: false,
      requested: false,
    });
  });

  it("treats a walk that stopped past a vanished known follow as ending without it", () => {
    expect(followersReconcileDecision({
      ...BASE,
      pageDone: false,
      crossedKnownBoundary: true,
      sawKnownCheckpoint: false,
    })).toEqual({
      countMismatch: false,
      exhaustedWithoutKnown: true,
      unchangedHeadWithRows: false,
      requested: true,
    });
  });

  it("does not report a lost checkpoint when the known follow sits on the crossing page", () => {
    expect(followersReconcileDecision({
      ...BASE,
      crossedKnownBoundary: true,
      sawKnownCheckpoint: true,
    }).exhaustedWithoutKnown).toBe(false);
  });

  it("does not invent a lost checkpoint or processed row on an initial empty list", () => {
    expect(followersReconcileDecision({
      ...BASE,
      knownFollowId: null,
      newestFollowId: null,
      pageDone: true,
      sawKnownCheckpoint: false,
      processedThisChunk: 0,
    }).requested).toBe(false);
  });
});
