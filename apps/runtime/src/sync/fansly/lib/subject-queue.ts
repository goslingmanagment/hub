import { sql } from "drizzle-orm";

import {
  clearSubjectQueueBlocks,
  recordSubjectQueueFailures,
  type Database,
  type SubjectQueueBreakerLadder,
  type SubjectQueueFailure,
  type SubjectQueueKeyset,
} from "@agency_hub_core/db";

import { BLOCKED_PROBE_EVERY_MS, SUBJECT_BLOCK_AFTER, SUBJECT_BREAKER_LADDER_MS } from "../../engine/errors.ts";
import type { LookCheck } from "../../engine/resource.ts";

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
//   `sync_work`, so a newly dirtied subject is noticed at the next re-check);
// - the shadow pass: shadow never writes the queue, so it steps through the
//   due subjects with the chunk functions' keyset (`after`) and starts a new
//   pass one re-check period after the previous one started — a backlog is
//   walked once per period, as live would walk it.

/** The queue-row breaker: the engine's subject ladder (design §3.8). */
export const QUEUE_SUBJECT_BREAKER: SubjectQueueBreakerLadder = Object.freeze({
  stepsMs: SUBJECT_BREAKER_LADDER_MS,
  blockAfter: SUBJECT_BLOCK_AFTER,
  blockedProbeEveryMs: BLOCKED_PROBE_EVERY_MS,
});

/** A subject-queue walk: its plane and its due subjects in its own order. */
export interface SubjectQueueWalk<S extends { subjectRef: string; keyset: SubjectQueueKeyset }> {
  plane: string;
  /** Up to `limit` due subjects, the ones after `after` only when given. */
  pickDue(db: Database, input: { pageId: number; now: Date; limit: number; after: SubjectQueueKeyset | null }): Promise<S[]>;
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

// ── the shadow pass ─────────────────────────────────────────────────────────

/** A shadow walk's position in its current pass (in the walk row's cursor). */
export interface ShadowPass {
  after: SubjectQueueKeyset | null;
  /** ISO: when the pass took its first subject. */
  startedAt: string | null;
  /** The pass reached the end of the due subjects: the walk rests until the
   *  next pass. */
  ended: boolean;
}

export const EMPTY_SHADOW_PASS: ShadowPass = Object.freeze({ after: null, startedAt: null, ended: false });

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseShadowPass(value: unknown): ShadowPass {
  const record = recordOf(value);
  const startedAt = typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt))
    ? record.startedAt
    : null;
  if (startedAt === null) return EMPTY_SHADOW_PASS;
  const after = typeof record.after === "string" && record.after.length > 0 ? record.after : null;
  return { after, startedAt, ended: record.ended === true };
}

/** The pass a shadow step continues: the current one while it is younger than
 *  the re-check period, else a new one from the head of the order. */
export function currentShadowPass(pass: ShadowPass, now: Date, recheckMs: number): ShadowPass {
  if (pass.startedAt === null) return EMPTY_SHADOW_PASS;
  return now.getTime() - Date.parse(pass.startedAt) < recheckMs ? pass : EMPTY_SHADOW_PASS;
}

/** When the next pass starts: one re-check period after this one started (a
 *  period from now when none is running). */
export function shadowPassWaitUntil(pass: ShadowPass, now: Date, recheckMs: number): Date {
  const next = pass.startedAt === null ? now.getTime() + recheckMs : Date.parse(pass.startedAt) + recheckMs;
  return new Date(Math.max(next, now.getTime() + 1_000));
}

/**
 * One simulated step of a shadow pass over `taken` (the subjects the step's
 * request named, in walk order): the pass moves past the last of them; a step
 * that took fewer than `limit` subjects was the last of its pass, so the walk
 * rests until the next pass. Returns the walk row's new pass and due time.
 */
export function advanceShadowPass(input: {
  pass: ShadowPass;
  now: Date;
  recheckMs: number;
  taken: ReadonlyArray<{ keyset: SubjectQueueKeyset }>;
  limit: number;
}): { pass: ShadowPass; nextDueAt: Date } {
  const current = currentShadowPass(input.pass, input.now, input.recheckMs);
  const startedAt = current.startedAt ?? input.now.toISOString();
  const last = input.taken.at(-1);
  if (last === undefined || input.taken.length < input.limit) {
    const pass: ShadowPass = { after: null, startedAt, ended: true };
    return { pass, nextDueAt: shadowPassWaitUntil(pass, input.now, input.recheckMs) };
  }
  return { pass: { after: last.keyset, startedAt, ended: false }, nextDueAt: input.now };
}

// ── the shadow report's look check (rule A1.floor-idle) ─────────────────────

/** A look check reads at most this many due subjects of one queue (its count
 *  is a lower bound past it). */
export const LOOK_CHECK_LIMIT = 5_000;
/** Due subjects a look check names. */
const LOOK_CHECK_EXAMPLES = 5;

/**
 * What a standing walk's look at `at` should have read (`dueAtLook`): the
 * subjects its own pick finds due at that instant (`pick`, in walk order, at
 * most `LOOK_CHECK_LIMIT`), less every subject a writer changed after it — a
 * subject legacy read, dirtied or seeded since stands as it does now, not as
 * the look saw it. Read-only.
 */
export async function dueAtLookOf(
  db: Database,
  input: { pageId: number; plane: string; at: Date; pick: (limit: number) => Promise<ReadonlyArray<{ subjectRef: string }>> },
): Promise<LookCheck> {
  const picked = [...new Set((await input.pick(LOOK_CHECK_LIMIT)).map((subject) => subject.subjectRef))];
  if (picked.length === 0) return { count: 0, examples: [] };
  const result = await db.execute<{ subjectRef: string }>(sql`
    select subject_ref as "subjectRef"
      from subject_refresh_state
     where page_id = ${input.pageId}
       and plane = ${input.plane}
       and subject_ref = any(${sql.param(picked)}::text[])
       and updated_at <= ${input.at}
  `);
  const untouched = new Set(result.rows.map((row) => row.subjectRef));
  const due = picked.filter((ref) => untouched.has(ref));
  return { count: due.length, examples: due.slice(0, LOOK_CHECK_EXAMPLES) };
}
