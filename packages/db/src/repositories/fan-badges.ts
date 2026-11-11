import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Fan badges (0373): FBuddy's spending tier and Fansly's «Recent Spender» mark
// of a fan, as chatters' browsers read them (`clientFanBadges`). Raw SQL over
// fan_badges, one row per fan. The route (apps/runtime
// services/client-fan-badges.ts) decides who may report for which page, which
// fans changed, and journals the change first; this file reads the stored
// badges and writes the changes and the once-a-day confirmations, each in one
// statement over arrays.

/** The table's CHECK list, mirrored: FBuddy's tiers, and `none` — FBuddy answered and has no tier for the fan. */
export const FAN_BADGE_STORED_TIERS = ["basic", "bronze", "silver", "gold", "platinum", "none"] as const;
export type FanBadgeStoredTier = (typeof FAN_BADGE_STORED_TIERS)[number];

export interface StoredFanBadges {
  fanId: number;
  fbuddyTier: FanBadgeStoredTier | null;
  fbuddyTierCheckedAt: Date | null;
  recentSpender: boolean | null;
  recentSpenderCheckedAt: Date | null;
}

/** The stored badges of these fans, by fan id; a fan without a row is absent. */
export async function readFanBadges(db: Database, fanIds: readonly number[]): Promise<Map<number, StoredFanBadges>> {
  if (fanIds.length === 0) return new Map();
  const result = await db.execute<{
    fan_id: string | number; fbuddy_tier: string | null; fbuddy_tier_checked_at: Date | string | null;
    recent_spender: boolean | null; recent_spender_checked_at: Date | string | null;
  }>(sql`
    select fan_id, fbuddy_tier, fbuddy_tier_checked_at, recent_spender, recent_spender_checked_at
    from fan_badges
    where fan_id = any(${sql.param(fanIds.map(String))}::bigint[])`);
  const at = (value: Date | string | null) => (value === null ? null : new Date(value));
  return new Map(result.rows.map((row) => [Number(row.fan_id), {
    fanId: Number(row.fan_id),
    fbuddyTier: row.fbuddy_tier as FanBadgeStoredTier | null,
    fbuddyTierCheckedAt: at(row.fbuddy_tier_checked_at),
    recentSpender: row.recent_spender,
    recentSpenderCheckedAt: at(row.recent_spender_checked_at),
  }]));
}

export interface FanBadgesWrite {
  fanId: number;
  /** Undefined: not reported, the stored value stays. */
  fbuddyTier?: FanBadgeStoredTier;
  recentSpender?: boolean;
}

/**
 * Writes what a report brings, in one statement. Per field, against the row as it is now (so two reports racing for
 * one fan agree): a reported value Hub lacks or holds another of is kept with `*_since` and `*_checked_at` = `now`; the
 * same value only moves `*_checked_at` to `now`, and only when the stored one is before `confirmBefore`; a field not
 * reported is left alone. The caller passes only the fans it found something to write for; a row a racing report left
 * with nothing to change is not updated.
 */
export async function writeFanBadges(
  db: Database,
  input: { now: Date; confirmBefore: Date; fans: readonly FanBadgesWrite[] },
): Promise<void> {
  if (input.fans.length === 0) return;
  const now = input.now.toISOString();
  const confirmBefore = input.confirmBefore.toISOString();
  await db.execute(sql`
    insert into fan_badges as b (
      fan_id, fbuddy_tier, fbuddy_tier_since, fbuddy_tier_checked_at,
      recent_spender, recent_spender_since, recent_spender_checked_at
    )
    select r.fan_id,
      r.tier,
      case when r.tier is null then null else ${now}::timestamptz end,
      case when r.tier is null then null else ${now}::timestamptz end,
      r.spender,
      case when r.spender is null then null else ${now}::timestamptz end,
      case when r.spender is null then null else ${now}::timestamptz end
    from unnest(
      ${sql.param(input.fans.map((fan) => String(fan.fanId)))}::bigint[],
      ${sql.param(input.fans.map((fan) => fan.fbuddyTier ?? null))}::text[],
      ${sql.param(input.fans.map((fan) => fan.recentSpender ?? null))}::boolean[]
    ) as r(fan_id, tier, spender)
    -- One order for every report: two reports of overlapping fans lock their rows the same way round.
    order by r.fan_id
    on conflict (fan_id) do update set
      fbuddy_tier = coalesce(excluded.fbuddy_tier, b.fbuddy_tier),
      fbuddy_tier_since = case
        when excluded.fbuddy_tier is not null and excluded.fbuddy_tier is distinct from b.fbuddy_tier then excluded.fbuddy_tier_since
        else b.fbuddy_tier_since end,
      fbuddy_tier_checked_at = case
        when excluded.fbuddy_tier is null then b.fbuddy_tier_checked_at
        when excluded.fbuddy_tier is distinct from b.fbuddy_tier or b.fbuddy_tier_checked_at < ${confirmBefore}::timestamptz
          then excluded.fbuddy_tier_checked_at
        else b.fbuddy_tier_checked_at end,
      recent_spender = coalesce(excluded.recent_spender, b.recent_spender),
      recent_spender_since = case
        when excluded.recent_spender is not null and excluded.recent_spender is distinct from b.recent_spender then excluded.recent_spender_since
        else b.recent_spender_since end,
      recent_spender_checked_at = case
        when excluded.recent_spender is null then b.recent_spender_checked_at
        when excluded.recent_spender is distinct from b.recent_spender or b.recent_spender_checked_at < ${confirmBefore}::timestamptz
          then excluded.recent_spender_checked_at
        else b.recent_spender_checked_at end
    where (excluded.fbuddy_tier is not null and (
        excluded.fbuddy_tier is distinct from b.fbuddy_tier or b.fbuddy_tier_checked_at < ${confirmBefore}::timestamptz))
      or (excluded.recent_spender is not null and (
        excluded.recent_spender is distinct from b.recent_spender or b.recent_spender_checked_at < ${confirmBefore}::timestamptz))`);
}
