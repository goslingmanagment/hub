import type { PageSyncStatus, SyncRequestSource, SyncStream } from "@agency_hub_core/db";

import { asNumber, asRecord } from "./cursor-state.ts";

/** Owner policy: a full followers walk starts at most once a day on every
 *  page. The walk's two-walk grace is unchanged, so an unfollow shows 24-48 h
 *  after it happens instead of within a few hours. */
export const FOLLOWERS_RECONCILE_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** StreamChunkResult.deferral of a chunk the floor held, and the status reason
 *  code the readers report for the held request. */
export const FOLLOWERS_RECONCILE_FLOOR_DEFERRAL = "followers_reconcile_min_interval";

// An owner's explicit ask is served at once; only the automatic triggers
// (hourly count mismatch, the 48 h slot, a seeding recovery) wait.
const UNFLOORED_SOURCES: ReadonlySet<SyncRequestSource> = new Set(["manual", "reset", "onboarding"]);

function parseTime(value: unknown) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
}

/** When a fresh walk for `requestSeq` may start, if not now. The anchor is the
 *  start of the last walk the checkpoint holds, or the stream's last success
 *  when it holds none. A checkpoint of this very request means its walk
 *  already began (a snapshot restart), which the floor never holds. */
export function followersReconcileFloor(input: {
  checkpointState: unknown;
  requestSeq: number;
  requestSource: SyncRequestSource | null;
  succeededAt: Date | null;
  now: Date;
}): { until: Date; anchor: Date } | null {
  if (input.requestSource !== null && UNFLOORED_SOURCES.has(input.requestSource)) return null;
  const state = asRecord(input.checkpointState);
  const revision = asNumber(state?.revision);
  if (revision !== null && revision >= input.requestSeq) return null;
  const stored = parseTime(state?.fullSweepStartedAt) ?? input.succeededAt;
  if (!stored) return null;
  // A clock ahead of ours must not stretch the hold past one interval.
  const anchor = new Date(Math.min(stored.getTime(), input.now.getTime()));
  const until = new Date(anchor.getTime() + FOLLOWERS_RECONCILE_MIN_INTERVAL_MS);
  return until.getTime() > input.now.getTime() ? { until, anchor } : null;
}

/** The end of the floor an outstanding followers_reconcile request is waiting
 *  out, or null when the row is ordinary work. `marker` is the held chunk's
 *  stats (the row's progress, or its sync run's stats). The row's own live
 *  retry_at is the deadline, so a manual request, which clears it, and a walk
 *  that has begun both read as ordinary work again. */
export function followersReconcileFloorWaitUntil(
  row: {
    stream: SyncStream;
    status: PageSyncStatus | null;
    requestSeq: number | null;
    appliedSeq: number | null;
    retryAt: Date | null;
  },
  marker: unknown,
  now: Date,
): Date | null {
  if (row.stream !== "followers_reconcile" || row.status !== "pending") return null;
  if (row.requestSeq === null || row.appliedSeq === null || row.requestSeq <= row.appliedSeq) return null;
  if (row.retryAt === null || row.retryAt.getTime() <= now.getTime()) return null;
  return parseTime(asRecord(marker)?.followersReconcileFloorUntil) ? row.retryAt : null;
}

/** When a followers_reconcile request last became runnable: the planner's own
 *  clock (pageSyncRunnableSinceSql). The floor holds a request up to a day, so
 *  its request time would read the walk after it, gaps between its chunks
 *  included, as a day-long queue wait. */
export function followersReconcileQueuedSince(row: {
  requestedAt: Date | null;
  startedAt: Date | null;
  retryAt: Date | null;
}): Date | null {
  let latest: Date | null = null;
  for (const value of [row.requestedAt, row.startedAt, row.retryAt]) {
    if (value && (!latest || value.getTime() > latest.getTime())) latest = value;
  }
  return latest;
}
