import { and, eq, isNull, sql } from "drizzle-orm";

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
 * 2. **Expiry slides on use, but never past the hard cap.** Keys are never
 *    immortal: a live key stays alive (+90 days from now) while it is being used,
 *    but the cap holds at 365 days from issuance, at which point the owner must
 *    issue a new one. This mirrors the device-token precedent.
 *
 * `rows_returned` is a BIGINT and this pool parses OID 20 as a JavaScript BigInt,
 * so every read of it here casts to text and converts once, at the edge, with an
 * explicit safety check — a raw BigInt thrown at `JSON.stringify` throws.
 */

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
}

/**
 * Issues one key row. Capability validation against the closed matrix belongs to
 * the caller (issuance rejects an unknown capability rather than dropping it); the
 * table's CHECK constraint is the fail-closed backstop.
 */
export async function insertAgentKey(
  db: Database,
  input: InsertAgentKeyInput,
): Promise<AgentKeyRow> {
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
    })
    .returning();

  if (!row) {
    throw new Error("insertAgentKey returned no row");
  }
  return row;
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
 * Records a use: stamps `last_used_at` and slides `expires_at` to
 * now + 90 days, clamped to created_at + 365 days. Never SHORTENS an existing
 * expiry (`greatest`), so a key issued with a long custom expiry is not silently
 * cut back by its own traffic.
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
      expiresAt: sql`greatest(
        ${agentKeys.expiresAt},
        least(
          ${slid}::timestamptz,
          ${agentKeys.createdAt} + ${`${AGENT_KEY_MAX_LIFETIME_DAYS} days`}::interval
        )
      )`,
    })
    .where(eq(agentKeys.id, input.id))
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
    // A resulting expiry SHORTER than the requested slide can only come from the
    // hard cap: `greatest` never shortens, and the slide itself is the target.
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
