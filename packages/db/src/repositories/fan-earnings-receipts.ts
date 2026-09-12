import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";
import { fanEarningsPlane, type FanEarningsClaim } from "./fan-earnings-refresh.ts";

export type FanEarningsReceipt = {
  outcome: "observed" | "empty" | "invalid" | "rejected" | "failed";
  observationId: number | null;
  fingerprint: string | null;
  checkedAt: Date;
  retryAfterAt?: Date | null;
};

/** An unchanged/baseline response after a signal cannot prove the provider has
 * recalculated. Keep that revision pending; C2b records debt without fetching
 * it. A changed snapshot settles at most R and never erases an in-flight R+1. */
export async function settleFanEarningsReceipt(
  db: Database,
  claim: FanEarningsClaim,
  receipt: FanEarningsReceipt,
): Promise<boolean> {
  const valid = receipt.outcome === "observed" && receipt.observationId !== null
    && receipt.fingerprint !== null;
  const retryAt = new Date(Math.max(
    receipt.checkedAt.getTime() + 15 * 60_000,
    receipt.retryAfterAt?.getTime() ?? 0,
  ));
  const result = await db.execute(sql`
    with owned as (
      select s.*,
        ${valid} and s.last_content_fingerprint is not null
          and s.last_content_fingerprint is distinct from ${receipt.fingerprint} as changed,
        s.claimed_revision > s.applied_revision as had_signal
      from subject_refresh_state s
      where s.page_id = ${claim.pageId} and s.plane = ${fanEarningsPlane(claim.window)}
        and s.subject_ref = ${claim.fanRef} and s.claim_token = ${claim.token}::uuid
        and s.claimed_revision = ${claim.revision}
        and s.claim_expires_at > ${receipt.checkedAt}
      for update
    )
    update subject_refresh_state s set
      applied_revision = case when o.changed then o.claimed_revision else o.applied_revision end,
      claim_token = null, claimed_revision = null, claim_expires_at = null,
      last_visited_at = ${receipt.checkedAt},
      last_checked_at = case when ${valid} then ${receipt.checkedAt} else o.last_checked_at end,
      last_changed_at = case when o.changed then ${receipt.checkedAt} else o.last_changed_at end,
      last_receipt_observation_id = ${receipt.observationId},
      last_checked_observation_id = case when ${valid}
        then ${receipt.observationId} else o.last_checked_observation_id end,
      last_content_fingerprint = case when ${valid}
        then ${receipt.fingerprint} else o.last_content_fingerprint end,
      last_refresh_outcome = case when ${valid} and o.had_signal and not o.changed
        then 'unconfirmed' else ${receipt.outcome} end,
      refresh_receipts = o.refresh_receipts + 1,
      refresh_checks = o.refresh_checks + case when ${valid} then 1 else 0 end,
      refresh_changes = o.refresh_changes + case when o.changed then 1 else 0 end,
      unsignaled_changes = o.unsignaled_changes + case when o.changed and not o.had_signal then 1 else 0 end,
      consecutive_failures = case when ${valid} then 0 else o.consecutive_failures + 1 end,
      refresh_class = case when o.requested_revision >
        case when o.changed then o.claimed_revision else o.applied_revision end then 'dirty' else null end,
      next_due_at = case
        when o.requested_revision > o.claimed_revision then least(o.next_due_at, ${retryAt})
        when not ${valid} or (o.had_signal and not o.changed) then ${retryAt}
        else null end,
      retry_after_at = case when not ${valid} or (o.had_signal and not o.changed)
        then greatest(o.retry_after_at, ${retryAt}) else null end,
      updated_at = now()
    from owned o where s.page_id = o.page_id and s.plane = o.plane and s.subject_ref = o.subject_ref
    returning s.page_id
  `);
  return (result.rowCount ?? 0) === 1;
}
