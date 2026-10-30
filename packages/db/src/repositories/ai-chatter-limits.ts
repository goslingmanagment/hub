import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The owner's personal daily AI limit of a person (0336) and what the person
// spent inside one day. A row counts the way the gateway's common daily cap
// counts it (repositories/ai-usage.ts getAiGatewayDailyUsageTotals), only over
// all pages together.

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
}

/** Every living person: their limit and their spend inside the day, the biggest spender first. */
export async function listAiPersonalLimits(db: Database, range: AiDayRange): Promise<AiPersonalLimitRow[]> {
  const result = await db.execute(sql`
    select member.id as "userId",
           member.username,
           member.role::text as role,
           member.ai_daily_limit_micro_usd as "limitMicroUsd",
           coalesce(sum(event.cost_micro_usd), 0)::bigint as "spentMicroUsd"
    from users member
    left join ai_usage_events event on event.user_id = member.id and ${SPENT_IN_RANGE(range)}
    where member.deleted_at is null and member.disabled_at is null
    group by member.id
    order by coalesce(sum(event.cost_micro_usd), 0) desc, lower(member.username)`);
  return (result.rows as Array<Record<string, NumericValue | string>>).map((row) => ({
    userId: toNumber(row.userId as NumericValue),
    username: String(row.username),
    role: String(row.role),
    limitMicroUsd: toNullableNumber(row.limitMicroUsd as NumericValue),
    spentMicroUsd: toNumber(row.spentMicroUsd as NumericValue),
  }));
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
