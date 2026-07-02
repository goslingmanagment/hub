import {
  closeInactiveSyncRuns,
  ensurePageSyncStates,
  listRunnablePageSync,
  markPageSyncEnqueued,
  scheduleDuePageSync,
} from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { sendSyncPageWakeup } from "../sync-queue.ts";
import { pageSyncDependencyInput } from "./dependencies.ts";
import { pauseDisabledOnlyFansAudienceForAllPages } from "./ofapi-audience-sync.ts";
import { pauseDisabledOnlyFansDmPollingForAllPages } from "./onlyfans-dm-polling.ts";
import { pauseDisabledOnlyFansTopSpendersForAllPages } from "./onlyfans-top-spenders.ts";

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

  const dependencyInput = pageSyncDependencyInput(app);
  await ensurePageSyncStates(app.db, { now, ...dependencyInput });
  const pausedOnlyFansDmPages = await pauseDisabledOnlyFansDmPollingForAllPages(app, now);
  if (pausedOnlyFansDmPages > 0) {
    app.logger.warn({
      pausedOnlyFansDmPages,
    }, "Paused OnlyFans DM polling because ONLYFANS_DM_POLLING_ENABLED is false");
  }
  const pausedOnlyFansAudiencePages = await pauseDisabledOnlyFansAudienceForAllPages(app, now);
  if (pausedOnlyFansAudiencePages > 0) {
    app.logger.warn({
      pausedOnlyFansAudiencePages,
    }, "Paused OnlyFans audience sync for pages not eligible under OFAPI_AUDIENCE_SYNC_ENABLED");
  }
  const pausedOnlyFansTopSpenderPages = await pauseDisabledOnlyFansTopSpendersForAllPages(app, now);
  if (pausedOnlyFansTopSpenderPages > 0) {
    app.logger.warn({
      pausedOnlyFansTopSpenderPages,
    }, "Paused OnlyFans top spenders because ONLYFANS_TOP_SPENDERS_ENABLED is false");
  }
  await scheduleDuePageSync(app.db, { now, ...dependencyInput });

  const runnablePages = await listRunnablePageSync(app.db, now);
  for (const page of runnablePages) {
    const wakeupId = await sendSyncPageWakeup(boss, {
      platformAccountId: page.pageId,
      priority: page.priority,
      provider: page.platform,
      egressKey: page.egressKey,
    });

    if (wakeupId) {
      await markPageSyncEnqueued(app.db, page.pageId, now);
    }
  }

  return runnablePages;
}
