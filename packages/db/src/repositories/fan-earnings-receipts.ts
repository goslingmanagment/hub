import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import {
  fanEarningsPlane, type FanEarningsClaim, type FanEarningsRefreshWindow,
} from "./fan-earnings-refresh.ts";

export type FanEarningsReceipt = {
  outcome: "observed" | "empty" | "invalid" | "rejected" | "failed";
  observationId: number | null;
  fingerprint: string | null;
  checkedAt: Date;
  retryAfterAt?: Date | null;
};

/** A changed valid snapshot settles the claimed R. An unchanged valid recheck
 * settles R only when every content-changing (money/type/binding) revision is
 * applied or preceded the first sighting of this baseline, i.e. the baseline
 * read was claimed at or after it; a first baseline confirms nothing. Exact
 * status-only transitions need no content change. Neither path consumes R+1
 * or invents a change. Legacy writers' strict reason keeps every revision
 * content-changing. */
export async function settleFanEarningsReceipt(
  db: Database,
  claim: FanEarningsClaim,
  receipt: FanEarningsReceipt,
): Promise<boolean> {
  const valid = receipt.outcome === "observed" && receipt.observationId !== null
    && receipt.fingerprint !== null;
  const rejected = receipt.outcome === "rejected";
  const retryAt = new Date(Math.max(
    receipt.checkedAt.getTime() + 15 * 60_000,
    receipt.retryAfterAt?.getTime() ?? 0,
  ));
  const result = await db.execute(sql`
    with owned as (
      select s.*,
        ${valid} and s.last_content_fingerprint is not null
          and s.last_content_fingerprint is distinct from ${receipt.fingerprint} as changed,
        ${valid} and s.last_content_fingerprint is distinct from ${receipt.fingerprint} as new_baseline,
        s.claimed_revision > s.applied_revision as had_signal,
        ${valid} and s.last_content_fingerprint = ${receipt.fingerprint} as unchanged,
        case when s.dirty_reason = 'transaction_status_change' then s.earnings_content_revision
          else s.requested_revision end as content_revision
      from subject_refresh_state s
      where s.page_id = ${claim.pageId} and s.plane = ${fanEarningsPlane(claim.window)}
        and s.subject_ref = ${claim.fanRef} and s.claim_token = ${claim.token}::uuid
        and s.claimed_revision = ${claim.revision}
        and s.claim_expires_at > ${receipt.checkedAt}
      for update
    ), confirmed as (
      select owned.*, changed or coalesce(unchanged and (content_revision <= applied_revision
        or content_baseline_revision >= content_revision), false) as can_settle from owned
    )
    update subject_refresh_state s set
      applied_revision = case when o.can_settle then o.claimed_revision else o.applied_revision end,
      claim_token = null, claimed_revision = null, claim_expires_at = null,
      last_visited_at = ${receipt.checkedAt},
      last_checked_at = case when ${valid} then ${receipt.checkedAt} else o.last_checked_at end,
      last_changed_at = case when o.changed then ${receipt.checkedAt} else o.last_changed_at end,
      last_receipt_observation_id = ${receipt.observationId},
      last_checked_observation_id = case when ${valid}
        then ${receipt.observationId} else o.last_checked_observation_id end,
      last_content_fingerprint = case when ${valid}
        then ${receipt.fingerprint} else o.last_content_fingerprint end,
      content_baseline_at = case when o.new_baseline
        then ${receipt.checkedAt} else o.content_baseline_at end,
      content_baseline_revision = case when o.new_baseline
        then o.claimed_revision else o.content_baseline_revision end,
      last_refresh_outcome = case when ${valid} and o.had_signal and not o.can_settle
        then 'unconfirmed' else ${receipt.outcome} end,
      refresh_receipts = o.refresh_receipts + 1,
      refresh_checks = o.refresh_checks + case when ${valid} then 1 else 0 end,
      refresh_changes = o.refresh_changes + case when o.changed then 1 else 0 end,
      unsignaled_changes = o.unsignaled_changes + case when o.changed and not o.had_signal then 1 else 0 end,
      consecutive_failures = case when ${valid} then 0 else o.consecutive_failures + 1 end,
      consecutive_rejections = case when ${rejected} then o.consecutive_rejections + 1 else 0 end,
      refresh_class = case when o.requested_revision >
        case when o.can_settle then o.claimed_revision else o.applied_revision end then 'dirty' else null end,
      next_due_at = case
        when o.requested_revision > o.claimed_revision then least(o.next_due_at, ${retryAt})
        when not ${valid} or (o.had_signal and not o.can_settle) then ${retryAt}
        else null end,
      retry_after_at = case when not ${valid} or (o.had_signal and not o.can_settle)
        then greatest(o.retry_after_at, ${retryAt}) else null end,
      updated_at = now()
    from confirmed o where s.page_id = o.page_id and s.plane = o.plane and s.subject_ref = o.subject_ref
    returning s.page_id
  `);
  return (result.rowCount ?? 0) === 1;
}

/** A walk may cross an endpoint's rejection only after its own receipt is
 * durable: stored at or after `since`, with the claim released. Returns that
 * endpoint's current run of rejected receipts, or null. */
export async function findDurableFanEarningsRejection(
  db: Database,
  input: { pageId: number; fanRef: string; window: FanEarningsRefreshWindow; since: Date },
): Promise<{ consecutiveRejections: number } | null> {
  const result = await db.execute<{ consecutive_rejections: number }>(sql`
    select consecutive_rejections from subject_refresh_state
    where page_id = ${input.pageId} and plane = ${fanEarningsPlane(input.window)}
      and subject_ref = ${input.fanRef} and claim_token is null
      and last_refresh_outcome = 'rejected' and last_visited_at >= ${input.since}
  `);
  const row = result.rows[0];
  return row ? { consecutiveRejections: Number(row.consecutive_rejections) } : null;
}
