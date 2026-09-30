import { describe, expect, it } from "vitest";

import {
  FOLLOWERS_RECONCILE_FLOOR_DEFERRAL,
  FOLLOWERS_RECONCILE_MIN_INTERVAL_MS,
  followersReconcileFloor,
  followersReconcileFloorWaitUntil,
  followersReconcileQueuedSince,
} from "../apps/runtime/src/services/sync/followers-reconcile-floor.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);
const dayAfter = (value: Date) => new Date(value.getTime() + 24 * HOUR_MS);

function completedWalk(revision: number, startedAt: Date | string) {
  return {
    revision, generation: 40,
    fullSweepStartedAt: typeof startedAt === "string" ? startedAt : startedAt.toISOString(),
    offset: 0, observedCount: 10, pageCount: 1, sourceFollowerCount: 10,
    snapshotRestartCount: 0, restartReason: null, verificationPending: false,
  };
}

describe("followers reconcile daily floor", () => {
  it("is one day, named by its deferral marker", () => {
    expect(FOLLOWERS_RECONCILE_MIN_INTERVAL_MS).toBe(24 * HOUR_MS);
    expect(FOLLOWERS_RECONCILE_FLOOR_DEFERRAL).toBe("followers_reconcile_min_interval");
  });

  it.each(["anomaly", "scheduled", "recovery", null] as const)(
    "holds a %s request until a day after the last walk began",
    (requestSource) => {
      expect(followersReconcileFloor({
        checkpointState: completedWalk(7, hoursAgo(23)), requestSeq: 8, requestSource,
        succeededAt: hoursAgo(22), now: NOW,
      })).toEqual({ until: dayAfter(hoursAgo(23)), anchor: hoursAgo(23) });
    },
  );

  it.each([24, 25, 72])("lets a request through %s hours after the last walk began", (hours) => {
    expect(followersReconcileFloor({
      checkpointState: completedWalk(7, hoursAgo(hours)), requestSeq: 8, requestSource: "anomaly",
      succeededAt: hoursAgo(hours - 1), now: NOW,
    })).toBeNull();
  });

  it.each(["manual", "reset", "onboarding"] as const)("lets an explicit %s request through", (requestSource) => {
    expect(followersReconcileFloor({
      checkpointState: completedWalk(7, hoursAgo(1)), requestSeq: 8, requestSource,
      succeededAt: hoursAgo(1), now: NOW,
    })).toBeNull();
  });

  it("never holds the request whose walk already began, such as a snapshot restart", () => {
    const restartMarker = { revision: 8, generation: 41, snapshotRestartCount: 1, restartReason: "snapshot_mismatch" };
    expect(followersReconcileFloor({
      checkpointState: restartMarker, requestSeq: 8, requestSource: "anomaly", succeededAt: hoursAgo(2), now: NOW,
    })).toBeNull();
    expect(followersReconcileFloor({
      checkpointState: completedWalk(8, hoursAgo(1)), requestSeq: 8, requestSource: "anomaly",
      succeededAt: hoursAgo(1), now: NOW,
    })).toBeNull();
  });

  it.each([
    ["an older restart marker", { revision: 7, generation: 41, restartReason: "snapshot_mismatch" }],
    ["an unreadable sweep start", completedWalk(7, "not-a-time")],
    ["a legacy cursor without a revision", { generation: 41 }],
  ])("falls back to the last success behind %s", (_name, checkpointState) => {
    expect(followersReconcileFloor({
      checkpointState, requestSeq: 8, requestSource: "anomaly", succeededAt: hoursAgo(3), now: NOW,
    })).toEqual({ until: dayAfter(hoursAgo(3)), anchor: hoursAgo(3) });
  });

  it("does not hold a page with no walk to anchor on", () => {
    expect(followersReconcileFloor({
      checkpointState: null, requestSeq: 1, requestSource: "recovery", succeededAt: null, now: NOW,
    })).toBeNull();
  });

  it("never holds for longer than a day from now, whatever the stored clock says", () => {
    const future = new Date(NOW.getTime() + 2 * HOUR_MS);
    expect(followersReconcileFloor({
      checkpointState: completedWalk(7, future), requestSeq: 8, requestSource: "anomaly", succeededAt: null, now: NOW,
    })).toEqual({ until: dayAfter(NOW), anchor: NOW });
  });
});

describe("reading a request the floor holds", () => {
  const retryAt = new Date(NOW.getTime() + 10 * HOUR_MS);
  const held = {
    stream: "followers_reconcile" as const, status: "pending" as const, requestSeq: 8, appliedSeq: 7, retryAt,
  };
  const marker = { followersReconcileFloorUntil: retryAt.toISOString(), followersReconcileFloorAnchor: "x" };

  it("reads the held request's own retry deadline as the floor's end", () => {
    expect(followersReconcileFloorWaitUntil(held, marker, NOW)).toEqual(retryAt);
  });

  it.each([
    ["another stream", { ...held, stream: "followers" as const }, marker],
    ["a running walk", { ...held, status: "running" as const }, marker],
    ["a retrying failure", { ...held, status: "retrying" as const }, marker],
    ["nothing outstanding", { ...held, appliedSeq: 8 }, marker],
    ["a passed deadline", { ...held, retryAt: hoursAgo(0.1) }, marker],
    ["a cleared deadline, as a manual request leaves it", { ...held, retryAt: null }, marker],
    ["a deadline that is not the floor's", held, { generation: 41, pageCount: 3 }],
    ["no progress at all", held, null],
  ])("reads %s as ordinary work", (_name, row, progress) => {
    expect(followersReconcileFloorWaitUntil(row, progress, NOW)).toBeNull();
  });
});

describe("when a followers_reconcile request was last queued", () => {
  it("counts from the latest of the request, the last lease and a waited-out deadline", () => {
    expect(followersReconcileQueuedSince({
      requestedAt: hoursAgo(23), startedAt: hoursAgo(0.5), retryAt: null,
    })).toEqual(hoursAgo(0.5));
    expect(followersReconcileQueuedSince({
      requestedAt: hoursAgo(23), startedAt: hoursAgo(22.9), retryAt: hoursAgo(0.2),
    })).toEqual(hoursAgo(0.2));
    expect(followersReconcileQueuedSince({
      requestedAt: hoursAgo(1), startedAt: null, retryAt: null,
    })).toEqual(hoursAgo(1));
    expect(followersReconcileQueuedSince({ requestedAt: null, startedAt: null, retryAt: null })).toBeNull();
  });
});
