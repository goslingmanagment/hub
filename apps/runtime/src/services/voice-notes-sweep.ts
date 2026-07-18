// Voice-notes recovery jobs (Task 7 of the voice-notes lane).
//
// Two pg-boss jobs cover the two crash windows of the render pipeline:
//   * the MINUTELY lease sweep (`voice.notes.sweep`) reclaims rows the service
//     abandoned — `queued` rows that never dispatched (crash between INSERT and
//     the dispatch CAS) and `dispatched` rows whose lease expired — moving both
//     to `indeterminate`. An abandoned `queued` row is certainly unbilled, so
//     its reservation is refunded immediately; a lease-expired `dispatched` row
//     might have been billed, so its reservation is kept (conservative) until
//     the nightly job releases it after 24h.
//   * the NIGHTLY retention pass (rides the existing raw-payload cleanup handler
//     in worker-services) purges audio bytes older than 7 days and releases the
//     reservations still held by long-stale `indeterminate` rows.
//
// Every reservation refund lands on the UTC-day counter the reservation was
// made against — the row's `createdAt`, NOT the sweep/nightly `now`. Logging is
// counts-only: script text and audio never appear in logs.

import {
  purgeExpiredVoiceNoteAudio,
  releaseStaleIndeterminateVoiceBudgets,
  settleVoiceCharBudget,
  sweepVoiceNotes,
  type Database,
  type VoiceNoteBudgetReleaseRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

export const VOICE_NOTES_SWEEP_QUEUE = "voice.notes.sweep";

// A `queued` row older than this never dispatched: admission is synchronous, so
// a row still `queued` minutes later means the service crashed between the row
// INSERT and the dispatch CAS. 5 min is comfortably beyond that window.
const QUEUED_ABANDON_MS = 5 * 60 * 1000;
// Audio is retained for 7 days, then the bytes are purged (row → artifact_expired).
const AUDIO_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
// An `indeterminate` row whose billing never resolved has its reservation
// released after 24h — long enough for any in-flight settle to have landed.
const STALE_INDETERMINATE_MS = 24 * 60 * 60 * 1000;

export async function ensureVoiceNotesSweepQueue(
  boss: QueueCreationClient,
  createdQueues?: Set<string>,
) {
  await ensureQueueCreated(boss, VOICE_NOTES_SWEEP_QUEUE, {
    policy: "exclusive",
  }, createdQueues);
}

export async function ensureVoiceNotesSweepSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) {
    return;
  }
  await boss.schedule(VOICE_NOTES_SWEEP_QUEUE, "*/1 * * * *", null, { tz: "UTC" });
}

// Refunds each row's reservation against the UTC-day counter it was reserved
// on (row.createdAt), returning how many were released.
async function releaseReservations(
  db: Database,
  rows: VoiceNoteBudgetReleaseRow[],
): Promise<number> {
  for (const row of rows) {
    await settleVoiceCharBudget(db, {
      pageId: row.platformAccountId,
      charsDelta: -row.scriptChars,
      now: row.createdAt,
    });
  }
  return rows.length;
}

/**
 * Minutely sweep: reclaim abandoned `queued` rows (older than 5 min) and
 * lease-expired `dispatched` rows to `indeterminate`, refunding the reservations
 * of the certainly-unbilled abandoned-queued rows. Returns counts only.
 */
export async function runVoiceNotesSweep(
  app: Pick<AppContext, "db">,
  now = new Date(),
): Promise<{ abandonedQueued: number; leaseExpired: number; budgetsReleased: number }> {
  const queuedCutoff = new Date(now.getTime() - QUEUED_ABANDON_MS);
  const swept = await sweepVoiceNotes(app.db, now, queuedCutoff);
  const budgetsReleased = await releaseReservations(app.db, swept.abandonedQueuedRows);
  return {
    abandonedQueued: swept.abandonedQueued,
    leaseExpired: swept.leaseExpired,
    budgetsReleased,
  };
}

/**
 * Nightly retention: purge audio bytes older than 7 days and release the
 * reservations of `indeterminate` rows older than 24h whose billing never
 * resolved. Both halves are idempotent. Returns counts only.
 */
export async function runVoiceNotesNightlyRetention(
  app: Pick<AppContext, "db">,
  now = new Date(),
): Promise<{ audioPurged: number; budgetsReleased: number }> {
  const audioPurged = await purgeExpiredVoiceNoteAudio(
    app.db,
    new Date(now.getTime() - AUDIO_RETENTION_MS),
  );
  const staleRows = await releaseStaleIndeterminateVoiceBudgets(
    app.db,
    new Date(now.getTime() - STALE_INDETERMINATE_MS),
  );
  const budgetsReleased = await releaseReservations(app.db, staleRows);
  return { audioPurged, budgetsReleased };
}
