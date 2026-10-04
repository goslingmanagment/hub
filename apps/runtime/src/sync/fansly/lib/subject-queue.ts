import {
  clearSubjectQueueBlocks,
  recordSubjectQueueFailures,
  type Database,
  type SubjectQueueBreakerLadder,
  type SubjectQueueFailure,
} from "@agency_hub_core/db";

import { BLOCKED_PROBE_EVERY_MS, SUBJECT_BLOCK_AFTER, SUBJECT_BREAKER_LADDER_MS } from "../../engine/errors.ts";

// Subject-queue walks of the Fansly Sync Engine (design §4.3, D2).
//
// `subject_refresh_state` stays the per-subject queue (the projectors seed and
// dirty it in their own transactions; nothing about that changes) and
// `sync_work` holds ONE standing walk row per page and resource that steps
// through the due subjects, taking its round-robin turn in the planned class
// like any other walk. What every such walk shares lives here:
//
// - the §9 subject breaker on the QUEUE row (the walk row itself never opens a
//   breaker: one unreachable post must not stop an archive of thousands) —
//   1 m → 10 m → 1 h → 6 h → 24 h, blocked by the vendor from the fifth
//   failure on and probed daily, the same ladder a work row climbs;
// - the re-check of a walk with nothing due: its row stays open and looks at
//   its queue again after `recheckMs` (the queue's writers do not touch
//   `sync_work`, so a newly dirtied subject is noticed at the next re-check).

/** The queue-row breaker: the engine's subject ladder (design §3.8). */
export const QUEUE_SUBJECT_BREAKER: SubjectQueueBreakerLadder = Object.freeze({
  stepsMs: SUBJECT_BREAKER_LADDER_MS,
  blockAfter: SUBJECT_BLOCK_AFTER,
  blockedProbeEveryMs: BLOCKED_PROBE_EVERY_MS,
});

/** A subject-queue walk: its plane and its due subjects in its own order. */
export interface SubjectQueueWalk<S extends { subjectRef: string }> {
  plane: string;
  /** Up to `limit` due subjects. */
  pickDue(db: Database, input: { pageId: number; now: Date; limit: number }): Promise<S[]>;
}

/** Open the breaker of each subject a failed step asked for (capture
 *  transaction, design §4.3). */
export function recordQueueSubjectFailures(
  tx: Database,
  input: { pageId: number; plane: string; subjectRefs: readonly string[]; now: Date },
): Promise<SubjectQueueFailure[]> {
  return recordSubjectQueueFailures(tx, { ...input, ladder: QUEUE_SUBJECT_BREAKER });
}

/** Subjects answered again: their vendor-block marker goes. */
export function clearQueueSubjectBlocks(
  tx: Database,
  input: { pageId: number; plane: string; subjectRefs: readonly string[] },
): Promise<number> {
  return clearSubjectQueueBlocks(tx, input);
}

/** When a walk with nothing due looks at its queue again. */
export function standingRecheckAt(now: Date, recheckMs: number): Date {
  return new Date(now.getTime() + recheckMs);
}
