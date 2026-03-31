import {
  closeInactiveSyncRuns,
  ensureSyncTaskRows,
  listRunnableSyncPagesV2,
  markSyncTaskWakeupEnqueued,
  scheduleDueSyncTasks,
} from "@agency_hub_core/db";
import { buildProxyEgressKey } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { sendSyncPageWakeup } from "../sync-queue.ts";

const INACTIVE_SYNC_RUN_THRESHOLD_MS = 90 * 1000;
const INACTIVE_SYNC_RUN_ERROR_SUMMARY = "Sync run auto-closed after inactivity";

export async function runSyncPlannerCycle(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  now = new Date(),
) {
  const inactiveRuns = await closeInactiveSyncRuns(app.db, {
    inactiveBefore: new Date(now.getTime() - INACTIVE_SYNC_RUN_THRESHOLD_MS),
    finishedAt: now,
    errorSummary: INACTIVE_SYNC_RUN_ERROR_SUMMARY,
  });

  if (inactiveRuns.totalCount > 0) {
    app.logger.info({
      finishedAt: now,
      inactiveRunTotal: inactiveRuns.totalCount,
      inactiveRunFailed: inactiveRuns.failedCount,
      inactiveRunPartial: inactiveRuns.partialCount,
    }, "Inactive sync run cleanup complete");
  }

  await ensureSyncTaskRows(app.db, { now });
  await scheduleDueSyncTasks(app.db, { now });

  const runnablePages = await listRunnableSyncPagesV2(app.db, now);
  for (const page of runnablePages) {
    const wakeupId = await sendSyncPageWakeup(boss, {
      platformAccountId: page.platformAccountId,
      priority: page.priority,
      provider: page.platform,
      egressKey: buildProxyEgressKey(page.proxyUrl ? { url: page.proxyUrl } : null),
    });

    if (wakeupId) {
      await markSyncTaskWakeupEnqueued(app.db, page.platformAccountId, now);
    }
  }

  return runnablePages;
}
