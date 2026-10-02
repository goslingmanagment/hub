import { sql } from "drizzle-orm";

import type { Database } from "../../client.ts";
import { textArrayParam, timestampParam, toRequiredDate } from "./values.ts";

// The per-subject queue of the Fansly Sync Engine's subject-queue walks
// (design §4.3, D2): `subject_refresh_state` stays the queue, one walk row in
// `sync_work` steps through its due subjects, and the §9 subject breaker of a
// queue subject lives on the queue row itself — `consecutive_failures`, a
// `next_due_at` on the engine's ladder, and `last_refresh_outcome =
// 'blocked_by_vendor'` from the fifth failure on (probed daily). The planes'
// own visit writers (`recordPostRepliesWalkVisit`, …) reset the counter; the
// helpers here only add what those writers do not know about.

/** The vendor-block marker on a queue row (`last_refresh_outcome`). */
export const SUBJECT_QUEUE_BLOCKED_OUTCOME = "blocked_by_vendor";

export interface SubjectQueueBreakerLadder {
  /** Failure n waits `stepsMs[min(n, len) - 1]`. */
  stepsMs: readonly number[];
  /** From this many consecutive failures on the subject is blocked by the vendor… */
  blockAfter: number;
  /** …and probed no more often than this. */
  blockedProbeEveryMs: number;
}

export interface SubjectQueueFailure {
  subjectRef: string;
  consecutiveFailures: number;
  nextDueAt: Date;
  blocked: boolean;
}

/**
 * One more failure for each subject: the counter, the next due time on the
 * ladder (from `now`), and the vendor-block marker once the counter reaches
 * `blockAfter`. A subject with no queue row is left alone (the walk took it
 * from the queue, so the row exists unless an erasure took it meanwhile).
 */
export async function recordSubjectQueueFailures(
  db: Database,
  input: {
    pageId: number;
    plane: string;
    subjectRefs: readonly string[];
    now: Date;
    ladder: SubjectQueueBreakerLadder;
  },
): Promise<SubjectQueueFailure[]> {
  const refs = [...new Set(input.subjectRefs)];
  const steps = input.ladder.stepsMs;
  if (refs.length === 0) return [];
  if (steps.length === 0 || steps.some((step) => !Number.isSafeInteger(step) || step <= 0)) {
    throw new RangeError("A subject-queue breaker ladder needs positive whole-millisecond steps");
  }
  const failures = sql`(s.consecutive_failures + 1)`;
  const stepMs = sql`(${sql.param(steps.map(String))}::bigint[])[least(${failures}, ${steps.length}::int)]`;
  const blocked = sql`(${failures} >= ${input.ladder.blockAfter}::int)`;
  const result = await db.execute<{
    subjectRef: string;
    consecutiveFailures: number | string;
    nextDueAt: Date | string;
    blocked: boolean;
  }>(sql`
    update subject_refresh_state s
       set consecutive_failures = ${failures},
           next_due_at = ${timestampParam(input.now)} + make_interval(secs => (
             case when ${blocked} then greatest(${stepMs}, ${input.ladder.blockedProbeEveryMs}::bigint) else ${stepMs} end
           )::double precision / 1000.0),
           last_refresh_outcome = case when ${blocked} then ${SUBJECT_QUEUE_BLOCKED_OUTCOME} else s.last_refresh_outcome end,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = ${input.plane}
       and s.subject_ref = any(${textArrayParam(refs)})
    returning s.subject_ref as "subjectRef", s.consecutive_failures as "consecutiveFailures",
              s.next_due_at as "nextDueAt", (s.last_refresh_outcome = ${SUBJECT_QUEUE_BLOCKED_OUTCOME}) as blocked
  `);
  return result.rows.map((row) => ({
    subjectRef: row.subjectRef,
    consecutiveFailures: Number(row.consecutiveFailures),
    nextDueAt: toRequiredDate(row.nextDueAt),
    blocked: row.blocked === true,
  }));
}

/** A subject answered again: lift its vendor-block marker (the plane's visit
 *  writer has already reset the counter). Returns how many were lifted. */
export async function clearSubjectQueueBlocks(
  db: Database,
  input: { pageId: number; plane: string; subjectRefs: readonly string[] },
): Promise<number> {
  const refs = [...new Set(input.subjectRefs)];
  if (refs.length === 0) return 0;
  const result = await db.execute(sql`
    update subject_refresh_state s
       set last_refresh_outcome = null,
           updated_at = now()
     where s.page_id = ${input.pageId}
       and s.plane = ${input.plane}
       and s.subject_ref = any(${textArrayParam(refs)})
       and s.last_refresh_outcome = ${SUBJECT_QUEUE_BLOCKED_OUTCOME}
  `);
  return result.rowCount ?? 0;
}

/** Whether a subject is waiting out a failure (its breaker is open at `now`);
 *  null when the subject has no queue row. */
export async function subjectQueueBackoffOpen(
  db: Database,
  input: { pageId: number; plane: string; subjectRef: string; now: Date },
): Promise<boolean | null> {
  const result = await db.execute<{ open: boolean }>(sql`
    select (s.consecutive_failures > 0 and coalesce(s.next_due_at > ${timestampParam(input.now)}, false)) as open
      from subject_refresh_state s
     where s.page_id = ${input.pageId}
       and s.plane = ${input.plane}
       and s.subject_ref = ${input.subjectRef}
  `);
  const row = result.rows[0];
  return row === undefined ? null : row.open === true;
}
