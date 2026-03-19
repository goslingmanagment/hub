import {
  ensureSyncStreamStateRows,
  listRunnableSyncPages,
  markSyncPageWakeupEnqueued,
  promoteDueSyncStreamStateRows,
} from "@agency_hub_core/db";
import { buildProxyEgressKey } from "@agency_hub_core/shared";
import type { PgBoss } from "pg-boss";

import type { AppContext } from "../../bootstrap.ts";
import { sendSyncPageWakeup } from "../sync-queue.ts";

export async function runSyncPlannerCycle(
  app: AppContext,
  boss: Pick<PgBoss, "send">,
  now = new Date(),
) {
  await ensureSyncStreamStateRows(app.db, { now });
  await promoteDueSyncStreamStateRows(app.db, now);

  const runnablePages = await listRunnableSyncPages(app.db, now);
  for (const page of runnablePages) {
    const wakeupId = await sendSyncPageWakeup(boss, {
      platformAccountId: page.platformAccountId,
      priority: page.priority,
      provider: page.platform,
      egressKey: buildProxyEgressKey(page.proxyUrl ? { url: page.proxyUrl } : null),
    });

    if (wakeupId) {
      await markSyncPageWakeupEnqueued(app.db, page.platformAccountId, now);
    }
  }

  return runnablePages;
}
