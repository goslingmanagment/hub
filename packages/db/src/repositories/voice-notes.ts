import { and, eq, isNotNull, lt, sql } from "drizzle-orm";

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
    })
    .onConflictDoNothing({
      target: [voiceNotes.userId, voiceNotes.clientRequestId],
    })
    .returning({ id: voiceNotes.id });

  return { inserted: inserted.length > 0 };
}

/**
 * Inserts a `quota_denied` row for a refused reservation. `insertVoiceNoteJob`
 * only produces `queued`, so this mirrors its columns (same values, same
 * conflict target) with the denied terminal state. Idempotent on
 * (user_id, client_request_id): returns whether THIS call won the insert.
 */
export async function insertQuotaDeniedVoiceNote(
  db: Database,
  row: InsertVoiceNoteJobInput,
): Promise<boolean> {
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
      state: "quota_denied",
    })
    .onConflictDoNothing({
      target: [voiceNotes.userId, voiceNotes.clientRequestId],
    })
    .returning({ id: voiceNotes.id });

  return inserted.length > 0;
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

export interface SettleVoiceNoteTerminalInput {
  id: number;
  attemptToken: string;
  state: VoiceNoteState;
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
 * verdict. `billed` is derived from whether the provider reported billed chars.
 */
export async function settleVoiceNoteTerminal(
  db: Database,
  input: SettleVoiceNoteTerminalInput,
): Promise<boolean> {
  const settled = await db
    .update(voiceNotes)
    .set({
      state: input.state,
      billed: input.billedChars != null,
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

/**
 * Recovery sweep. Moves lease-expired `dispatched` rows (lease_until < now) and
 * abandoned `queued` rows (created before the caller-supplied cutoff) to
 * `indeterminate`, returning a count for each. Omitting `queuedCutoff` sweeps
 * only expired leases — no queued row is abandoned without an explicit cutoff.
 */
export async function sweepVoiceNotes(
  db: Database,
  now: Date,
  queuedCutoff?: Date,
): Promise<{ abandonedQueued: number; leaseExpired: number }> {
  const leaseExpired = await db
    .update(voiceNotes)
    .set({ state: "indeterminate", updatedAt: now })
    .where(and(
      eq(voiceNotes.state, "dispatched"),
      isNotNull(voiceNotes.leaseUntil),
      lt(voiceNotes.leaseUntil, now),
    ))
    .returning({ id: voiceNotes.id });

  let abandonedQueued: { id: number }[] = [];
  if (queuedCutoff !== undefined) {
    abandonedQueued = await db
      .update(voiceNotes)
      .set({ state: "indeterminate", updatedAt: now })
      .where(and(
        eq(voiceNotes.state, "queued"),
        lt(voiceNotes.createdAt, queuedCutoff),
      ))
      .returning({ id: voiceNotes.id });
  }

  return {
    abandonedQueued: abandonedQueued.length,
    leaseExpired: leaseExpired.length,
  };
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
