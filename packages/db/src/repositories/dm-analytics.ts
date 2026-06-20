import { and, gte, lte, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { dmMessageDailyAggregates } from "../schema.ts";

const BUSINESS_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function assertBusinessDate(value: string, field: string) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !BUSINESS_DATE_PATTERN.test(value)
    || Number.isNaN(parsed.getTime())
    || parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
}

function assertBusinessDateRange(fromBusinessDate: string, throughBusinessDate: string) {
  assertBusinessDate(fromBusinessDate, "fromBusinessDate");
  assertBusinessDate(throughBusinessDate, "throughBusinessDate");
  if (fromBusinessDate > throughBusinessDate) {
    throw new Error("fromBusinessDate must not be after throughBusinessDate");
  }
}

export interface RebuildDmMessageDailyAggregatesInput {
  fromBusinessDate: string;
  throughBusinessDate: string;
  rebuiltAt?: Date;
}

export async function rebuildDmMessageDailyAggregates(
  db: Database,
  input: RebuildDmMessageDailyAggregatesInput,
) {
  assertBusinessDateRange(input.fromBusinessDate, input.throughBusinessDate);

  const rebuiltAt = input.rebuiltAt ?? new Date();
  return db.transaction(async (tx) => {
    await tx
      .delete(dmMessageDailyAggregates)
      .where(and(
        gte(dmMessageDailyAggregates.businessDate, input.fromBusinessDate),
        lte(dmMessageDailyAggregates.businessDate, input.throughBusinessDate),
      ));

    const result = await tx.execute<{
      platform_account_id: number | string;
      business_date: string;
    }>(sql`
      insert into dm_message_daily_aggregates (
        platform_account_id,
        business_date,
        archive_rows,
        inbound_messages,
        outbound_messages,
        deleted_messages,
        distinct_conversations,
        paid_outbound_messages,
        paid_outbound_price_mills,
        tip_messages,
        tip_amount_mills,
        first_message_at,
        last_message_at,
        source_max_fanout_seq,
        rebuilt_at
      )
      select
        platform_account_id,
        (coalesce(message_created_at, deleted_at, source_received_at) at time zone 'UTC')::date,
        count(*)::int,
        count(*) filter (where sender_role = 'fan' and deleted_at is null)::int,
        count(*) filter (where sender_role = 'model' and deleted_at is null)::int,
        count(*) filter (where deleted_at is not null)::int,
        count(distinct platform_conversation_id)
          filter (where platform_conversation_id is not null and deleted_at is null)::int,
        count(*) filter (
          where sender_role = 'model'
            and deleted_at is null
            and coalesce(price_mills, 0) > 0
        )::int,
        coalesce(sum(price_mills) filter (
          where sender_role = 'model' and deleted_at is null
        ), 0)::bigint,
        count(*) filter (where is_tip and deleted_at is null)::int,
        coalesce(sum(tip_amount_mills) filter (where deleted_at is null), 0)::bigint,
        min(message_created_at) filter (where deleted_at is null),
        max(message_created_at) filter (where deleted_at is null),
        max(source_fanout_seq),
        ${rebuiltAt}
      from dm_message_archive
      where coalesce(message_created_at, deleted_at, source_received_at) >=
          ${input.fromBusinessDate}::date
        and coalesce(message_created_at, deleted_at, source_received_at) <
          (${input.throughBusinessDate}::date + interval '1 day')
      group by
        platform_account_id,
        (coalesce(message_created_at, deleted_at, source_received_at) at time zone 'UTC')::date
      returning platform_account_id, business_date
    `);

    return {
      fromBusinessDate: input.fromBusinessDate,
      throughBusinessDate: input.throughBusinessDate,
      rowCount: result.rows.length,
      rebuiltAt,
    };
  });
}

export async function listDmMessageDailyAggregates(
  db: Database,
  input: {
    fromBusinessDate: string;
    throughBusinessDate: string;
  },
) {
  assertBusinessDateRange(input.fromBusinessDate, input.throughBusinessDate);
  return db.query.dmMessageDailyAggregates.findMany({
    where: and(
      gte(dmMessageDailyAggregates.businessDate, input.fromBusinessDate),
      lte(dmMessageDailyAggregates.businessDate, input.throughBusinessDate),
    ),
    orderBy: (table, { asc }) => [asc(table.businessDate), asc(table.platformAccountId)],
  });
}
