import { rebuildDmMessageDailyAggregates } from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OFAPI_DM_ANALYTICS_REBUILD_QUEUE = "ofapi.dm-analytics.rebuild";
export const OFAPI_DM_ANALYTICS_ROLLING_DAYS = 32;

function toUtcBusinessDate(value: Date) {
  return value.toISOString().slice(0, 10);
}

export function resolveDmAnalyticsRebuildWindow(
  now: Date,
  rollingDays = OFAPI_DM_ANALYTICS_ROLLING_DAYS,
) {
  if (!Number.isInteger(rollingDays) || rollingDays < 1) {
    throw new Error("rollingDays must be a positive integer");
  }
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - (rollingDays - 1));
  return {
    fromBusinessDate: toUtcBusinessDate(from),
    throughBusinessDate: toUtcBusinessDate(now),
  };
}

export async function rebuildRecentDmAnalytics(app: AppContext, now = new Date()) {
  return rebuildDmMessageDailyAggregates(app.db, {
    ...resolveDmAnalyticsRebuildWindow(now),
    rebuiltAt: now,
  });
}

export async function ensureOfapiDmAnalyticsQueues(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, OFAPI_DM_ANALYTICS_REBUILD_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureOfapiDmAnalyticsSchedules(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(OFAPI_DM_ANALYTICS_REBUILD_QUEUE, "10 * * * *", null, { tz: "UTC" });
}

export async function startOfapiDmAnalyticsWorker(
  app: AppContext,
  boss: Pick<PgBoss, "work">,
) {
  await boss.work(OFAPI_DM_ANALYTICS_REBUILD_QUEUE, { batchSize: 1 }, async () => {
    const result = await rebuildRecentDmAnalytics(app);
    app.logger.info({
      fromBusinessDate: result.fromBusinessDate,
      throughBusinessDate: result.throughBusinessDate,
      aggregateRows: result.rowCount,
    }, "OFAPI DM daily analytics rebuild complete");
  });
}
