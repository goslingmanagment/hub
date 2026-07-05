// Observations partition management (kernel Stage 7). Inserts into a missing
// partition fail loudly (webhook 5xx -> vendor retries; sync chunk retries) —
// never a silent drop — so the job's ONLY task is to make that situation
// impossible: pre-create partitions 3 months ahead daily, and page the owner
// through the incident layer when pre-creation fails or the lead shrinks
// below the floor.

import {
  ensureDomainEventPartitions,
  ensureObservationPartitions,
  getDomainEventPartitionLeadMonths,
  getObservationPartitionLeadMonths,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const OBSERVATIONS_PARTITIONS_QUEUE = "observations.partitions.ensure";

export const OBSERVATION_PARTITION_LEAD_TARGET_MONTHS = 3;
export const OBSERVATION_PARTITION_LEAD_FLOOR_MONTHS = 2;

export async function ensureObservationsPartitionQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, OBSERVATIONS_PARTITIONS_QUEUE, {
    policy: "standard",
  }, createdQueues);
}

export async function ensureObservationsPartitionSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Daily at 03:10 UTC, clear of the 02:00/02:30 cleanup slots and the
  // hourly :15 disk check.
  await boss.schedule(OBSERVATIONS_PARTITIONS_QUEUE, "10 3 * * *", null, { tz: "UTC" });
}

export async function runObservationsPartitionCheck(
  app: Pick<AppContext, "config" | "db" | "logger">,
  now = new Date(),
) {
  let ensured: string[] = [];
  let failure: unknown = null;
  try {
    ensured = await ensureObservationPartitions(app.db, {
      monthsAhead: OBSERVATION_PARTITION_LEAD_TARGET_MONTHS,
      now,
    });
    // Stage 8: the same job maintains the domain_events ledger's lead.
    ensured = ensured.concat(await ensureDomainEventPartitions(app.db, {
      monthsAhead: OBSERVATION_PARTITION_LEAD_TARGET_MONTHS,
      now,
    }));
  } catch (error) {
    failure = error;
    app.logger.warn({ err: error }, "Observations partition pre-creation failed");
  }

  let leadMonths = 0;
  try {
    leadMonths = Math.min(
      await getObservationPartitionLeadMonths(app.db, now),
      await getDomainEventPartitionLeadMonths(app.db, now),
    );
  } catch (error) {
    failure = failure ?? error;
    app.logger.warn({ err: error }, "Observations partition lead check failed");
  }

  if (failure !== null || leadMonths < OBSERVATION_PARTITION_LEAD_FLOOR_MONTHS) {
    await notifyOfapiGlobalIncident(app, {
      kind: "observations_partitions",
      errorSummary: failure !== null
        ? `Partition pre-creation failed: ${failure instanceof Error ? failure.message : String(failure)}`
        : `Partition lead is ${leadMonths} month(s), below the ${OBSERVATION_PARTITION_LEAD_FLOOR_MONTHS}-month floor`,
      occurredAt: now,
    });
  } else {
    await resolveOfapiGlobalIncident(app, {
      kind: "observations_partitions",
      recoveredAt: now,
    });
  }

  return { ensured, leadMonths, failed: failure !== null };
}
