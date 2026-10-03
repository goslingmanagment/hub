import type { PageSyncStatus, SyncStream } from "@agency_hub_core/db";

import { asRecord } from "./cursor-state.ts";

// The status readers' view of a legacy followers_reconcile row its daily floor
// held. The legacy chunk handler that applied the floor is deleted since
// step 4 (S4-17); the engine's walk keeps its own floor
// (sync/fansly/resources/followers.ts).

/** The deferral the legacy chunk recorded when the floor held it, and the
 *  status reason code the readers report for the held request. */
export const FOLLOWERS_RECONCILE_FLOOR_DEFERRAL = "followers_reconcile_min_interval";

function parseTime(value: unknown) {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time) : null;
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
