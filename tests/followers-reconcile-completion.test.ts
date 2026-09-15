import { describe, expect, it } from "vitest";
import { readFollowersReconcileCompletion } from "../apps/runtime/src/services/sync/followers-reconcile-completion.ts";

const at = new Date("2026-09-15T10:00:00.000Z");
function receipt() {
  return {
    cursorSeq: 3, cursorLastSucceededRunId: 7, cursorLastSucceededAt: at,
    state: {
      revision: 3, generation: 10, fullSweepStartedAt: "2026-09-15T09:00:00.000Z",
      observedCount: 2, pageCount: 1, sourceFollowerCount: 2, verificationPending: false,
      completion: { version: 1, runId: 7, completedAt: at.toISOString(),
        membershipProof: "exact_generation", generationObservedCount: 2 },
    },
  };
}
describe("certified follower completion receipt", () => {
  it("returns the original read time", () => {
    expect(readFollowersReconcileCompletion(receipt(), 3, new Date(at.getTime() + 60_000)))
      .toMatchObject({ succeededAt: at, stats: { reusedCompletedWalk: true, processedThisChunk: 0 } });
  });
  it.each([
    ["missing", null], ["old format", { ...receipt(), state: {} }],
    ["another cursor", { ...receipt(), cursorSeq: 4 }],
    ["another run", { ...receipt(), cursorLastSucceededRunId: 8 }],
    ["another timestamp", { ...receipt(), cursorLastSucceededAt: new Date(at.getTime() - 1) }],
    ["another revision", { ...receipt(), state: { ...receipt().state, revision: 4 } }],
    ["verification pending", { ...receipt(), state: { ...receipt().state, verificationPending: true } }],
    ["inconsistent count", { ...receipt(), state: { ...receipt().state, observedCount: 1 } }],
    ["incomplete proof", { ...receipt(), state: { ...receipt().state, sourceFollowerCount: 3 } }],
  ])("rejects %s", (_name, checkpoint) => {
    expect(readFollowersReconcileCompletion(checkpoint, 3, at)).toBeNull();
  });
  it("rejects a completion from the future", () => {
    expect(readFollowersReconcileCompletion(receipt(), 3, new Date(at.getTime() - 1))).toBeNull();
  });
});
