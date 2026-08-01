import { and, eq, gt, isNull, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { agentKeys, type agentKeyUsageDaily } from "../schema.ts";

/**
 * Agent Read Plane keys and their daily budget counters.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. **Budget accounting is ONE statement.** The first request of a UTC day has
 *    no counter row yet, so a bare `UPDATE .. RETURNING` cannot budget it, and two
 *    concurrent requests must SUM rather than race. Every write is therefore
 *    `INSERT .. ON CONFLICT DO UPDATE .. RETURNING`, and the returning row is
 *    joined to the key so the caller compares consumption against the ceiling
 *    inside the same statement rather than in a second, racy round trip.
 * 2. **Expiry slides on use, but the hard cap ALWAYS wins.** Keys are never
 *    immortal: a live key stays alive (+90 days from now) while it is being used,
 *    but the ceiling holds at 365 days from issuance, at which point the owner
 *    must issue a new one. The clamp is written `least(greatest(current, slid),
 *    cap)` — an earlier revision put `greatest` on the outside, which PRESERVED
 *    an expiry already past the ceiling and made the cap advisory. Enforcement is
 *    also a table CHECK, so no path can mint an over-long key.
 * 3. **A revoked or expired key is inert.** Every mutation carries the
 *    `revoked_at is null and expires_at > now` guard, so touching a dead key
 *    neither stamps `last_used_at` nor resurrects its expiry; the caller gets
 *    `null` and refuses the request.
 *
 * `rows_returned` is a BIGINT and this pool parses OID 20 as a JavaScript BigInt,
 * so every read of it here casts to text and converts once, at the edge, with an
 * explicit safety check — a raw BigInt thrown at `JSON.stringify` throws.
 *
 * Constraint violations are translated into the typed errors below rather than
 * propagated: the driver's own message embeds the full statement AND its bound
 * parameters, which for this table include the key digest.
 */

/** A table constraint refused the write. Carries the rule, never the statement. */
export class AgentKeyConstraintError extends Error {
  readonly constraint: string;

  constructor(message: string, constraint: string) {
    super(message);
    this.name = "AgentKeyConstraintError";
    this.constraint = constraint;
  }
}

/** An issuance asked for a lifetime the ceiling does not allow. */
export class AgentKeyLifetimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentKeyLifetimeError";
  }
}

const CONSTRAINT_MESSAGES: Readonly<Record<string, string>> = {
  agent_keys_name_key: "an agent key with this name already exists",
  agent_keys_key_digest_key: "an agent key with this digest already exists",
  agent_keys_capabilities_check:
    "capability outside the closed matrix (see AGENT_CAPABILITIES in packages/contracts)",
  agent_keys_max_lifetime_check: "expires_at is beyond the 365-day ceiling from created_at",
  agent_keys_expires_at_check: "expires_at must be after created_at",
};

/**
 * Walks the driver's cause chain for the violated constraint. Postgres reports
 * it structurally (`error.constraint`); the surrounding message is deliberately
 * discarded, so a rejected insert cannot leak the digest it carried.
 */
function violatedConstraint(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (typeof constraint === "string" && constraint.length > 0) {
      return constraint;
    }
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return null;
}

function rethrowAsConstraintError(error: unknown): never {
  const constraint = violatedConstraint(error);
  if (constraint !== null) {
    throw new AgentKeyConstraintError(
      CONSTRAINT_MESSAGES[constraint] ?? `agent key write violated ${constraint}`,
      constraint,
    );
  }
  throw error;
}

export type AgentKeyRow = typeof agentKeys.$inferSelect;
export type AgentKeyUsageRow = typeof agentKeyUsageDaily.$inferSelect;

/** Sliding lifetime granted on each successful authentication. */
export const AGENT_KEY_SLIDING_TTL_DAYS = 90;
/** Hard ceiling measured from `created_at`; a key never lives longer than this. */
export const AGENT_KEY_MAX_LIFETIME_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * DAY_MS);
}

/**
 * BIGINT -> number at the edge. Above 2^53 a JavaScript number silently stops
 * counting, and a budget that silently stops counting is not a budget.
 */
function toSafeCount(value: string | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`agent key usage counter ${String(value)} exceeds the safe integer range`);
  }
  return parsed;
}

/** The UTC business date of an instant, matching the house `businessDate` convention. */
export function agentKeyBusinessDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface InsertAgentKeyInput {
  name: string;
  keyPrefix: string;
  keyDigest: string;
  capabilities: string[];
  pageIds: number[];
  dailyRequestBudget: number;
  dailyRowBudget: number;
  expiresAt: Date;
  createdBy: number | null;
  /** Issuance instant; defaults to the database `now()`. Tests pin it. */
  createdAt?: Date;
}

/**
 * Issues one key row.
 *
 * The requested lifetime is REJECTED, not silently clamped, when it exceeds the
 * ceiling: an owner who asked for two years and received a key that quietly
 * expires in one would learn about it from a broken agent, not from the issuance.
 *
 * The capability list is checked by the table's CHECK constraint (mapped here to
 * a typed error). The vocabulary itself lives in `packages/contracts`, which this
 * package deliberately does not depend on; the issuing route validates against
 * `AGENT_CAPABILITIES` before it ever reaches SQL, and this is the backstop.
 */
export async function insertAgentKey(
  db: Database,
  input: InsertAgentKeyInput,
): Promise<AgentKeyRow> {
  const ceiling = addDays(input.createdAt ?? new Date(), AGENT_KEY_MAX_LIFETIME_DAYS);
  if (input.expiresAt.getTime() > ceiling.getTime()) {
    throw new AgentKeyLifetimeError(
      `an agent key may not live past ${AGENT_KEY_MAX_LIFETIME_DAYS} days from issuance`,
    );
  }

  try {
    const [row] = await db
      .insert(agentKeys)
      .values({
        name: input.name,
        keyPrefix: input.keyPrefix,
        keyDigest: input.keyDigest,
        capabilities: input.capabilities,
        pageIds: input.pageIds,
        dailyRequestBudget: input.dailyRequestBudget,
        dailyRowBudget: input.dailyRowBudget,
        expiresAt: input.expiresAt,
        createdBy: input.createdBy,
        ...(input.createdAt ? { createdAt: input.createdAt } : {}),
      })
      .returning();

    if (!row) {
      throw new Error("insertAgentKey returned no row");
    }
    return row;
  } catch (error) {
    rethrowAsConstraintError(error);
  }
}

/** Lookup by digest. Returns revoked and expired keys too — the AUTHENTICATOR
 *  decides, so its rejection reasons stay testable in one place. */
export async function findAgentKeyByDigest(
  db: Database,
  keyDigest: string,
): Promise<AgentKeyRow | null> {
  const [row] = await db.select().from(agentKeys).where(eq(agentKeys.keyDigest, keyDigest)).limit(1);
  return row ?? null;
}

export async function getAgentKeyById(db: Database, id: number): Promise<AgentKeyRow | null> {
  const [row] = await db.select().from(agentKeys).where(eq(agentKeys.id, id)).limit(1);
  return row ?? null;
}

/** Owner-facing listing, newest first. */
export async function listAgentKeys(db: Database): Promise<AgentKeyRow[]> {
  return db.select().from(agentKeys).orderBy(sql`${agentKeys.createdAt} desc`);
}

/**
 * Revokes a key. Idempotent by construction: a second call finds no un-revoked row
 * and reports `false` rather than moving the original revocation timestamp.
 */
export async function revokeAgentKey(
  db: Database,
  input: { id: number; now?: Date },
): Promise<boolean> {
  const revoked = await db
    .update(agentKeys)
    .set({ revokedAt: input.now ?? new Date() })
    .where(and(eq(agentKeys.id, input.id), isNull(agentKeys.revokedAt)))
    .returning({ id: agentKeys.id });
  return revoked.length > 0;
}

export interface AgentKeyUseResult {
  lastUsedAt: Date;
  expiresAt: Date;
  /** True when the sliding extension was clamped by the 365-day hard cap. */
  cappedByMaxLifetime: boolean;
}

/**
 * Records a use: stamps `last_used_at` and slides `expires_at` to now + 90 days,
 * CLAMPED to created_at + 365 days.
 *
 * Order matters: `least(greatest(current, slid), cap)`. Putting `greatest` on the
 * outside — as the first revision did — preserves an expiry that already sits
 * past the ceiling, which makes the ceiling advisory and lets a key drift toward
 * immortal. A further-out expiry is preserved only while it is inside the cap.
 *
 * A revoked or already-expired key matches NOTHING: it must not get a fresh
 * `last_used_at` and must not have its expiry resurrected by the very request
 * that should have been refused. The caller sees `null` and denies.
 */
export async function recordAgentKeyUse(
  db: Database,
  input: { id: number; now?: Date },
): Promise<AgentKeyUseResult | null> {
  const now = input.now ?? new Date();
  const slid = addDays(now, AGENT_KEY_SLIDING_TTL_DAYS);

  const rows = await db
    .update(agentKeys)
    .set({
      lastUsedAt: now,
      expiresAt: sql`least(
        greatest(${agentKeys.expiresAt}, ${slid}::timestamptz),
        ${agentKeys.createdAt} + ${`${AGENT_KEY_MAX_LIFETIME_DAYS} days`}::interval
      )`,
    })
    .where(and(
      eq(agentKeys.id, input.id),
      isNull(agentKeys.revokedAt),
      gt(agentKeys.expiresAt, now),
    ))
    .returning({
      lastUsedAt: agentKeys.lastUsedAt,
      expiresAt: agentKeys.expiresAt,
    });

  const row = rows[0];
  if (!row || row.lastUsedAt === null) {
    return null;
  }
  return {
    lastUsedAt: row.lastUsedAt,
    // An expiry SHORTER than the requested slide can only come from the ceiling:
    // the inner `greatest` never returns less than `slid`, so anything smaller is
    // the outer clamp having bitten.
    expiresAt: row.expiresAt,
    cappedByMaxLifetime: row.expiresAt.getTime() < slid.getTime(),
  };
}

export interface AgentKeyBudgetState {
  businessDate: string;
  requests: number;
  rowsReturned: number;
  dailyRequestBudget: number;
  dailyRowBudget: number;
  /** False once EITHER ceiling is reached; the caller answers 429 and stops. */
  withinBudget: boolean;
}

/**
 * Adds consumption to the key's counter for one UTC day and returns the resulting
 * totals together with the key's ceilings — atomically, in a single statement, so
 * two concurrent requests sum instead of both reading the pre-increment value.
 *
 * Callers reserve BEFORE serving and settle the real row count afterwards; the
 * returned `withinBudget` is the authority on whether this request may proceed.
 */
export async function bumpAgentKeyUsage(
  db: Database,
  input: { agentKeyId: number; requests?: number; rows?: number; now?: Date },
): Promise<AgentKeyBudgetState> {
  const businessDate = agentKeyBusinessDate(input.now ?? new Date());
  const requests = input.requests ?? 0;
  const rows = input.rows ?? 0;

  const result = await db.execute<{
    requests: number;
    rows_returned: string;
    daily_request_budget: number;
    daily_row_budget: number;
  }>(sql`
    with bumped as (
      insert into agent_key_usage_daily (agent_key_id, business_date, requests, rows_returned)
      values (${input.agentKeyId}, ${businessDate}::date, ${requests}, ${rows})
      on conflict (agent_key_id, business_date) do update set
        requests = agent_key_usage_daily.requests + excluded.requests,
        rows_returned = agent_key_usage_daily.rows_returned + excluded.rows_returned,
        updated_at = now()
      returning agent_key_id, requests, rows_returned
    )
    select
      bumped.requests as requests,
      bumped.rows_returned::text as rows_returned,
      k.daily_request_budget as daily_request_budget,
      k.daily_row_budget as daily_row_budget
    from bumped
    join agent_keys k on k.id = bumped.agent_key_id
  `);

  const row = result.rows[0];
  if (!row) {
    throw new Error(`agent key ${input.agentKeyId} has no budget row after upsert`);
  }

  const totalRequests = Number(row.requests);
  const totalRows = toSafeCount(row.rows_returned);
  return {
    businessDate,
    requests: totalRequests,
    rowsReturned: totalRows,
    dailyRequestBudget: row.daily_request_budget,
    dailyRowBudget: row.daily_row_budget,
    withinBudget: totalRequests <= row.daily_request_budget && totalRows <= row.daily_row_budget,
  };
}

export interface AgentKeyRowReservation {
  businessDate: string;
  /** How many rows this call was actually allowed to take. Never more than what
   *  the ceiling still had, and never negative on a reservation. */
  granted: number;
  /** The counter AFTER this call. Never above `dailyRowBudget`. */
  rowsReturned: number;
  dailyRowBudget: number;
}

/**
 * RESERVES row allowance before a page is served, atomically, and clamped to the
 * ceiling.
 *
 * Why a reservation and not "serve, then add": the counter was read at the start of
 * a request and written at the end, so two concurrent requests both saw the same
 * allowance and both spent it — a key with 100 rows left served 400. Reserving
 * first makes the ceiling a real bound instead of an after-the-fact report.
 *
 * ATOMICITY: the row is locked with `for update` before the arithmetic, so a
 * concurrent reservation waits and then reads the post-commit value. `insert ..
 * on conflict do nothing` first, because the first request of a UTC day has no
 * counter row to lock (the same reason every other write here is an upsert).
 *
 * A NEGATIVE `rows` is a REFUND: a handler reserves the page size it asked for and
 * gives back what it did not use. A refund is bounded below by zero and is never
 * clamped by the ceiling, so returning unused allowance always works.
 */
export async function reserveAgentKeyRows(
  db: Database,
  input: { agentKeyId: number; rows: number; now?: Date },
): Promise<AgentKeyRowReservation> {
  const businessDate = agentKeyBusinessDate(input.now ?? new Date());
  const requested = Math.trunc(input.rows);

  return db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into agent_key_usage_daily (agent_key_id, business_date, requests, rows_returned)
      values (${input.agentKeyId}, ${businessDate}::date, 0, 0)
      on conflict (agent_key_id, business_date) do nothing
    `);
    const current = await tx.execute<{ rows_returned: string; daily_row_budget: number }>(sql`
      select u.rows_returned::text as rows_returned, k.daily_row_budget
      from agent_key_usage_daily u
      join agent_keys k on k.id = u.agent_key_id
      where u.agent_key_id = ${input.agentKeyId} and u.business_date = ${businessDate}::date
      for no key update of u
    `);
    const row = current.rows[0];
    if (!row) {
      throw new Error(`agent key ${input.agentKeyId} has no budget row after upsert`);
    }
    const used = toSafeCount(row.rows_returned);
    const budget = Number(row.daily_row_budget);
    // A ceiling lowered by the owner below what is already spent must not force a
    // negative refund out of a reservation: the allowance is simply zero.
    const granted = requested >= 0
      ? Math.max(0, Math.min(requested, budget - used))
      : Math.max(requested, -used);
    if (granted !== 0) {
      await tx.execute(sql`
        update agent_key_usage_daily
        set rows_returned = rows_returned + ${granted}, updated_at = now()
        where agent_key_id = ${input.agentKeyId} and business_date = ${businessDate}::date
      `);
    }
    return {
      businessDate,
      granted,
      rowsReturned: used + granted,
      dailyRowBudget: budget,
    };
  });
}

/** Read-only view of one key's counter for a UTC day (the capabilities response). */
export async function getAgentKeyUsage(
  db: Database,
  input: { agentKeyId: number; now?: Date },
): Promise<{ businessDate: string; requests: number; rowsReturned: number }> {
  const businessDate = agentKeyBusinessDate(input.now ?? new Date());
  const result = await db.execute<{ requests: number; rows_returned: string }>(sql`
    select requests, rows_returned::text as rows_returned
    from agent_key_usage_daily
    where agent_key_id = ${input.agentKeyId} and business_date = ${businessDate}::date
  `);
  const row = result.rows[0];
  return {
    businessDate,
    requests: row ? Number(row.requests) : 0,
    rowsReturned: row ? toSafeCount(row.rows_returned) : 0,
  };
}
