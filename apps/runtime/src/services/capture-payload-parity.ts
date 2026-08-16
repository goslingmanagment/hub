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
  verifyCapturePayloadParity,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import {
  getCaptureCasDualWriteCounters,
  getCaptureCasDualWritePages,
} from "./capture-cas-dual-write.ts";
import {
  notifyOfapiGlobalIncident,
  resolveOfapiGlobalIncident,
} from "./notification-incidents.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const CAPTURE_PAYLOAD_PARITY_QUEUE = "capture.payload.parity.verify";

export interface CapturePayloadParityCheckResult extends CapturePayloadParityReport {
  /** The canary bound this pass ran under (''=off). */
  dualWritePages: string;
  /** True when the canary is off and nothing was measured. */
  skipped: boolean;
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

export async function runCapturePayloadParityCheck(
  app: Pick<AppContext, "config" | "db" | "logger">,
  options?: { now?: Date; limit?: number; scanLimit?: number },
): Promise<CapturePayloadParityCheckResult> {
  const checkedAt = options?.now ?? new Date();
  const dualWritePages = getCaptureCasDualWritePages();
  if (dualWritePages.trim().length === 0) {
    return {
      dualWritePages,
      skipped: true,
      checked: 0,
      matched: 0,
      mismatched: 0,
      mismatches: [],
      checkedAt,
    };
  }

  const report = await verifyCapturePayloadParity(app.db, {
    limit: options?.limit ?? CAPTURE_PAYLOAD_PARITY_DEFAULT_LIMIT,
    ...(options?.scanLimit === undefined ? {} : { scanLimit: options.scanLimit }),
  });

  // One telemetry line per pass, carrying the write-side counters alongside the
  // read-side verdict: a rising codecRefused with a clean parity report is a
  // very different story from a rising mismatched, and reading them apart in
  // two places invites drawing the wrong conclusion.
  app.logger.info({
    dualWritePages,
    checked: report.checked,
    matched: report.matched,
    mismatched: report.mismatched,
    writeCounters: getCaptureCasDualWriteCounters(),
    ...(report.mismatches.length > 0 ? { mismatches: report.mismatches } : {}),
  }, "Capture payload parity check complete");

  if (report.mismatched > 0) {
    await notifyOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      errorSummary: describeMismatches(report),
      occurredAt: checkedAt,
    });
  } else if (report.checked > 0) {
    // Only a pass that actually compared something may clear the latch.
    await resolveOfapiGlobalIncident(app, {
      kind: "capture_payload_parity",
      recoveredAt: checkedAt,
    });
  }

  return { ...report, dualWritePages, skipped: false, checkedAt };
}
