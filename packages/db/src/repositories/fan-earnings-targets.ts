import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { tryAcquireDmArchiveWriterFenceLock } from "./erasure-fence.ts";
import type { FanEarningsClaim } from "./fan-earnings-refresh.ts";

/** Caller owns the page lease. A native fan reference is sufficient: zero,
 * negative and not-yet-discovered fans must not disappear behind spend filters. */
export async function claimFanEarningsTarget(db: Database, pageId: number, now: Date): Promise<FanEarningsClaim | null> {
  if (!await tryAcquireDmArchiveWriterFenceLock(db, pageId)) throw new Error("Earnings target deferred by active erasure");
  const token = randomUUID();
  const result = await db.execute<{ subject_ref: string; plane: string; claimed_revision: string }>(sql`
    with candidate as (
      select page_id, plane, subject_ref from subject_refresh_state
      where page_id = ${pageId} and plane in ('fan_earnings_lifetime','fan_earnings_monthly')
        and next_due_at <= ${now} and (retry_after_at is null or retry_after_at <= ${now})
        and (claim_token is null or claim_expires_at <= ${now})
      order by next_due_at, subject_ref, plane limit 1 for update skip locked
    )
    update subject_refresh_state s set claim_token = ${token}::uuid,
      claimed_revision = s.requested_revision, claim_expires_at = ${new Date(now.getTime() + 300_000)},
      updated_at = now()
    from candidate c where s.page_id = c.page_id and s.plane = c.plane and s.subject_ref = c.subject_ref
    returning s.subject_ref,s.plane,s.claimed_revision`);
  const row = result.rows[0];
  return row ? { pageId, fanRef: row.subject_ref, window: row.plane === "fan_earnings_lifetime" ? "lifetime" : "monthly",
    revision: Number(row.claimed_revision), token } : null;
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
export async function deferFanEarningsTarget(db: Database, claim: FanEarningsClaim, retryAt: Date) {
  await db.execute(sql`update subject_refresh_state set claim_token=null,claimed_revision=null,claim_expires_at=null,
    next_due_at=${retryAt},retry_after_at=greatest(retry_after_at,${retryAt}),updated_at=now()
    where page_id=${claim.pageId} and plane=${`fan_earnings_${claim.window}`} and subject_ref=${claim.fanRef}
      and claim_token=${claim.token}::uuid and claimed_revision=${claim.revision}`);
}
