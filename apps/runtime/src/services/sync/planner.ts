import {
  closeInactiveSyncRuns,
  ensurePageSyncStates,
  findPageById,
  listRunnableOfapiCapturePages,
  listRunnablePageSync,
  markPageSyncEnqueued,
  recoverStaleOfapiCaptureWork,
  retireLegacyOnlyFansDmMessages,
  scheduleDuePageSync,
} from "@agency_hub_core/db";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { sendSyncPageWakeup } from "../sync-queue.ts";
import { isOfapiBackgroundCaptureRunnable } from "../ofapi-capture-jobs.ts";
import { resolveStoredProxyEgressKey } from "../page-context.ts";
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
  const retiredOnlyFansDmRows = await retireLegacyOnlyFansDmMessages(app.db, now);
  if (retiredOnlyFansDmRows > 0) {
    app.logger.warn({
      retiredOnlyFansDmRows,
    }, "Permanently parked legacy OnlyFans dm_messages rows");
  }
  const pausedOnlyFansDmPages = await pauseDisabledOnlyFansDmPollingForAllPages(app, now);
  if (pausedOnlyFansDmPages > 0) {
    app.logger.warn({ pausedOnlyFansDmPages },
      "Paused legacy OnlyFans dm_conversations polling because ONLYFANS_DM_POLLING_ENABLED is false");
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
  const pageWork = new Map<number, {
    pageId: number;
    platform: "fansly" | "onlyfans";
    priority: number;
    requestedAt: Date;
    egressKey: string;
    hasLegacyWork: boolean;
  }>();
  for (const page of runnablePages) {
    pageWork.set(page.pageId, {
      pageId: page.pageId,
      platform: page.platform,
      priority: page.priority,
      requestedAt: page.requestedAt ?? now,
      egressKey: page.egressKey,
      hasLegacyWork: true,
    });
  }

  // Recovery never calls the vendor and must remain live while dispatch is
  // disabled. Otherwise a kill switch could strand financial reservations or
  // leave an already-dispatched attempt looking safely retryable.
  const recovered = await recoverStaleOfapiCaptureWork(app.db, { now });
  if (recovered.released + recovered.indeterminate + recovered.requeued > 0) {
    app.logger.warn(recovered, "Recovered expired OFAPI capture work");
  }

  if (isOfapiBackgroundCaptureRunnable(app.config)) {
    const capturePages = await listRunnableOfapiCapturePages(app.db, { now });
    for (const capture of capturePages) {
      const existing = pageWork.get(capture.pageId);
      if (existing) {
        existing.priority = Math.max(existing.priority, capture.priority);
        existing.requestedAt = existing.requestedAt <= capture.requestedAt
          ? existing.requestedAt
          : capture.requestedAt;
        continue;
      }
      const stored = await findPageById(app.db, capture.pageId);
      if (!stored || stored.page.platform !== "onlyfans") {
        continue;
      }
      pageWork.set(capture.pageId, {
        pageId: capture.pageId,
        platform: "onlyfans",
        priority: capture.priority,
        requestedAt: capture.requestedAt,
        egressKey: resolveStoredProxyEgressKey(stored.proxy),
        hasLegacyWork: false,
      });
    }
  }

  const orderedWork = [...pageWork.values()].sort((left, right) =>
    right.priority - left.priority ||
    left.requestedAt.getTime() - right.requestedAt.getTime() ||
    left.pageId - right.pageId);
  for (const page of orderedWork) {
    const wakeupId = await sendSyncPageWakeup(boss, {
      platformAccountId: page.pageId,
      priority: page.priority,
      provider: page.platform,
      egressKey: page.egressKey,
    });

    if (wakeupId && page.hasLegacyWork) {
      await markPageSyncEnqueued(app.db, page.pageId, now);
    }
  }

  return runnablePages;
}
