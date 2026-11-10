// G5 slice 1 — the hourly integrity check of the content-addressed capture catalog.
//
// It runs two censuses that count a DURABLE ROW: the sha256 collision census
// (#219) and, since #222, the dangling-reference census. Each owns its own
// subKey and its own lifecycle under the shared `capture_payload_parity` kind.
// (The sampled inline-vs-catalog comparison it once ran is gone: no writer
// stores both copies on one row any more, so it compared 0 rows in every pass.)
//
// It NEVER repairs and NEVER deletes.

import {
  type CapturePayloadDanglingRefCensus,
  censusCapturePayloadDanglingRefs,
  countCapturePayloadCollisions,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { getCaptureCasDualWriteCounters } from "./capture-cas-dual-write.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { getCaptureCasReadCounters } from "./payload-reader.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const CAPTURE_PAYLOAD_PARITY_QUEUE = "capture.payload.parity.verify";

/**
 * The second condition this job latches, under the SAME incident kind and its
 * own subKey — the same shape as the disk runway latches
 * (`db_disk_usage:global:runway_warning` beside the bare usage latch).
 *
 * A sha256 collision and a parity mismatch are both "the catalog cannot be
 * trusted", which is why they share the kind, but they are NOT the same
 * condition and must not share a latch: a clean parity pass would otherwise
 * resolve a standing collision, and the owner would read "copies match again"
 * as an all-clear on an integrity fact that is still true. Split key, split
 * lifecycle, subKey-specific resolve text.
 */
export const CAPTURE_PAYLOAD_COLLISION_SUBKEY = "sha256_collision";

/**
 * The THIRD condition this job latches, under the same kind and its own subKey.
 *
 * A dangling reference — an envelope whose `payload_object_id` addresses a
 * catalog row that is not there — is an integrity FACT about stored rows, not a
 * sample statistic, so it gets the `sha256_collision` treatment rather than the
 * parity treatment: measured on every pass whether or not the canary is on,
 * resolvable only by a zero count, never by a clean parity sample. Sharing the
 * collision latch would be worse than either: a digest that stopped being unique
 * and a reference into a hole are different problems with different remedies,
 * and one going quiet must not read as the other going quiet.
 *
 * Since #220 this is also the most consequential of the three. A dangling
 * reference on a row that still carries its inline body is a lie the reader
 * fails open from; on a pointer-only row it is a captured fact that cannot be
 * read at all.
 */
export const CAPTURE_PAYLOAD_DANGLING_REF_SUBKEY = "dangling_reference";

export interface CapturePayloadParityCheckResult {
  /** Catalog objects carrying a non-zero collision_ordinal. */
  collisions: number;
  /** Envelope references pointing at an absent catalog row, over a bounded
   *  window of the head of both envelope tables. Also measured on every pass. */
  danglingRefs: CapturePayloadDanglingRefCensus;
  checkedAt: Date;
}

export async function ensureCapturePayloadParityQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, CAPTURE_PAYLOAD_PARITY_QUEUE, {
    policy: "standard",
  }, createdQueues);
}

export async function ensureCapturePayloadParitySchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  // Hourly at :35 — clear of the :15 disk check, the 02:00/02:30 cleanups and
  // the 03:10 partition job.
  await boss.schedule(CAPTURE_PAYLOAD_PARITY_QUEUE, "35 * * * *", null, { tz: "UTC" });
}

/**
 * The collision half of this job, and it runs on EVERY pass — canary on or off.
 *
 * A collision is a durable row (`collision_ordinal > 0`), not a sampled
 * observation: once a digest has stopped being unique inside one scope+month,
 * that stays true until an operator deals with it. Turning the dual-write
 * canary off does not un-collide anything, so gating this check on the canary
 * would silently clear an integrity page by rolling back a flag — the exact
 * asymmetry the skip branch below already respects for the parity latch.
 *
 * THE HOT PATH OWNS NO ALARM (#217). `settlePayloadObject` is where a collision
 * is DETECTED, and it deliberately only records it — durably, in the row it
 * writes. Paging is this job's, because an alarm needs an owner that runs on a
 * known schedule, can bound its paging rate, and can say "measured and clean".
 */
async function checkCapturePayloadCollisions(
  app: Pick<AppContext, "config" | "db" | "logger">,
  checkedAt: Date,
): Promise<number> {
  const collisions = await countCapturePayloadCollisions(app.db);
  if (collisions > 0) {
    app.logger.warn({ collisions }, "Capture payload sha256 collisions present in the catalog");
    await notifyOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      subKey: CAPTURE_PAYLOAD_COLLISION_SUBKEY,
      errorSummary:
        `${collisions} capture payload object(s) carry collision_ordinal > 0: two different bodies `
        + "share one sha256 inside a single scope and month; every capture is stored and readable, "
        + "the digest is what stopped being unique",
      occurredAt: checkedAt,
    });
  } else {
    await resolveOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      subKey: CAPTURE_PAYLOAD_COLLISION_SUBKEY,
      recoveredAt: checkedAt,
    });
  }
  return collisions;
}

/**
 * The dangling-reference half, and it runs on EVERY pass for the same reason
 * the collision half does: the rows it counts are durable. Rolling the canary
 * back or putting the read mode on `inline` does not re-attach a body to a
 * reference that points at nothing — and since #220 those are exactly the
 * configurations an operator reaches for when they are worried, which is the
 * worst possible moment for this check to go silent.
 *
 * The window is bounded (see `censusCapturePayloadDanglingRefs`) and travels in
 * both the log line and the incident text, so the owner reads "zero in the last
 * N rows of each table", never an unearned "zero anywhere".
 */
async function checkCapturePayloadDanglingRefs(
  app: Pick<AppContext, "config" | "db" | "logger">,
  checkedAt: Date,
  scanLimit?: number,
): Promise<CapturePayloadDanglingRefCensus> {
  const census = await censusCapturePayloadDanglingRefs(
    app.db,
    scanLimit === undefined ? undefined : { scanLimit },
  );
  if (census.dangling > 0) {
    const samples = census.samples
      .map((entry) => `${entry.envelope}#${entry.envelopeId}->${entry.bucketMonth}/${entry.objectId}`)
      .join("; ");
    app.logger.warn(
      { dangling: census.dangling, referenced: census.referenced, samples: census.samples },
      "Capture payload references point at catalog rows that are not there",
    );
    await notifyOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      subKey: CAPTURE_PAYLOAD_DANGLING_REF_SUBKEY,
      errorSummary:
        `${census.dangling} of ${census.referenced} recent capture payload reference(s) address a `
        + `catalog row that does not exist (window: newest ${census.scanLimit} rows per envelope `
        + "table); a row with no inline body and a dangling reference is a captured fact that "
        + `cannot be read${samples.length > 0 ? `; samples: ${samples}` : ""}`,
      occurredAt: checkedAt,
    });
  } else {
    await resolveOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      subKey: CAPTURE_PAYLOAD_DANGLING_REF_SUBKEY,
      recoveredAt: checkedAt,
    });
  }
  return census;
}

export async function runCapturePayloadParityCheck(
  app: Pick<AppContext, "config" | "db" | "logger">,
  options?: { now?: Date; danglingScanLimit?: number },
): Promise<CapturePayloadParityCheckResult> {
  const checkedAt = options?.now ?? new Date();
  const collisions = await checkCapturePayloadCollisions(app, checkedAt);
  const danglingRefs = await checkCapturePayloadDanglingRefs(
    app,
    checkedAt,
    options?.danglingScanLimit,
  );

  // One telemetry line per pass, carrying the write-side counters AND the G5
  // slice 2 read-side counters beside this pass's censuses. This line is also
  // the ONLY place the read counters surface, because the read path
  // deliberately owns no alarm of its own.
  app.logger.info({
    collisions,
    danglingRefs: danglingRefs.dangling,
    danglingRefsScanned: danglingRefs.referenced,
    danglingRefsScanLimit: danglingRefs.scanLimit,
    writeCounters: getCaptureCasDualWriteCounters(),
    readCounters: getCaptureCasReadCounters(),
  }, "Capture payload parity check complete");

  return { collisions, danglingRefs, checkedAt };
}
