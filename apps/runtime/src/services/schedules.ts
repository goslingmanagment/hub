import { ensureOfapiMediaQueue, ensureOfapiMediaSchedule } from "./ofapi-media-worker.ts";
import { ensureOfapiCollectionQueues, ensureOfapiCollectionSchedules } from "./ofapi-collection-runner.ts";
import { ensureOfapiTypedExportQueue, ensureOfapiTypedExportSchedule } from "./ofapi-typed-export-worker.ts";
import type { PgBoss } from "pg-boss";

import { ensureAgentHydrationQueue, ensureAgentHydrationSchedule } from "./agent-hydration.ts";
import { ensureCanonicalizeQueues, ensureCanonicalizeSchedule } from "./canonicalize-driver.ts";
import { ensureOpsMetricsQueue, ensureOpsMetricsSchedule } from "./golden-signals.ts";
import { ensureTieringQueue, ensureTieringSchedule } from "./tiering/index.ts";
import { ensureDbDiskUsageQueue, ensureDbDiskUsageSchedule } from "./db-disk-alert.ts";
import { ensureObservationsPartitionQueue, ensureObservationsPartitionSchedule } from "./observations-partitions.ts";
import { ensureCapturePayloadParityQueue, ensureCapturePayloadParitySchedule } from "./capture-payload-parity.ts";
import { ensureOfapiChargebacksQueue, ensureOfapiChargebacksSchedule } from "./ofapi-chargebacks-sync.ts";
import { ensureOfapiLinkStatsQueue, ensureOfapiLinkStatsSchedule } from "./ofapi-link-stats-sync.ts";
import { ensureOfapiCommandQueues, ensureOfapiCommandSchedules } from "./ofapi-command-executor.ts";
import { ensureOfapiPendingReconcileQueue, ensureOfapiPendingReconcileSchedule } from "./ofapi-pending-reconcile.ts";
import { ensureOfapiCreditQueues, ensureOfapiCreditSchedules } from "./ofapi-credits.ts";
import { ensureOfapiDmAnalyticsQueues, ensureOfapiDmAnalyticsSchedules } from "./ofapi-dm-analytics.ts";
import { ensureOfapiQueues, ensureOfapiSchedules } from "./ofapi-events.ts";
import { ensureMessageArchiveQueues, ensureMessageArchiveSchedule } from "./projections/message-archive.ts";
import { ensureProjectionDebtQueue, ensureProjectionDebtSchedule } from "./projection-debt-sweep.ts";
import { ensureVoiceNotesSweepQueue, ensureVoiceNotesSweepSchedule } from "./voice-notes-sweep.ts";
import {
  ensureNotificationDeliveryOutboxQueue,
  ensureNotificationDeliveryOutboxSchedule,
} from "./notification-delivery-outbox.ts";
import {
  RAW_PAYLOAD_CLEANUP_QUEUE,
  ensurePlannerSchedule,
  ensureSyncQueues,
  ensureTelegramDailyReportSchedule,
  reconcileQueueRetention,
} from "./sync-queue.ts";

// Kernel Stage 25: the ONE place cron registrations live. Called from the
// scheduler role only (leader-elected) — workers and the api run pg-boss with
// `schedule: false`, so they neither register nor fire cron. Registrations
// are idempotent upserts; re-running on every leader takeover is the design.
// Queue creation runs first (also idempotent) so a scheduler booting into a
// fresh environment never schedules into a queue no worker has created yet.

export async function registerAllSchedules(
  boss: Pick<PgBoss, "schedule" | "createQueue" | "getQueue" | "updateQueue">,
): Promise<void> {
  const createdQueues = new Set<string>();
  await ensureSyncQueues(boss, createdQueues);
  await ensureOfapiQueues(boss, createdQueues);
  await ensureOfapiCreditQueues(boss, createdQueues);
  await ensureOfapiChargebacksQueue(boss, createdQueues);
  await ensureOfapiLinkStatsQueue(boss, createdQueues);
  await ensureOfapiPendingReconcileQueue(boss, createdQueues);
  await ensureOfapiCommandQueues(boss, createdQueues);
  await ensureOfapiDmAnalyticsQueues(boss, createdQueues);
  await ensureOfapiTypedExportQueue(boss, createdQueues);
  await ensureOfapiMediaQueue(boss, createdQueues);
  await ensureOfapiCollectionQueues(boss, createdQueues);
  await ensureDbDiskUsageQueue(boss, createdQueues);
  await ensureObservationsPartitionQueue(boss, createdQueues);
  await ensureCapturePayloadParityQueue(boss, createdQueues);
  await ensureCanonicalizeQueues(boss, createdQueues);
  await ensureMessageArchiveQueues(boss, createdQueues);
  await ensureProjectionDebtQueue(boss, createdQueues);
  await ensureVoiceNotesSweepQueue(boss, createdQueues);
  await ensureOpsMetricsQueue(boss, createdQueues);
  await ensureNotificationDeliveryOutboxQueue(boss, createdQueues);
  await ensureTieringQueue(boss, createdQueues);
  await ensureAgentHydrationQueue(boss, createdQueues);
  // S7: LAST, after every queue above exists — updateQueue on a queue that has
  // not been created yet matches zero rows.
  await reconcileQueueRetention(boss);
  await Promise.all([
    ensurePlannerSchedule(boss),
    boss.schedule(RAW_PAYLOAD_CLEANUP_QUEUE, "0 2 * * *"),
    ensureTelegramDailyReportSchedule(boss),
    ensureOfapiSchedules(boss),
    ensureOfapiCreditSchedules(boss),
    ensureOfapiChargebacksSchedule(boss),
    ensureOfapiLinkStatsSchedule(boss),
    ensureOfapiPendingReconcileSchedule(boss),
    ensureOfapiCommandSchedules(boss),
    ensureOfapiDmAnalyticsSchedules(boss),
    ensureOfapiTypedExportSchedule(boss),
    ensureOfapiMediaSchedule(boss),
    ensureOfapiCollectionSchedules(boss),
    ensureDbDiskUsageSchedule(boss),
    ensureObservationsPartitionSchedule(boss),
    ensureCapturePayloadParitySchedule(boss),
    ensureCanonicalizeSchedule(boss),
    ensureMessageArchiveSchedule(boss),
    ensureProjectionDebtSchedule(boss),
    ensureVoiceNotesSweepSchedule(boss),
    ensureOpsMetricsSchedule(boss),
    ensureNotificationDeliveryOutboxSchedule(boss),
    ensureTieringSchedule(boss),
    ensureAgentHydrationSchedule(boss),
  ]);
}
