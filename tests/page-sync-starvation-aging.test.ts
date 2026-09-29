import { describe, expect, it, vi } from "vitest";

import {
  acquirePageSyncLease,
  resolvePageSyncPriority,
  SYNC_STARVATION_AGING_SOURCES,
  SYNC_STREAM_POLICY,
  SYNC_STREAM_STARVED_PRIORITY,
  SYNC_STREAMS,
  type SyncRequestSource,
  type SyncStream,
} from "../packages/db/src/repositories/page-sync.ts";
import { type SQL } from "../packages/db/node_modules/drizzle-orm/index.js";
import { PgDialect } from "../packages/db/node_modules/drizzle-orm/pg-core/index.js";

const OPERATOR_SOURCES: SyncRequestSource[] = ["manual", "onboarding", "reset"];
const BULK_LANES: SyncStream[] = ["catalog", "post_replies", "payouts", "media_stats"];
const agedStreams = SYNC_STREAMS.filter((stream) => SYNC_STREAM_STARVED_PRIORITY[stream] !== undefined);

function starvedPriority(stream: SyncStream) {
  const priority = SYNC_STREAM_STARVED_PRIORITY[stream];
  if (priority === undefined) throw new Error(`${stream} is not aged`);
  return priority;
}

describe("page sync starvation aging policy", () => {
  it("ages exactly the background lanes a dm_messages drain starves", () => {
    expect(agedStreams).toEqual([
      "fan_earnings",
      "purchase_history",
      "posts",
      "stats_snapshot",
      "notifications",
      "catalog",
      "post_replies",
      "payouts",
      "media_stats",
    ]);
    const drain = resolvePageSyncPriority("dm_messages", "scheduled");
    for (const stream of agedStreams) {
      // Below the drain on its own, above it once starved.
      expect(resolvePageSyncPriority(stream, "scheduled")).toBeLessThan(drain);
      expect(starvedPriority(stream)).toBeGreaterThan(drain);
      expect(starvedPriority(stream)).toBeGreaterThan(resolvePageSyncPriority("dm_messages", "event"));
    }
    // Never a DM fairness peer, so aging cannot lift followers_reconcile or a DM lane.
    for (const peer of ["followers_reconcile", "dm_conversations", "dm_messages"] as const) {
      expect(SYNC_STREAM_STARVED_PRIORITY[peer]).toBeUndefined();
    }
  });

  it("promotes background dispatches only, always below operator work", () => {
    expect([...SYNC_STARVATION_AGING_SOURCES].sort()).toEqual(["anomaly", "event", "recovery", "scheduled"]);
    const lowestOperatorPriority = Math.min(...SYNC_STREAMS.flatMap((stream) =>
      OPERATOR_SOURCES.map((source) => resolvePageSyncPriority(stream, source))));
    for (const stream of agedStreams) {
      expect(starvedPriority(stream)).toBeLessThan(lowestOperatorPriority);
    }
  });

  it("never ranks a starved bulk lane ahead of transactions or dm_conversations", () => {
    const lowestProtected = Math.min(...(["transactions", "dm_conversations"] as const).flatMap((stream) =>
      SYNC_STARVATION_AGING_SOURCES.map((source) => resolvePageSyncPriority(stream, source))));
    for (const stream of BULK_LANES) {
      expect(starvedPriority(stream)).toBeLessThan(lowestProtected);
    }
  });

  it("uses each lane's own queueDelayThresholdMs as the starvation limit", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await acquirePageSyncLease({ execute } as never, {
      pageId: 55,
      workerId: "worker-1",
      leaseToken: "lease-1",
      leaseTtlMs: 60_000,
      now: new Date("2026-09-28T12:00:00.000Z"),
    });
    const statement = new PgDialect().sqlToQuery(execute.mock.calls[0]![0] as SQL).sql;
    for (const stream of agedStreams) {
      expect(statement).toContain(
        `when '${stream}' then ${SYNC_STREAM_POLICY[stream].queueDelayThresholdMs} * interval '1 millisecond'`,
      );
      expect(statement).toContain(`when '${stream}' then ${starvedPriority(stream)}`);
    }
    expect(SYNC_STREAM_POLICY.notifications.queueDelayThresholdMs).toBe(30 * 60_000);
    expect(SYNC_STREAM_POLICY.media_stats.queueDelayThresholdMs).toBe(6 * 60 * 60_000);
  });
});
