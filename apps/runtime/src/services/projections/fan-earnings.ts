// fan_earnings_stats projection (Stage 16 v3). Consumes fan.earnings_observed
// events behind the standard per-account seq watermark (Stage 10 pattern);
// rebuildable by projection:rebuild fan_earnings_stats. Fan identity rows are
// upserted on demand — the event carries the platform-native fan id only.

import {
  getProjectionWatermark,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  upsertFanEarningsStat,
  upsertFans,
} from "@agency_hub_core/db";
import { sql } from "drizzle-orm";

import type { AppContext } from "../../bootstrap.ts";

export const FAN_EARNINGS_PROJECTION = "fan_earnings_stats";

const EVENT_PAGE_SIZE = 500;

export interface FanEarningsProjectionResult {
  accounts: number;
  eventsSeen: number;
  upserted: number;
}

export async function runFanEarningsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanEarningsProjectionResult> {
  const totals: FanEarningsProjectionResult = { accounts: 0, eventsSeen: 0, upserted: 0 };
  const accounts = input?.accountId != null
    ? [input.accountId]
    : await listEventAccounts(app.db);

  for (const accountId of accounts) {
    totals.accounts += 1;
    let watermark = await getProjectionWatermark(app.db, FAN_EARNINGS_PROJECTION, accountId);
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: EVENT_PAGE_SIZE,
      });
      if (events.length === 0) {
        break;
      }
      totals.eventsSeen += events.length;

      for (const event of events) {
        if (event.type !== "fan.earnings_observed" || !event.fanIdentityRef) {
          continue;
        }
        const data = (typeof event.data === "object" && event.data !== null
          ? event.data
          : {}) as Record<string, unknown>;
        const window = typeof data.window === "string" ? data.window : "lifetime";
        const grossMills = typeof data.grossMills === "number" ? Math.trunc(data.grossMills) : 0;
        const netMills = typeof data.netMills === "number" ? Math.trunc(data.netMills) : null;
        const [fan] = await upsertFans(app.db, [{
          platform: "fansly",
          platformUserId: event.fanIdentityRef,
        }]);
        await upsertFanEarningsStat(app.db, {
          accountId,
          fanId: fan!.id,
          window,
          grossMills,
          netMills,
          observedAt: event.occurredAt,
          sourceEventId: event.id,
        });
        totals.upserted += 1;
      }
      watermark = events[events.length - 1]!.accountSeq;
      await setProjectionWatermark(app.db, FAN_EARNINGS_PROJECTION, accountId, watermark);
      if (events.length < EVENT_PAGE_SIZE) {
        break;
      }
    }
  }
  return totals;
}

/** One-command rebuild: truncate scope + reset watermark + replay.
 * The two deletes run in ONE transaction (A37, decision #134): a crash
 * between them would otherwise leave an empty projection behind a stale
 * high watermark — permanently and silently empty, the same failure the
 * sibling resetMessageArchiveProjection already guards against. */
export async function rebuildFanEarningsProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
): Promise<FanEarningsProjectionResult> {
  await app.db.transaction(async (tx) => {
    if (input?.accountId != null) {
      await tx.execute(sql`delete from fan_earnings_stats where account_id = ${input.accountId}`);
      await tx.execute(sql`
        delete from projection_seq_watermarks
        where projection = ${FAN_EARNINGS_PROJECTION} and account_id = ${input.accountId}
      `);
    } else {
      await tx.execute(sql`delete from fan_earnings_stats`);
      await tx.execute(sql`
        delete from projection_seq_watermarks where projection = ${FAN_EARNINGS_PROJECTION}
      `);
    }
  });
  return runFanEarningsProjection(app, input);
}
