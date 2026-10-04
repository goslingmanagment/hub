import { describe, expect, it } from "vitest";

import {
  FOLLOWERS_RECONCILE_FLOOR_DEFERRAL,
  followersReconcileFloorWaitUntil,
  followersReconcileQueuedSince,
} from "../apps/runtime/src/services/sync/followers-reconcile-floor.ts";
import { FOLLOWERS_RECONCILE_MIN_INTERVAL_MS } from "../apps/runtime/src/sync/fansly/lib/audience-rules.ts";

const NOW = new Date("2026-09-30T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * HOUR_MS);

describe("followers reconcile daily floor", () => {
  it("is one day, named by its deferral marker", () => {
    expect(FOLLOWERS_RECONCILE_MIN_INTERVAL_MS).toBe(24 * HOUR_MS);
    expect(FOLLOWERS_RECONCILE_FLOOR_DEFERRAL).toBe("followers_reconcile_min_interval");
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
