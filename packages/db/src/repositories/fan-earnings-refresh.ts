import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";

export type FanEarningsRefreshWindow = "lifetime" | "monthly";
export const fanEarningsPlane = (window: FanEarningsRefreshWindow) => `fan_earnings_${window}`;
const CLAIM_TTL_MS = 5 * 60_000;

export type FanEarningsClaim = {
  pageId: number;
  fanRef: string;
  window: FanEarningsRefreshWindow;
  token: string;
  revision: number;
};

/** Caller commits these marks with the semantic transaction change. Neither
 * the fan table nor a positive spend balance is required to retain a target. */
export async function markFanEarningsDirty(
  db: Database,
  input: { pageId: number; fanRefs: string[]; now: Date; statusOnly?: boolean },
) {
  const statusOnly = input.statusOnly === true;
  const reason = statusOnly ? "transaction_status_change" : "semantic_transaction_change";
  for (const fanRef of [...new Set(input.fanRefs)].sort()) {
    if (!fanRef) throw new Error("Missing earnings fan reference");
    await db.execute(sql`
      insert into subject_refresh_state (
        page_id, plane, subject_ref, refresh_class, next_due_at,
        dirty_reason, requested_revision, earnings_content_revision
      ) select ${input.pageId}, plane, ${fanRef}, 'dirty', ${input.now},
          ${reason}, 1, ${statusOnly ? 0 : 1}
        from unnest(array['fan_earnings_lifetime', 'fan_earnings_monthly']) as plane
      on conflict (page_id, plane, subject_ref) do update set
        requested_revision = subject_refresh_state.requested_revision + 1,
        -- A pre-deploy/rollback writer only records the strict reason. Carry
        -- its revision forward even if it did not know the new column.
        earnings_content_revision = case when not ${statusOnly}
          then subject_refresh_state.requested_revision + 1
          else greatest(subject_refresh_state.earnings_content_revision,
            case when subject_refresh_state.dirty_reason is distinct from 'transaction_status_change'
              then subject_refresh_state.requested_revision else 0 end) end,
        refresh_class = 'dirty', dirty_reason = excluded.dirty_reason,
        next_due_at = least(subject_refresh_state.next_due_at, excluded.next_due_at),
        updated_at = now()
    `);
  }
}

/** Unknown attribution cannot be scheduled as a fan. Keep one explicit debt
 * per transaction until a later semantic observation supplies the binding. */
export async function recordEarningsAttribution(
  db: Database,
  input: { pageId: number; transactionRef: string; known: boolean; now: Date },
) {
  if (input.known) {
    await db.execute(sql`
      update subject_refresh_state set applied_revision = requested_revision,
        refresh_class = null, dirty_reason = null, next_due_at = null,
        last_refresh_outcome = 'binding_resolved', updated_at = now()
      where page_id = ${input.pageId} and plane = 'fan_earnings_attribution'
        and subject_ref = ${input.transactionRef}
    `);
    return;
  }
  await db.execute(sql`
    insert into subject_refresh_state (
      page_id, plane, subject_ref, requested_revision, refresh_class, dirty_reason,
      last_refresh_outcome, next_due_at
    ) values (${input.pageId}, 'fan_earnings_attribution', ${input.transactionRef},
      1, 'dirty', 'unknown_attribution', 'unconfirmed', ${input.now})
    on conflict (page_id, plane, subject_ref) do update set
      requested_revision = subject_refresh_state.requested_revision + 1,
      refresh_class = 'dirty', dirty_reason = 'unknown_attribution',
      next_due_at = least(subject_refresh_state.next_due_at, excluded.next_due_at),
      last_refresh_outcome = 'unconfirmed', updated_at = now()
  `);
}

/** Claim only the fan already selected by daily rotation. C2b never selects
 * extra targets or changes rotation's request/retry policy. */
export async function claimFanEarningsRotation(
  db: Database,
  input: { pageId: number; fanRef: string; window: FanEarningsRefreshWindow; now: Date },
): Promise<FanEarningsClaim | null> {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    if (!await tryAcquireDmArchiveWriterFenceLock(tx, input.pageId)) {
      throw new Error("Earnings refresh deferred by active erasure");
    }
    await tx.execute(sql`
      insert into subject_refresh_state (page_id, plane, subject_ref)
      values (${input.pageId}, ${fanEarningsPlane(input.window)}, ${input.fanRef})
      on conflict (page_id, plane, subject_ref) do nothing
    `);
    const available = sql`(claim_token is null or claim_expires_at <= ${input.now})`;
    const result = await tx.execute<{ claimed_revision: string; claim_token: string }>(sql`
      update subject_refresh_state set refresh_visits = refresh_visits + 1,
        claimed_revision = case when ${available} then requested_revision else claimed_revision end,
        claim_token = case when ${available} then ${token}::uuid else claim_token end,
        claim_expires_at = case when ${available}
          then ${new Date(input.now.getTime() + CLAIM_TTL_MS)} else claim_expires_at end,
        updated_at = now()
      where page_id = ${input.pageId} and plane = ${fanEarningsPlane(input.window)}
        and subject_ref = ${input.fanRef}
      returning claimed_revision, claim_token
    `);
    const row = result.rows[0];
    return row?.claim_token === token ? { ...input, token, revision: Number(row.claimed_revision) } : null;
  });
}

/** Renew only the original claim, including after a slow fetch. The caller
 * must renew and settle inside one owned page-sync transaction. This never
 * acquires a replacement token, consumes R+1 or recreates erased state. */
export async function renewFanEarningsClaim(
  db: Database,
  claim: FanEarningsClaim,
  now: Date,
): Promise<boolean> {
  const result = await db.execute(sql`
    update subject_refresh_state
    set claim_expires_at = ${new Date(now.getTime() + CLAIM_TTL_MS)}, updated_at = now()
    where page_id = ${claim.pageId} and plane = ${fanEarningsPlane(claim.window)}
      and subject_ref = ${claim.fanRef} and claim_token = ${claim.token}::uuid
      and claimed_revision = ${claim.revision}
    returning page_id
  `);
  return (result.rowCount ?? 0) === 1;
}
