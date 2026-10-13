import { sql } from "drizzle-orm";

import type { AppContext } from "../../../bootstrap.ts";
import {
  buildFanslyFanSpendingData,
  formatFanslyFanSpendingData,
  formatFanslyFanSubscriptionData,
  type FanslyFanSpendingData,
  type FanslyFanSubscriptionData,
  type FanslySpendingLedgerRow,
} from "../prompts/index.ts";

// chat-extension R20 HF-7г (parity row AI-145): spend and subscription of a
// Fansly fan for a request whose context the hub loads itself (no
// `clientContext`: the new chat-extension's path). The released Fansly
// extension reads both from Fansly on every generation and sends the blocks;
// here they come from what the hub already holds, in the same shape
// (prompts/context/fansly-spending.ts, fansly-subscription.ts):
//
//  - spend — the page's ledger (`transactions`, Fansly's wallet rows in mills),
//    summed in the database, so a fan's totals do not depend on how many rows
//    he has. The ledger's UTC months are the months of Fansly's own per-fan
//    earnings answer, which the extension read (the two agreed month for
//    month on production when this was written, 2026-10-13).
//  - subscription — `page_subscriptions`: the row the page's active list
//    serves, else the fan's last one. `page_fans` cannot answer for a fan who
//    left: its subscriber fields are cleared once no subscription is current.
//
// Both find the fan by `(platform, platform_user_id)`, the key `fans` is
// unique on: one index read, and never the other platform's fan. An account
// the hub has no fan row for gets neither block: the extension asked Fansly,
// which knows every account, while the hub cannot say that an id it has never
// seen (a new fan; a group's id sent where the fan's belongs) spent nothing.

type Db = Pick<AppContext, "db">;

export async function loadFanslySpendingContext(
  app: Db,
  input: {
    pageId: number;
    fanRef: string;
    /** A deep feature also reads the newest months by type. */
    deep: boolean;
  },
): Promise<{ block: string; data: FanslyFanSpendingData | null }> {
  // From the fan, so a fan without a ledger row still answers (one row of
  // nulls) and an unknown account answers nothing.
  const result = await app.db.execute<{
    year: number | null;
    month: number | null;
    canonical_type: string | null;
    raw_type: string | null;
    gross: string | null;
    net: string | null;
  }>(sql`
    select extract(year from timezone('UTC', t.occurred_at))::int as year,
           extract(month from timezone('UTC', t.occurred_at))::int as month,
           t.canonical_type::text as canonical_type,
           t.raw_type,
           sum(t.gross_amount_mills)::text as gross,
           sum(t.creator_net_amount_mills)::text as net
    from fans f
    left join transactions t
      on t.fan_id = f.id
     and t.platform_account_id = ${input.pageId}
     and t.is_active = true
    where f.platform = 'fansly'
      and f.platform_user_id = ${input.fanRef}
    group by 1, 2, 3, 4
  `);
  if (result.rows.length === 0) {
    return { block: "", data: null };
  }
  const rows: FanslySpendingLedgerRow[] = result.rows.flatMap((row) => (
    row.year === null || row.month === null || row.canonical_type === null || row.raw_type === null
      || row.gross === null || row.net === null
      ? []
      : [{
        year: Number(row.year),
        month: Number(row.month),
        canonicalType: row.canonical_type,
        rawType: row.raw_type,
        grossMills: BigInt(row.gross),
        netMills: BigInt(row.net),
      }]
  ));
  const data = buildFanslyFanSpendingData({ fanId: input.fanRef, rows, deep: input.deep });
  return { block: formatFanslyFanSpendingData(data), data };
}

export async function loadFanslySubscriptionContext(
  app: Db,
  input: { pageId: number; fanRef: string; now?: number },
): Promise<{ block: string; data: FanslyFanSubscriptionData | null }> {
  const result = await app.db.execute<{
    subscription_tier_name: string | null;
    raw_status: number;
    is_current: boolean;
    renew_price: string;
    auto_renew: boolean | null;
    billing_cycle_days: number | null;
    source_created_at: Date | null;
    ends_at: Date | null;
  }>(sql`
    select ps.subscription_tier_name, ps.raw_status, ps.is_current,
           ps.renew_price_mills::text as renew_price, ps.auto_renew,
           ps.billing_cycle_days, ps.source_created_at, ps.ends_at
    from page_subscriptions ps
    join fans f on f.id = ps.fan_id
    where ps.platform_account_id = ${input.pageId}
      and f.platform = 'fansly'
      and f.platform_user_id = ${input.fanRef}
    order by ps.is_current desc, ps.ends_at desc nulls last, ps.id desc
    limit 1
  `);
  const row = result.rows[0];
  const date = (value: Date | null) => (value ? new Date(value) : null);
  const data: FanslyFanSubscriptionData | null = row
    ? {
      subscriberId: input.fanRef,
      tierName: row.subscription_tier_name,
      rawStatus: Number(row.raw_status),
      isCurrent: row.is_current,
      renewPriceMills: BigInt(row.renew_price),
      autoRenew: row.auto_renew,
      billingCycleDays: row.billing_cycle_days === null ? null : Number(row.billing_cycle_days),
      createdAt: date(row.source_created_at),
      endsAt: date(row.ends_at),
    }
    : null;
  return { block: formatFanslyFanSubscriptionData(data, input.now), data };
}
