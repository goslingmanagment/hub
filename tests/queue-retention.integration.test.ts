import { ensureOfapiCollectionQueues } from "../apps/runtime/src/services/ofapi-collection-runner.ts";
import { ensureOfapiMediaQueue } from "../apps/runtime/src/services/ofapi-media-worker.ts";
import { ensureOfapiTypedExportQueue } from "../apps/runtime/src/services/ofapi-typed-export-worker.ts";
import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";

import { PgBoss } from "pg-boss";

import { ensureAgentHydrationQueue } from "../apps/runtime/src/services/agent-hydration.ts";
import { ensureCanonicalizeQueues } from "../apps/runtime/src/services/canonicalize-driver.ts";
import { ensureCapturePayloadParityQueue } from "../apps/runtime/src/services/capture-payload-parity.ts";
import { ensureDbDiskUsageQueue } from "../apps/runtime/src/services/db-disk-alert.ts";
import { ensureOpsMetricsQueue } from "../apps/runtime/src/services/golden-signals.ts";
import { ensureNotificationDeliveryOutboxQueue } from "../apps/runtime/src/services/notification-delivery-outbox.ts";
import { ensureObservationsPartitionQueue } from "../apps/runtime/src/services/observations-partitions.ts";
import { ensureOfapiChargebacksQueue } from "../apps/runtime/src/services/ofapi-chargebacks-sync.ts";
import { ensureOfapiCommandQueues } from "../apps/runtime/src/services/ofapi-command-executor.ts";
import { ensureOfapiCreditQueues } from "../apps/runtime/src/services/ofapi-credits.ts";
import { ensureOfapiDmAnalyticsQueues } from "../apps/runtime/src/services/ofapi-dm-analytics.ts";
import { ensureOfapiQueues } from "../apps/runtime/src/services/ofapi-events.ts";
import { ensureOfapiLinkStatsQueue } from "../apps/runtime/src/services/ofapi-link-stats-sync.ts";
import { ensureOfapiPendingReconcileQueue } from "../apps/runtime/src/services/ofapi-pending-reconcile.ts";
import { ensureProjectionDebtQueue } from "../apps/runtime/src/services/projection-debt-sweep.ts";
import { ensureMessageArchiveQueues } from "../apps/runtime/src/services/projections/message-archive.ts";
import {
  DEFAULT_DELETE_AFTER_SECONDS,
  DEFAULT_RETENTION_SECONDS,
  HEARTBEAT_RETENTION_SECONDS,
  QUEUE_RETENTION_SETTINGS,
} from "../apps/runtime/src/services/queue-retention.ts";
import { ensureTargetedThreadBackfillQueue } from "../apps/runtime/src/services/sync/targeted-thread-backfill.ts";
import {
  ensureSyncQueues,
  reconcileQueueRetention,
} from "../apps/runtime/src/services/sync-queue.ts";
import { ensureTieringQueue } from "../apps/runtime/src/services/tiering/index.ts";
import { ensureVoiceNotesSweepQueue } from "../apps/runtime/src/services/voice-notes-sweep.ts";
import {
  resetIntegrationDatabase,
  startIntegrationTestDatabase,
  type StartedTestDatabase,
} from "./helpers/db.ts";

/** A value no default and no setting uses, so "untouched" is unambiguous. */
const DLQ_DELETION_SENTINEL = 123_456;

/**
 * Everything the three roles create between them (worker-services.ts +
 * services/schedules.ts). Queue creation is idempotent, so running the union
 * here is exactly what a boot does — minus the cron registrations.
 */
async function createAllQueues(boss: PgBoss) {
  await ensureSyncQueues(boss);
  await ensureOfapiQueues(boss);
  await ensureOfapiCreditQueues(boss);
  await ensureOfapiChargebacksQueue(boss);
  await ensureOfapiLinkStatsQueue(boss);
  await ensureOfapiPendingReconcileQueue(boss);
  await ensureOfapiCommandQueues(boss);
  await ensureOfapiDmAnalyticsQueues(boss);
  await ensureOfapiTypedExportQueue(boss);
  await ensureOfapiMediaQueue(boss);
  await ensureOfapiCollectionQueues(boss);
  await ensureDbDiskUsageQueue(boss);
  await ensureObservationsPartitionQueue(boss);
  await ensureCapturePayloadParityQueue(boss);
  await ensureCanonicalizeQueues(boss);
  await ensureMessageArchiveQueues(boss);
  await ensureProjectionDebtQueue(boss);
  await ensureVoiceNotesSweepQueue(boss);
  await ensureOpsMetricsQueue(boss);
  await ensureNotificationDeliveryOutboxQueue(boss);
  await ensureTieringQueue(boss);
  await ensureAgentHydrationQueue(boss);
  await ensureTargetedThreadBackfillQueue(boss);
}

/**
 * Put every queue back on pg-boss's library defaults — i.e. what production's
 * queues carry, since they were all created before the retention pin existed
 * and `createQueue` is INSERT ... ON CONFLICT DO NOTHING. Any implementation
 * that only passes retention at creation time cannot recover from this state.
 */
async function seedLibraryDefaults(boss: PgBoss) {
  for (const setting of QUEUE_RETENTION_SETTINGS) {
    await boss.updateQueue(setting.queue, {
      retentionSeconds: DEFAULT_RETENTION_SECONDS,
      deleteAfterSeconds: setting.retentionClass === "dead-letter"
        ? DLQ_DELETION_SENTINEL
        : DEFAULT_DELETE_AFTER_SECONDS,
    });
  }
}

describe("pg-boss queue retention integration", () => {
  let testDb: StartedTestDatabase | null = null;

  beforeAll(async () => {
    testDb = await startIntegrationTestDatabase();
  });

  afterAll(async () => {
    if (testDb) {
      await testDb.stop();
    }
  });

  beforeEach(async () => {
    if (!testDb) {
      return;
    }
    await resetIntegrationDatabase(testDb.pool);
  });

  it("moves pre-existing queues off library defaults, one per class", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString, schedule: false });
    await boss.start();
    try {
      await createAllQueues(boss);
      await seedLibraryDefaults(boss);

      // Guard: without this the test would pass against an implementation that
      // only sets retention at createQueue time.
      expect(await boss.getQueue("sync.planner")).toMatchObject({
        retentionSeconds: DEFAULT_RETENTION_SECONDS,
        deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
      });

      await reconcileQueueRetention(boss);

      // Class A — pure cron heartbeat.
      expect(await boss.getQueue("sync.planner")).toMatchObject({
        retentionSeconds: HEARTBEAT_RETENTION_SECONDS,
        deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS,
      });
      expect(await boss.getQueue("ops.metrics.sample")).toMatchObject({
        retentionSeconds: HEARTBEAT_RETENTION_SECONDS,
        deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS,
      });

      // Class B — real work; job rows are a forensics surface.
      expect(await boss.getQueue("sync.page.execute")).toMatchObject({
        retentionSeconds: DEFAULT_RETENTION_SECONDS,
        deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
      });

      // Class C — business cron; retention must clear a plausible outage.
      expect(await boss.getQueue("observations.partitions.ensure")).toMatchObject({
        retentionSeconds: DEFAULT_RETENTION_SECONDS,
        deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
      });

      // Class D — dead letter: retention pinned, deletion clock never declared,
      // so the sentinel survives untouched.
      expect(await boss.getQueue("sync.page.execute.dlq")).toMatchObject({
        retentionSeconds: DEFAULT_RETENTION_SECONDS,
        deleteAfterSeconds: DLQ_DELETION_SENTINEL,
      });
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it("pins queues created after ensureSyncQueues on a fresh database", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    // Regression: reconciling from inside ensureSyncQueues ran BEFORE the rest
    // of a role's ensure*Queues calls, and updateQueue matches zero rows for a
    // queue that does not exist yet — so on a fresh database every queue
    // created later stayed on library defaults. No seeding here: these queues
    // are genuinely newborn, which is the whole point.
    const boss = new PgBoss({ connectionString: testDb.connectionString, schedule: false });
    await boss.start();
    try {
      await createAllQueues(boss);

      expect(await boss.getQueue("canonicalize.sweep")).toMatchObject({
        retentionSeconds: DEFAULT_RETENTION_SECONDS,
        deleteAfterSeconds: DEFAULT_DELETE_AFTER_SECONDS,
      });

      await reconcileQueueRetention(boss);

      for (const queue of ["canonicalize.sweep", "agent.hydration.execute", "voice.notes.sweep"]) {
        expect(await boss.getQueue(queue), queue).toMatchObject({
          retentionSeconds: HEARTBEAT_RETENTION_SECONDS,
          deleteAfterSeconds: HEARTBEAT_RETENTION_SECONDS,
        });
      }
    } finally {
      await boss.stop({ graceful: false });
    }
  });

  it("pins every queue in the settings table, and both dead letters at 14d", async (context) => {
    if (!testDb) {
      context.skip();
      return;
    }

    const boss = new PgBoss({ connectionString: testDb.connectionString, schedule: false });
    await boss.start();
    try {
      await createAllQueues(boss);
      await seedLibraryDefaults(boss);
      await reconcileQueueRetention(boss);

      for (const setting of QUEUE_RETENTION_SETTINGS) {
        const queue = await boss.getQueue(setting.queue);
        // A name that no ensure*Queues function creates reads back null here —
        // this is what keeps the table's literals honest.
        expect(queue, `queue ${setting.queue} does not exist`).not.toBeNull();
        expect(queue, `queue ${setting.queue} retention`).toMatchObject({
          retentionSeconds: setting.retentionSeconds,
          ...(setting.deleteAfterSeconds === undefined
            ? {}
            : { deleteAfterSeconds: setting.deleteAfterSeconds }),
        });
      }

      for (const deadLetter of ["sync.planner.dlq", "sync.page.execute.dlq"]) {
        expect(await boss.getQueue(deadLetter)).toMatchObject({
          retentionSeconds: 1_209_600,
          deleteAfterSeconds: DLQ_DELETION_SENTINEL,
        });
      }
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});
