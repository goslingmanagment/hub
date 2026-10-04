import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

/** Certification covers every tracked endpoint and explicit unknown attribution
 * debt; it never makes an unvisited/failed endpoint fresh via another fan. The
 * legacy recovery roster that certified with it is gone (step 4, S4-16); it
 * stays the reader of that debt over the receipts the engine's
 * `fan-earnings.roster` writes. */
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
