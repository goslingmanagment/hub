import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The owner's personal daily AI limit of a person (0336) and what the person
// spent inside one day. A row counts the way the gateway's common daily cap
// counts it (repositories/ai-usage.ts getAiGatewayDailyUsageTotals), only over
// all pages together. The shared pool of a day is what the people with a limit
// left unspent of it the day before; whoever is past their own limit spends
// from it.

type NumericValue = string | number | bigint | null | undefined;

function toNumber(value: NumericValue): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toNullableNumber(value: NumericValue): number | null {
  return value === null || value === undefined ? null : Number(value);
}

export interface AiDayRange {
  from: Date;
  toExclusive: Date;
}

const SPENT_IN_RANGE = (range: AiDayRange) => sql`
  event.completed_at >= ${range.from.toISOString()}::timestamptz
  and event.completed_at < ${range.toExclusive.toISOString()}::timestamptz
  and (event.provider is not null or event.gateway_outcome is not null or event.quota_accepted is not null)`;

/**
 * The person's limit as it stood at `at`, or now when `at` is absent. The
 * column holds only the limit now; its history is the owner's change journal
 * (services/ai-chatter-limits.ts writes `admin.ai_chatter_limit_update` on
 * every change), so a past day reads the last change before the day's end.
 */
function limitOf(at: Date | undefined) {
  if (at === undefined) return sql`member.ai_daily_limit_micro_usd`;
  return sql`(select (audit.metadata->>'dailyLimitMicroUsd')::bigint
                from audit_events audit
               where audit.event_type = 'admin.ai_chatter_limit_update'
                 and audit.metadata->>'userId' = member.id::text
                 and audit.created_at < ${at.toISOString()}::timestamptz
               order by audit.created_at desc, audit.id desc
               limit 1)`;
}

export interface AiLimitsAsOf {
  /** Count with the limits as they stood at this moment (the end of a past day); the limits now when absent. */
  limitsAt?: Date | undefined;
}

export interface AiPersonalLimitState {
  limitMicroUsd: number | null;
  spentMicroUsd: number;
}

/** One person's limit and spend inside the day; null when the person does not exist. */
export async function getAiPersonalLimitState(
  db: Database,
  input: { userId: number } & AiDayRange,
): Promise<AiPersonalLimitState | null> {
  const result = await db.execute(sql`
    select member.ai_daily_limit_micro_usd as "limitMicroUsd",
           (select coalesce(sum(event.cost_micro_usd), 0)::bigint
              from ai_usage_events event
             where event.user_id = member.id and ${SPENT_IN_RANGE(input)}) as "spentMicroUsd"
    from users member
    where member.id = ${input.userId}`);
  const row = result.rows[0] as { limitMicroUsd: NumericValue; spentMicroUsd: NumericValue } | undefined;
  if (!row) return null;
  return { limitMicroUsd: toNullableNumber(row.limitMicroUsd), spentMicroUsd: toNumber(row.spentMicroUsd) };
}

export interface AiPersonalLimitRow extends AiPersonalLimitState {
  userId: number;
  username: string;
  role: string;
  /** The limit as of `limitsAt` (the limit now without it); `limitMicroUsd` is always the limit now. */
  dayLimitMicroUsd: number | null;
  /** What the person's AI cost the day before. */
  yesterdaySpentMicroUsd: number;
}

export interface AiLimitDays {
  today: AiDayRange;
  yesterday: AiDayRange;
}

/** Every living person: their limit and their spend today and yesterday, the biggest spender today first. */
export async function listAiPersonalLimits(
  db: Database,
  days: AiLimitDays,
  options: AiLimitsAsOf = {},
): Promise<AiPersonalLimitRow[]> {
  const result = await db.execute(sql`
    select member.id as "userId",
           member.username,
           member.role::text as role,
           member.ai_daily_limit_micro_usd as "limitMicroUsd",
           coalesce(sum(event.cost_micro_usd) filter (where ${SPENT_IN_RANGE(days.today)}), 0)::bigint as "spentMicroUsd",
           coalesce(sum(event.cost_micro_usd) filter (where ${SPENT_IN_RANGE(days.yesterday)}), 0)::bigint as "yesterdaySpentMicroUsd",
           ${limitOf(options.limitsAt)} as "dayLimitMicroUsd"
    from users member
    left join ai_usage_events event on event.user_id = member.id
      and event.completed_at >= ${days.yesterday.from.toISOString()}::timestamptz
      and event.completed_at < ${days.today.toExclusive.toISOString()}::timestamptz
    where member.deleted_at is null and member.disabled_at is null
    group by member.id
    order by 5 desc, lower(member.username)`);
  return (result.rows as Array<Record<string, NumericValue | string>>).map((row) => ({
    userId: toNumber(row.userId as NumericValue),
    username: String(row.username),
    role: String(row.role),
    limitMicroUsd: toNullableNumber(row.limitMicroUsd as NumericValue),
    dayLimitMicroUsd: toNullableNumber(row.dayLimitMicroUsd as NumericValue),
    spentMicroUsd: toNumber(row.spentMicroUsd as NumericValue),
    yesterdaySpentMicroUsd: toNumber(row.yesterdaySpentMicroUsd as NumericValue),
  }));
}

export interface AiLimitPoolState {
  /** Yesterday's unspent limits of every living person with a limit. */
  poolMicroUsd: number;
  /** Today's spend past their own limits, all those people together. */
  usedMicroUsd: number;
}

/** Today's shared pool and how much of it is spent. */
export async function getAiLimitPoolState(
  db: Database,
  days: AiLimitDays,
  options: AiLimitsAsOf = {},
): Promise<AiLimitPoolState> {
  const result = await db.execute(sql`
    with limited as (
      select member_limit.id, member_limit.lim
        from (select member.id, ${limitOf(options.limitsAt)} as lim
                from users member
               where member.deleted_at is null and member.disabled_at is null) member_limit
       where member_limit.lim is not null
    ), spend as (
      select event.user_id,
             coalesce(sum(event.cost_micro_usd) filter (where ${SPENT_IN_RANGE(days.today)}), 0) as today,
             coalesce(sum(event.cost_micro_usd) filter (where ${SPENT_IN_RANGE(days.yesterday)}), 0) as yesterday
        from ai_usage_events event
       where event.user_id in (select id from limited)
         and event.completed_at >= ${days.yesterday.from.toISOString()}::timestamptz
         and event.completed_at < ${days.today.toExclusive.toISOString()}::timestamptz
       group by event.user_id
    )
    select coalesce(sum(greatest(limited.lim - coalesce(spend.yesterday, 0), 0)), 0)::bigint as "poolMicroUsd",
           coalesce(sum(greatest(coalesce(spend.today, 0) - limited.lim, 0)), 0)::bigint as "usedMicroUsd"
      from limited left join spend on spend.user_id = limited.id`);
  const row = result.rows[0] as { poolMicroUsd: NumericValue; usedMicroUsd: NumericValue } | undefined;
  return { poolMicroUsd: toNumber(row?.poolMicroUsd), usedMicroUsd: toNumber(row?.usedMicroUsd) };
}

/** Sets or clears (null) a living person's limit; false when there is no such person. */
export async function setAiPersonalDailyLimit(
  db: Database,
  input: { userId: number; limitMicroUsd: number | null; at: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update users
       set ai_daily_limit_micro_usd = ${input.limitMicroUsd},
           updated_at = ${input.at.toISOString()}::timestamptz
     where id = ${input.userId} and deleted_at is null
    returning id`);
  return result.rows.length > 0;
}
