// G5 slice 1 — the periodic parity check over the CAS dual write.
//
// The dual write is only trustworthy if something keeps proving it. This job is
// that proof: once an hour it takes a bounded sample of envelopes that carry a
// catalog reference, compares the catalog body against the inline authority in
// full, and reports {checked, matched, mismatched}. A mismatch pages the owner
// through the incident layer; a clean pass resolves the latch.
//
// It NEVER repairs and NEVER deletes. The inline column is the fact; if the
// copy disagrees, the copy is wrong and a human decides what that means. A job
// that silently reconciled a captured fact with a derived copy of itself would
// be the exact anti-pattern DP 7 forbids.
//
// COST WHEN THE CANARY IS OFF: zero. With no page in
// `capture_cas_dual_write_pages` there is nothing to verify, so the job returns
// without touching the database at all — and without touching the incident
// latch either, because "not measured" is not the same state as "measured and
// clean" (the same asymmetry the disk runway latches use). Turning the canary
// off after a real mismatch must not clear the alarm.

import {
  CAPTURE_PAYLOAD_PARITY_DEFAULT_LIMIT,
  type CapturePayloadParityReport,
  countCapturePayloadCollisions,
  verifyCapturePayloadParity,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  getCaptureCasDualWriteCounters,
  getCaptureCasDualWritePages,
  getCaptureCasPointerOnlyPages,
} from "./capture-cas-dual-write.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { getCaptureCasReadCounters, getCaptureCasReadMode } from "./payload-reader.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const CAPTURE_PAYLOAD_PARITY_QUEUE = "capture.payload.parity.verify";

/**
 * The second condition this job latches, under the SAME incident kind and its
 * own subKey — the shape decision #213 gave the disk runway latches
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

export interface CapturePayloadParityCheckResult extends CapturePayloadParityReport {
  /** The canary bound this pass ran under (''=off). */
  dualWritePages: string;
  /** True when the canary is off and nothing was measured. */
  skipped: boolean;
  /** Catalog objects carrying a non-zero collision_ordinal. Measured on EVERY
   *  pass, canary or no canary — see runCapturePayloadParityCheck. */
  collisions: number;
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

/** The bounded incident text: counts first, then at most three sample refs.
 *  Same shape discipline as buildDmSweepDualProofAnomalyDetails — an anomaly
 *  payload must stay small even when everything disagrees. */
function describeMismatches(report: CapturePayloadParityReport) {
  const samples = report.mismatches.map((entry) =>
    `${entry.envelope}#${entry.envelopeId}->${entry.bucketMonth}/${entry.objectId} (${entry.reason})`
  );
  return [
    `${report.mismatched} of ${report.checked} sampled capture payload copies disagree`
    + ` with the inline fact`,
    ...(samples.length > 0 ? [`samples: ${samples.join("; ")}`] : []),
    "inline columns are untouched and remain the authority",
  ].join("; ");
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

export async function runCapturePayloadParityCheck(
  app: Pick<AppContext, "config" | "db" | "logger">,
  options?: { now?: Date; limit?: number; scanLimit?: number },
): Promise<CapturePayloadParityCheckResult> {
  const checkedAt = options?.now ?? new Date();
  const collisions = await checkCapturePayloadCollisions(app, checkedAt);
  const dualWritePages = getCaptureCasDualWritePages();
  if (dualWritePages.trim().length === 0) {
    // The canary is off, so there is nothing to verify and the latch is left
    // exactly as it was. The READ counters still deserve a line when the read
    // mode is not inline: refs written by an earlier canary window survive a
    // dual-write rollback, so shadow/serve can keep resolving them long after
    // this job has stopped sampling.
    //
    // G5 slice 3c-1 adds the second reason, and it is the stronger one: a
    // pointer-only row resolves from the catalog in EVERY mode, so rolling BOTH
    // the canary off and the read mode back to `inline` — the quietest state an
    // operator can put this subsystem in — does not stop those reads happening.
    // If this line were still gated on the mode alone, `nullInlineUnresolved`
    // (a captured body that could not be read AT ALL) would go unreported in
    // exactly the configuration someone reaches for when they are worried.
    // Silent only when nothing has actually happened, which preserves "costs
    // nothing when off" for the default deployment.
    const readCounters = getCaptureCasReadCounters();
    const nullInlineTraffic = readCounters.servedNullInline > 0
      || readCounters.nullInlineUnresolved > 0
      || readCounters.shadowSkippedNullInline > 0;
    if (getCaptureCasReadMode() !== "inline" || nullInlineTraffic) {
      app.logger.info({
        dualWritePages,
        pointerOnlyPages: getCaptureCasPointerOnlyPages(),
        readMode: getCaptureCasReadMode(),
        readCounters,
      }, "Capture payload parity check skipped (dual-write canary off); read counters only");
    }
    return {
      dualWritePages,
      skipped: true,
      checked: 0,
      matched: 0,
      mismatched: 0,
      skippedNullInline: 0,
      mismatches: [],
      collisions,
      checkedAt,
    };
  }

  const report = await verifyCapturePayloadParity(app.db, {
    limit: options?.limit ?? CAPTURE_PAYLOAD_PARITY_DEFAULT_LIMIT,
    ...(options?.scanLimit === undefined ? {} : { scanLimit: options.scanLimit }),
  });

  // One telemetry line per pass, carrying the write-side counters AND the G5
  // slice 2 read-side counters alongside this pass's verdict. Three signals that
  // must be read together: a rising codecRefused with a clean parity report is a
  // very different story from a rising mismatched, and a rising serveFellBack
  // says the catalog is degrading under live reads even while this bounded
  // sample still passes. Reading them apart in three places invites drawing the
  // wrong conclusion — and this line is also the ONLY place the read counters
  // surface, because the read path deliberately owns no alarm of its own.
  app.logger.info({
    dualWritePages,
    pointerOnlyPages: getCaptureCasPointerOnlyPages(),
    readMode: getCaptureCasReadMode(),
    checked: report.checked,
    matched: report.matched,
    mismatched: report.mismatched,
    skippedNullInline: report.skippedNullInline,
    collisions,
    writeCounters: getCaptureCasDualWriteCounters(),
    readCounters: getCaptureCasReadCounters(),
    ...(report.mismatches.length > 0 ? { mismatches: report.mismatches } : {}),
  }, "Capture payload parity check complete");

  if (report.mismatched > 0) {
    await notifyOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      errorSummary: describeMismatches(report),
      occurredAt: checkedAt,
    });
  } else if (report.checked > 0) {
    // Only a pass that actually compared something may clear the latch — and
    // only THIS latch: the collision subKey has its own lifecycle above and a
    // clean sample says nothing about whether a digest is unique again.
    await resolveOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      recoveredAt: checkedAt,
    });
  }

  return { ...report, dualWritePages, skipped: false, collisions, checkedAt };
}
