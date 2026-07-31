import { and, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { voiceNotes, type VoiceNoteState, type VoiceProfileSettings } from "../schema.ts";

export type VoiceNoteRow = typeof voiceNotes.$inferSelect;

function utcDayOf(now: Date) {
  return now.toISOString().slice(0, 10);
}

// The two spend scopes reserved against for a single render: the page's own
// daily budget and the account-global daily budget.
function pageBudgetScope(pageId: number) {
  return `page:${pageId}`;
}
const GLOBAL_BUDGET_SCOPE = "global";

export interface InsertVoiceNoteJobInput {
  userId: number;
  platformAccountId: number;
  conversationRef: string;
  sourceGenerationRef: string;
  clientRequestId: string;
  requestHash: string;
  scriptChars: number;
  originalScriptSha256: string;
  finalScriptSha256: string;
  scriptEdited: boolean;
  profileVoiceId: string;
  profileModel: string;
  profileSettings: VoiceProfileSettings;
  profileOutputFormat: string;
  profileVersion: number;
  /**
   * The admission timestamp used for the matching daily-budget reservation.
   * Persisting the same instant keeps later sweep refunds on that reservation's
   * UTC day even when the transaction crosses midnight.
   */
  createdAt: Date;
}

/**
 * Inserts one render job. A concurrent/exact duplicate on
 * (user_id, client_request_id) loses the unique race and is a no-op; the
 * returned `inserted` flag tells the caller whether this call created the row.
 */
export async function insertVoiceNoteJob(
  db: Database,
  row: InsertVoiceNoteJobInput,
): Promise<{ inserted: boolean }> {
  const inserted = await db
    .insert(voiceNotes)
    .values({
      userId: row.userId,
      platformAccountId: row.platformAccountId,
      conversationRef: row.conversationRef,
      sourceGenerationRef: row.sourceGenerationRef,
      clientRequestId: row.clientRequestId,
      requestHash: row.requestHash,
      scriptChars: row.scriptChars,
      originalScriptSha256: row.originalScriptSha256,
      finalScriptSha256: row.finalScriptSha256,
      scriptEdited: row.scriptEdited,
      profileVoiceId: row.profileVoiceId,
      profileModel: row.profileModel,
      profileSettings: row.profileSettings,
      profileOutputFormat: row.profileOutputFormat,
      profileVersion: row.profileVersion,
      createdAt: row.createdAt,
      updatedAt: row.createdAt,
    })
    .onConflictDoNothing({
      target: [voiceNotes.userId, voiceNotes.clientRequestId],
    })
    .returning({ id: voiceNotes.id });

  return { inserted: inserted.length > 0 };
}

export async function getVoiceNoteByClientRequestId(
  db: Database,
  userId: number,
  clientRequestId: string,
): Promise<VoiceNoteRow | null> {
  const row = await db.query.voiceNotes.findFirst({
    where: and(
      eq(voiceNotes.userId, userId),
      eq(voiceNotes.clientRequestId, clientRequestId),
    ),
  });
  return row ?? null;
}

export async function getVoiceNoteById(
  db: Database,
  id: number,
): Promise<VoiceNoteRow | null> {
  const row = await db.query.voiceNotes.findFirst({
    where: eq(voiceNotes.id, id),
  });
  return row ?? null;
}

export interface VoiceNoteAudioRow {
  state: VoiceNoteState;
  audioBytes: Buffer | null;
  audioSha256: string | null;
}

/**
 * Audio retrieval is authorized in SQL, before PostgreSQL returns the TOASTed
 * BYTEA. A guessed global id owned by another page/user therefore produces no
 * audio row and never materializes the foreign artifact in the application.
 */
export async function getScopedVoiceNoteAudio(
  db: Database,
  input: { id: number; platformAccountId: number; userId: number },
): Promise<VoiceNoteAudioRow | null> {
  const [row] = await db
    .select({
      state: voiceNotes.state,
      audioBytes: voiceNotes.audioBytes,
      audioSha256: voiceNotes.audioSha256,
    })
    .from(voiceNotes)
    .where(and(
      eq(voiceNotes.id, input.id),
      eq(voiceNotes.platformAccountId, input.platformAccountId),
      eq(voiceNotes.userId, input.userId),
    ))
    .limit(1);
  return row ?? null;
}

// The status/replay projection: everything toStatusView renders, the (page,
// user) scope guard, and the replay hash-compare need — and NOTHING else. It
// deliberately excludes `audio_bytes` (a TOASTed BYTEA capped at 2 MiB): a
// 202-then-poll client hits the status read on every poll, and detoasting +
// transferring megabytes only to discard them is pure waste. The full-row reads
// stay ONLY where the bytes are actually used (getVoiceNoteAudio, dispatch).
const voiceNoteStatusColumns = {
  id: voiceNotes.id,
  userId: voiceNotes.userId,
  platformAccountId: voiceNotes.platformAccountId,
  state: voiceNotes.state,
  scriptChars: voiceNotes.scriptChars,
  billed: voiceNotes.billed,
  audioSha256: voiceNotes.audioSha256,
  audioBytesLen: voiceNotes.audioBytesLen,
  createdAt: voiceNotes.createdAt,
  requestHash: voiceNotes.requestHash,
} as const;

export interface VoiceNoteStatusRow {
  id: number;
  userId: number;
  platformAccountId: number;
  state: VoiceNoteState;
  scriptChars: number;
  billed: boolean | null;
  audioSha256: string | null;
  audioBytesLen: number | null;
  createdAt: Date;
  requestHash: string;
}

/** Projected status read for `getVoiceNoteById`'s status-view callers — same
 * id lookup, but without the audio bytes. */
export async function getVoiceNoteStatusById(
  db: Database,
  id: number,
): Promise<VoiceNoteStatusRow | null> {
  const [row] = await db
    .select(voiceNoteStatusColumns)
    .from(voiceNotes)
    .where(eq(voiceNotes.id, id))
    .limit(1);
  return row ?? null;
}

/** Projected status read for the idempotent-replay lookup — same (user,
 * clientRequestId) key as getVoiceNoteByClientRequestId, without the bytes. */
export async function getVoiceNoteStatusByClientRequestId(
  db: Database,
  userId: number,
  clientRequestId: string,
): Promise<VoiceNoteStatusRow | null> {
  const [row] = await db
    .select(voiceNoteStatusColumns)
    .from(voiceNotes)
    .where(and(
      eq(voiceNotes.userId, userId),
      eq(voiceNotes.clientRequestId, clientRequestId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * Compare-and-set the single dispatch grant: moves a `queued` row to
 * `dispatched`, stamping the attempt token + lease. The `state = 'queued'`
 * fence means that under concurrent callers exactly one wins (the row lock
 * serialises them and only the first sees `queued`). Returns whether this call
 * won the dispatch.
 */
export async function casVoiceNoteDispatch(
  db: Database,
  input: { id: number; attemptToken: string; leaseUntil: Date },
): Promise<boolean> {
  const updated = await db
    .update(voiceNotes)
    .set({
      state: "dispatched",
      attemptToken: input.attemptToken,
      leaseUntil: input.leaseUntil,
      updatedAt: new Date(),
    })
    .where(and(eq(voiceNotes.id, input.id), eq(voiceNotes.state, "queued")))
    .returning({ id: voiceNotes.id });

  return updated.length > 0;
}

/**
 * Refreshes ownership of a process-local queued waiter. The state predicate
 * makes a late heartbeat harmless after dispatch, erasure, or sweep.
 */
export async function touchQueuedVoiceNote(
  db: Database,
  id: number,
  now = new Date(),
): Promise<boolean> {
  const touched = await db
    .update(voiceNotes)
    .set({ updatedAt: now })
    .where(and(eq(voiceNotes.id, id), eq(voiceNotes.state, "queued")))
    .returning({ id: voiceNotes.id });
  return touched.length > 0;
}

export interface SettleVoiceNoteTerminalInput {
  id: number;
  attemptToken: string;
  state: VoiceNoteState;
  /**
   * The billing verdict, passed EXPLICITLY by the caller (a tri-state, NOT
   * derived from `billedChars`): `true` = the vendor synthesized (a completed
   * take bills even when no character-cost header arrived); `false` = refused
   * before billing (`failed_definite`); `null` = billing unknown (a
   * `failed_after_dispatch` where the vendor may or may not have charged).
   */
  billed: boolean | null;
  billedChars: number | null;
  providerRequestId: string | null;
  providerTraceId: string | null;
  providerRegion: string | null;
  audioBytes: Buffer | null;
  audioSha256: string | null;
  audioBytesLen: number | null;
  durationMs: number | null;
}

/**
 * Settles a dispatched render to a terminal state, fenced by the attempt token:
 * `WHERE attempt_token = $token AND state = 'dispatched'`. A stale token, or a
 * row the sweep already moved off `dispatched`, fails the fence and returns
 * false — so a late provider result can never overwrite a swept/indeterminate
 * verdict. `billed` is the caller's explicit billing verdict (see the input
 * doc); it is NOT inferred from `billedChars` (a cost header's absence does not
 * mean the vendor billed nothing).
 */
export async function settleVoiceNoteTerminal(
  db: Database,
  input: SettleVoiceNoteTerminalInput,
): Promise<boolean> {
  const settled = await db
    .update(voiceNotes)
    .set({
      state: input.state,
      billed: input.billed,
      billedChars: input.billedChars,
      providerRequestId: input.providerRequestId,
      providerTraceId: input.providerTraceId,
      providerRegion: input.providerRegion,
      audioBytes: input.audioBytes,
      audioSha256: input.audioSha256,
      audioBytesLen: input.audioBytesLen,
      durationMs: input.durationMs,
      updatedAt: new Date(),
    })
    .where(and(
      eq(voiceNotes.attemptToken, input.attemptToken),
      eq(voiceNotes.state, "dispatched"),
    ))
    .returning({ id: voiceNotes.id });

  return settled.length > 0;
}

/** The (page, chars, day) triple a swept row's budget release needs: `now` for
 * the release MUST be the row's `createdAt` so the refund lands on the UTC-day
 * counter the reservation was originally made against, not the sweep day. */
export interface VoiceNoteBudgetReleaseRow {
  platformAccountId: number;
  scriptChars: number;
  createdAt: Date;
}

/**
 * Recovery sweep. Moves lease-expired `dispatched` rows (lease_until < now) and
 * abandoned `queued` rows (not heartbeated since the caller-supplied cutoff) to
 * `indeterminate`, returning a count for each. Omitting `queuedCutoff` sweeps
 * only expired leases — no queued row is abandoned without an explicit cutoff.
 *
 * The two classes differ in billing certainty, so `billed` diverges:
 * - An abandoned `queued` row crashed BEFORE dispatch → certainly unbilled. Its
 *   stamp (`state=indeterminate`, `billed=false` — both the verdict AND the
 *   released marker) and its reservation refund are done TOGETHER in one
 *   per-row transaction, fenced on `state='queued'` AND the stale heartbeat
 *   cutoff, so a heartbeat racing candidate selection wins and a crash can
 *   never leave a stamped-but-unrefunded row.
 *   The refunded rows are returned in `abandonedQueuedRows` for count/telemetry.
 * - A lease-expired `dispatched` row may or may not have been billed at the
 *   provider → `billed` is left NULL (billing unknown; the reservation stays,
 *   the conservative direction). The nightly job releases these after 24h.
 */
export async function sweepVoiceNotes(
  db: Database,
  now: Date,
  queuedCutoff?: Date,
): Promise<{
  abandonedQueued: number;
  leaseExpired: number;
  abandonedQueuedRows: VoiceNoteBudgetReleaseRow[];
}> {
  const leaseExpired = await db
    .update(voiceNotes)
    .set({ state: "indeterminate", updatedAt: now })
    .where(and(
      eq(voiceNotes.state, "dispatched"),
      isNotNull(voiceNotes.leaseUntil),
      lt(voiceNotes.leaseUntil, now),
    ))
    .returning({ id: voiceNotes.id });

  const abandonedQueuedRows: VoiceNoteBudgetReleaseRow[] = [];
  if (queuedCutoff !== undefined) {
    // Collect candidates WITHOUT stamping; each row is then stamped AND refunded
    // atomically below. Selecting first (rather than one bulk UPDATE) is what
    // lets the stamp+refund share a transaction per row.
    const candidates = await db
      .select({
        id: voiceNotes.id,
        platformAccountId: voiceNotes.platformAccountId,
        scriptChars: voiceNotes.scriptChars,
        createdAt: voiceNotes.createdAt,
      })
      .from(voiceNotes)
      .where(and(
        eq(voiceNotes.state, "queued"),
        lt(voiceNotes.updatedAt, queuedCutoff),
      ));

    for (const candidate of candidates) {
      const released = await db.transaction(async (tx) => {
        const stamped = await tx
          .update(voiceNotes)
          .set({ state: "indeterminate", billed: false, updatedAt: now })
          .where(and(
            eq(voiceNotes.id, candidate.id),
            eq(voiceNotes.state, "queued"),
            lt(voiceNotes.updatedAt, queuedCutoff),
          ))
          .returning({ id: voiceNotes.id });
        if (stamped.length === 0) {
          // A concurrent sweep already claimed it — no stamp, no refund.
          return false;
        }
        // Refund against the reservation's own UTC day (createdAt), in the SAME
        // tx as the stamp: the two commit together or not at all.
        await settleVoiceCharBudget(tx, {
          pageId: candidate.platformAccountId,
          charsDelta: -candidate.scriptChars,
          now: candidate.createdAt,
        });
        return true;
      });
      if (released) {
        abandonedQueuedRows.push({
          platformAccountId: candidate.platformAccountId,
          scriptChars: candidate.scriptChars,
          createdAt: candidate.createdAt,
        });
      }
    }
  }

  return {
    abandonedQueued: abandonedQueuedRows.length,
    leaseExpired: leaseExpired.length,
    abandonedQueuedRows,
  };
}

/**
 * Nightly conservative release for `indeterminate` rows whose billing was never
 * resolved. For each `indeterminate` row with `billed IS NULL` (never released,
 * never settled) created before `cutoff`, the release marker and the reservation
 * refund are applied TOGETHER in one per-row transaction: the marker stamp is
 * `billed=false` and the refund lands on the row's own `createdAt` UTC day.
 *
 * For an `indeterminate` row `billed=false` means "reservation released, vendor
 * billing genuinely unknown" — it is the release marker, NOT a billing verdict
 * (the row's state, and the status view's errorCode, carry the unknown-ness).
 * The `billed IS NULL` predicate is the idempotency fence: it selects candidates
 * AND fences each per-row stamp, so a crash mid-loop leaves the unstamped rows
 * eligible for the next run and a second run finds nothing. Returns the rows
 * whose reservations were actually released.
 */
export async function releaseStaleIndeterminateVoiceBudgets(
  db: Database,
  cutoff: Date,
): Promise<VoiceNoteBudgetReleaseRow[]> {
  const candidates = await db
    .select({
      id: voiceNotes.id,
      platformAccountId: voiceNotes.platformAccountId,
      scriptChars: voiceNotes.scriptChars,
      createdAt: voiceNotes.createdAt,
    })
    .from(voiceNotes)
    .where(and(
      eq(voiceNotes.state, "indeterminate"),
      isNull(voiceNotes.billed),
      lt(voiceNotes.createdAt, cutoff),
    ));

  const released: VoiceNoteBudgetReleaseRow[] = [];
  for (const candidate of candidates) {
    const ok = await db.transaction(async (tx) => {
      const stamped = await tx
        .update(voiceNotes)
        .set({ billed: false, updatedAt: new Date() })
        .where(and(
          eq(voiceNotes.id, candidate.id),
          eq(voiceNotes.state, "indeterminate"),
          isNull(voiceNotes.billed),
        ))
        .returning({ id: voiceNotes.id });
      if (stamped.length === 0) {
        return false;
      }
      await settleVoiceCharBudget(tx, {
        pageId: candidate.platformAccountId,
        charsDelta: -candidate.scriptChars,
        now: candidate.createdAt,
      });
      return true;
    });
    if (ok) {
      released.push({
        platformAccountId: candidate.platformAccountId,
        scriptChars: candidate.scriptChars,
        createdAt: candidate.createdAt,
      });
    }
  }
  return released;
}

/**
 * Retention purge: for rows still holding audio created before `cutoff`, nulls
 * the audio bytes and flips state to `artifact_expired`. The `audio_bytes IS
 * NOT NULL` predicate (matching the partial purge index) makes it idempotent —
 * an already-purged row is skipped. Returns the number of rows purged.
 */
export async function purgeExpiredVoiceNoteAudio(
  db: Database,
  cutoff: Date,
): Promise<number> {
  const purged = await db
    .update(voiceNotes)
    .set({
      audioBytes: null,
      state: "artifact_expired",
      updatedAt: new Date(),
    })
    .where(and(
      isNotNull(voiceNotes.audioBytes),
      lt(voiceNotes.createdAt, cutoff),
    ))
    .returning({ id: voiceNotes.id });

  return purged.length;
}

// Internal rollback sentinel: thrown inside the reserve transaction when either
// scope's conditional upsert admits no row, so drizzle rolls the whole
// transaction back (page increment included) rather than leaving a partial.
class BudgetRefused extends Error {}

/**
 * Atomically reserves `chars` against both the page's and the account-global
 * daily character budgets for the UTC day of `now`. Both scopes are checked in
 * one transaction — the page row is reserved first, then the global row; if
 * either conditional upsert admits no row (would breach its budget) the whole
 * transaction rolls back, so a refused reservation never leaves a partial
 * increment. Follows the reserveOfapiDayCredits conditional-upsert idiom.
 * Returns whether the reservation was admitted.
 */
export async function reserveVoiceCharBudget(
  db: Database,
  input: {
    pageId: number;
    chars: number;
    pageBudget: number;
    globalBudget: number;
    now?: Date;
  },
): Promise<boolean> {
  const now = input.now ?? new Date();
  const day = utcDayOf(now);
  const chars = Math.max(0, Math.round(input.chars));
  const pageBudget = Math.round(input.pageBudget);
  const globalBudget = Math.round(input.globalBudget);

  // A single reservation larger than either budget can never be admitted, even
  // from a zero counter — the ON CONFLICT WHERE only guards the cumulative case.
  if (chars > pageBudget || chars > globalBudget) {
    return false;
  }

  try {
    await db.transaction(async (tx) => {
      const page = await tx.execute(sql`
        insert into voice_char_budget (scope, utc_day, spent_chars)
        values (${pageBudgetScope(input.pageId)}, ${day}::date, ${chars})
        on conflict (scope, utc_day) do update set
          spent_chars = voice_char_budget.spent_chars + ${chars}
        where voice_char_budget.spent_chars + ${chars} <= ${pageBudget}
        returning scope
      `);
      if (page.rows.length === 0) {
        throw new BudgetRefused();
      }

      const global = await tx.execute(sql`
        insert into voice_char_budget (scope, utc_day, spent_chars)
        values (${GLOBAL_BUDGET_SCOPE}, ${day}::date, ${chars})
        on conflict (scope, utc_day) do update set
          spent_chars = voice_char_budget.spent_chars + ${chars}
        where voice_char_budget.spent_chars + ${chars} <= ${globalBudget}
        returning scope
      `);
      if (global.rows.length === 0) {
        throw new BudgetRefused();
      }
    });
    return true;
  } catch (error) {
    if (error instanceof BudgetRefused) {
      return false;
    }
    throw error;
  }
}

/**
 * Settles a reservation to the provider-reported actuals: applies `charsDelta`
 * (actual minus estimate; negative on a refund) to both the page and global
 * counters for the UTC day of `now`, clamped at zero. Symmetric with
 * settleOfapiDayCreditReservation.
 */
export async function settleVoiceCharBudget(
  db: Database,
  input: { pageId: number; charsDelta: number; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const day = utcDayOf(now);
  const delta = Math.round(input.charsDelta);

  await db.transaction(async (tx) => {
    for (const scope of [pageBudgetScope(input.pageId), GLOBAL_BUDGET_SCOPE]) {
      await tx.execute(sql`
        insert into voice_char_budget (scope, utc_day, spent_chars)
        values (${scope}, ${day}::date, greatest(0, ${delta}))
        on conflict (scope, utc_day) do update set
          spent_chars = greatest(0, voice_char_budget.spent_chars + ${delta})
      `);
    }
  });
}
