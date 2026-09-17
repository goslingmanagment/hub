import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";
import type { FanEarningsClaim } from "./fan-earnings-refresh.ts";

/** Caller owns the page lease. A native fan reference is sufficient: zero,
 * negative and not-yet-discovered fans must not disappear behind spend filters. */
export async function claimFanEarningsTarget(db: Database, pageId: number, now: Date, maxAgeMs?: number): Promise<(FanEarningsClaim & { ageSelected: boolean }) | null> {
  if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) throw new Error("Earnings target deferred by active erasure");
  const token = randomUUID();
  const result = await db.execute<{ subject_ref: string; plane: string; claimed_revision: string; age_selected: boolean }>(sql`
    with candidate as (
      select page_id, plane, subject_ref from subject_refresh_state
      where page_id = ${pageId} and plane in ('fan_earnings_lifetime','fan_earnings_monthly')
        and (next_due_at <= ${now} or (${maxAgeMs !== undefined}
          and (last_checked_at is null or last_checked_at <= ${new Date(now.getTime() - (maxAgeMs ?? 0))})))
        and (retry_after_at is null or retry_after_at <= ${now})
        and (claim_token is null or claim_expires_at <= ${now})
      order by coalesce(next_due_at, last_checked_at, created_at), subject_ref, plane limit 1 for update skip locked
    )
    update subject_refresh_state s set claim_token = ${token}::uuid,
      claimed_revision = s.requested_revision, claim_expires_at = ${new Date(now.getTime() + 300_000)},
      updated_at = now()
    from candidate c where s.page_id = c.page_id and s.plane = c.plane and s.subject_ref = c.subject_ref
    returning s.subject_ref,s.plane,s.claimed_revision,
      (s.next_due_at is null or s.next_due_at > ${now}) as age_selected`);
  const row = result.rows[0];
  return row ? { pageId, fanRef: row.subject_ref, window: row.plane === "fan_earnings_lifetime" ? "lifetime" : "monthly",
    revision: Number(row.claimed_revision), token, ageSelected: row.age_selected } : null;
}

/** Called under the locked page lease BEFORE a physical attempt. */
export async function admitFanEarningsTargetAttempt(db: Database, input: {
  claim: FanEarningsClaim; requestId: string; attemptNumber: number; syncRunId: number; limit24h: number; now: Date;
}) {
  const { claim } = input;
  const usage = await db.execute<{ n: string }>(sql`select count(*)::text n from fan_earnings_target_attempts
    where page_id = ${claim.pageId} and admitted_at > ${new Date(input.now.getTime() - 86_400_000)}`);
  if (Number(usage.rows[0]!.n) >= input.limit24h) return false;
  await db.execute(sql`insert into fan_earnings_target_attempts(page_id,request_id,attempt_number,sync_run_id,admitted_at)
    values (${claim.pageId},${input.requestId},${input.attemptNumber},${input.syncRunId},${input.now})`);
  const owned = await db.execute(sql`update subject_refresh_state
    set refresh_visits=refresh_visits+1,last_visited_at=${input.now},
      claim_expires_at=${new Date(input.now.getTime() + 300_000)},updated_at=now()
    where page_id=${claim.pageId} and plane=${`fan_earnings_${claim.window}`} and subject_ref=${claim.fanRef}
      and claim_token=${claim.token}::uuid and claimed_revision=${claim.revision} returning page_id`);
  if (!owned.rows.length) throw new Error("fan_earnings_target_claim_fenced");
  return true;
}

/** An admission refusal made no provider visit; keep the claim's revision
 * pending without manufacturing a failed/empty REST receipt. */
export async function deferFanEarningsTarget(db: Database, claim: FanEarningsClaim & { ageSelected?: boolean }, retryAt: Date) {
  await db.execute(sql`update subject_refresh_state set claim_token=null,claimed_revision=null,claim_expires_at=null,
    next_due_at=case when ${claim.ageSelected === true} then next_due_at else ${retryAt} end,retry_after_at=greatest(retry_after_at,${retryAt}),updated_at=now()
    where page_id=${claim.pageId} and plane=${`fan_earnings_${claim.window}`} and subject_ref=${claim.fanRef}
      and claim_token=${claim.token}::uuid and claimed_revision=${claim.revision}`);
}

/** Decision 368. A spender is fresh only when BOTH earnings endpoints carry a
 * VALID check inside the window, neither is dirty, neither is inside a
 * failure/provider cooldown and neither is mid-claim. A missing plane row is
 * never fresh. The conditions are deliberately at least as strict as
 * `countFanEarningsRecoveryDebt`, so a skip can never manufacture debt. */
export async function isFanEarningsFresh(db: Database, input: {
  pageId: number; fanRef: string; maxAgeMs: number; now: Date;
}): Promise<boolean> {
  const result = await db.execute<{ fresh: boolean }>(sql`
    select count(*) = 2 as fresh from subject_refresh_state
    where page_id = ${input.pageId} and subject_ref = ${input.fanRef}
      and plane in ('fan_earnings_lifetime','fan_earnings_monthly')
      and last_checked_at is not null
      and last_checked_at > ${new Date(input.now.getTime() - input.maxAgeMs)}
      and requested_revision <= applied_revision
      and claim_token is null
      and last_refresh_outcome = 'observed'
      and (retry_after_at is null or retry_after_at <= ${input.now})`);
  return result.rows[0]?.fresh === true;
}

/** Certification covers every tracked endpoint and explicit unknown attribution
 * debt; it never makes an unvisited/failed endpoint fresh via another fan. */
export async function countFanEarningsRecoveryDebt(db: Database, pageId: number, now: Date, maxAgeMs: number) {
  const result = await db.execute<{ count: string }>(sql`
    select count(*)::text count from subject_refresh_state
    where page_id=${pageId} and (
      (plane in ('fan_earnings_lifetime','fan_earnings_monthly') and (
        last_checked_at is null or last_checked_at <= ${new Date(now.getTime() - maxAgeMs)}
        or requested_revision > applied_revision or claim_token is not null
        or last_refresh_outcome is distinct from 'observed'))
      or (plane='fan_earnings_attribution' and requested_revision > applied_revision))`);
  return Number(result.rows[0]!.count);
}
