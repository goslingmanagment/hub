import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The fan's card across pages (Chat Memory week 2,
// docs/plans/2026-10-24-chat-memory/week-2.md §1–2): raw SQL over fans,
// page_fans, fan_spend_lifetime / fan_spend_daily and fan_links (0307). The
// route (apps/runtime services/fan-card.ts) decides who may read and what of
// another page is shown; this file reads and records.

export interface CardFan {
  id: number;
  platform: string;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  /** The account is gone or hidden on the platform, as far as Hub saw. */
  gone: boolean;
}

const fanColumns = sql`f.id, f.platform, f.platform_user_id, f.username, f.display_name,
  (f.deleted_detected_at is not null or coalesce(f.public_found = false, false)) as gone`;

type FanRow = {
  id: string | number; platform: string; platform_user_id: string; username: string | null; display_name: string | null; gone: boolean;
};

const fanOf = (row: FanRow): CardFan => ({
  id: Number(row.id),
  platform: row.platform,
  platformUserId: row.platform_user_id,
  username: row.username,
  displayName: row.display_name,
  gone: row.gone,
});

export async function findCardFan(db: Database, platform: string, platformUserId: string): Promise<CardFan | null> {
  const result = await db.execute<FanRow>(sql`
    select ${fanColumns} from fans f where f.platform = ${platform} and f.platform_user_id = ${platformUserId}`);
  return result.rows[0] ? fanOf(result.rows[0]) : null;
}

/** The fan and every account linked to it by `same` pairs, the asked fan first. */
export async function listPersonFans(db: Database, fanId: number): Promise<Array<CardFan & { linkedByUsername: string | null }>> {
  const result = await db.execute<FanRow & { linked_by: string | null; depth: number }>(sql`
    with recursive person(fan_id, depth, linked_by) as (
      select ${fanId}::bigint, 0, null::bigint
      union
      select case when l.fan_id = p.fan_id then l.other_fan_id else l.fan_id end, p.depth + 1, l.decided_by_user_id
      from fan_links l
      join person p on l.decision = 'same' and (l.fan_id = p.fan_id or l.other_fan_id = p.fan_id)
      where p.depth < 20
    ),
    firsts as (select distinct on (fan_id) fan_id, depth, linked_by from person order by fan_id, depth)
    select ${fanColumns}, u.username as linked_by, x.depth
    from firsts x
    join fans f on f.id = x.fan_id
    left join users u on u.id = x.linked_by
    order by x.depth, f.id`);
  return result.rows.map((row) => ({ ...fanOf(row), linkedByUsername: row.linked_by }));
}

export interface CardPageRow {
  fanId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  modelName: string | null;
  alias: string | null;
  isSubscriber: boolean;
  subscriberSince: Date | null;
  subscriptionExpiresAt: Date | null;
  lifetimeGrossMills: number;
  lastPurchaseAt: Date | null;
  /** Gross mills of the last 30 days by kind (subscription, tip, message_purchase, post_purchase, other). */
  last30GrossMills: Record<string, number>;
}

/** Each page the fans are on: the team's alias, the subscription and the money. */
export async function listCardPages(db: Database, fanIds: readonly number[], now: Date): Promise<CardPageRow[]> {
  if (fanIds.length === 0) return [];
  const result = await db.execute<{
    fan_id: string | number; page_id: string | number; label: string; platform: string; model_name: string | null;
    page_alias: string | null; is_subscriber: boolean | null; subscriber_since: Date | string | null;
    subscription_expires_at: Date | string | null; lifetime_gross: string | number; last_transaction_at: Date | string | null;
    last30: Record<string, string | number> | null;
  }>(sql`
    select pf.fan_id, p.id as page_id, p.label, p.platform, m.name as model_name, pf.page_alias,
      pf.is_subscriber, pf.subscriber_since, pf.subscription_expires_at,
      coalesce(l.gross_amount_mills, 0) as lifetime_gross,
      coalesce(l.last_transaction_at, pf.last_transaction_at) as last_transaction_at,
      (
        select jsonb_object_agg(x.canonical_type, x.gross)
        from (
          select d.canonical_type, sum(d.gross_amount_mills) as gross
          from fan_spend_daily d
          where d.fan_id = pf.fan_id and d.platform_account_id = pf.platform_account_id
            and d.business_date >= (${now.toISOString()}::timestamptz at time zone 'UTC')::date - 30
          group by 1
        ) x
      ) as last30
    from page_fans pf
    join pages p on p.id = pf.platform_account_id
    left join models m on m.id = p.model_id
    left join fan_spend_lifetime l on l.fan_id = pf.fan_id and l.platform_account_id = pf.platform_account_id
    where pf.fan_id = any(${sql.param(fanIds.map(String))}::bigint[]) and p.deleted_at is null
    order by coalesce(l.gross_amount_mills, 0) desc, p.label`);
  return result.rows.map((row) => ({
    fanId: Number(row.fan_id),
    pageId: Number(row.page_id),
    pageLabel: row.label,
    platform: row.platform,
    modelName: row.model_name,
    alias: row.page_alias,
    isSubscriber: row.is_subscriber === true,
    subscriberSince: row.subscriber_since === null ? null : new Date(row.subscriber_since),
    subscriptionExpiresAt: row.subscription_expires_at === null ? null : new Date(row.subscription_expires_at),
    lifetimeGrossMills: Number(row.lifetime_gross),
    lastPurchaseAt: row.last_transaction_at === null ? null : new Date(row.last_transaction_at),
    last30GrossMills: Object.fromEntries(Object.entries(row.last30 ?? {}).map(([kind, mills]) => [kind, Number(mills)])),
  }));
}

export type FanLinkReasonKind = "same_alias" | "same_username" | "replaced_account";

export interface FanLinkSuggestionRow {
  fan: CardFan;
  reasonKind: FanLinkReasonKind;
  /** The alias, the username or the name both share, and where («Kai/Canada/38» on lora-1). */
  shared: string;
  pageLabel: string | null;
}

/**
 * Accounts that may be the same person as the person's fans, from what Hub
 * holds — never a request to a platform:
 * - `same_alias`: the team gave another account the same «nick/country/age»
 *   alias on a page of the same model (only an alias with a `/`, 6+ letters,
 *   not the blank template «User/Country»);
 * - `same_username`: an account on the other platform with the same username
 *   (4+ letters);
 * - `replaced_account`: a gone account on a page of the same model that shares
 *   a 4+-letter name (username or the first word of the display name) and that
 *   spent there, while the person's account came later.
 * Pairs already decided (either way) and the person's own fans are left out.
 * Most-spending first, at most `limit`.
 */
export async function listFanLinkSuggestions(
  db: Database,
  input: { personFanIds: readonly number[]; limit: number },
): Promise<FanLinkSuggestionRow[]> {
  if (input.personFanIds.length === 0) return [];
  const ids = sql`${sql.param(input.personFanIds.map(String))}::bigint[]`;
  const result = await db.execute<FanRow & { reason_kind: FanLinkReasonKind; shared: string; page_label: string | null; spent: string | number }>(sql`
    with person_pages as (
      select pf.fan_id, pf.platform_account_id, p.model_id, pf.page_alias
      from page_fans pf join pages p on p.id = pf.platform_account_id
      where pf.fan_id = any(${ids}) and p.deleted_at is null
    ),
    person_fans as (
      select f.* from fans f where f.id = any(${ids})
    ),
    person_names as (
      select distinct name from (
        select lower(f.username) as name from person_fans f
        union all
        select lower(regexp_replace(split_part(trim(f.display_name), ' ', 1), '[^[:alnum:]]', '', 'g')) from person_fans f
      ) n where length(name) >= 4
    ),
    alias_matches as (
      select other.fan_id as other_id, 'same_alias'::text as reason_kind, other.page_alias as shared, op.label as page_label
      from person_pages mine
      join pages mp on mp.id = mine.platform_account_id
      join pages op on op.model_id = mp.model_id and op.deleted_at is null
      join page_fans other on other.platform_account_id = op.id
      where mine.page_alias like '%/%' and other.page_alias like '%/%'
        and length(regexp_replace(mine.page_alias, '[^[:alnum:]/]', '', 'g')) >= 6
        -- The team's blank template («User/Country») names nobody.
        and lower(regexp_replace(mine.page_alias, '[^[:alnum:]/]', '', 'g')) !~ '^(user|name|имя|ник)/'
        and lower(regexp_replace(other.page_alias, '[^[:alnum:]/]', '', 'g')) = lower(regexp_replace(mine.page_alias, '[^[:alnum:]/]', '', 'g'))
    ),
    username_matches as (
      select other.id as other_id, 'same_username'::text as reason_kind, other.username as shared, null::text as page_label
      from person_fans mine
      join fans other on other.platform <> mine.platform and lower(other.username) = lower(mine.username)
      where length(mine.username) >= 4
    ),
    replaced_matches as (
      select other.id as other_id, 'replaced_account'::text as reason_kind,
        coalesce(other.display_name, other.username) as shared, op.label as page_label
      from person_pages mine
      join pages mp on mp.id = mine.platform_account_id
      join pages op on op.model_id = mp.model_id and op.deleted_at is null
      join page_fans opf on opf.platform_account_id = op.id
      join fans other on other.id = opf.fan_id
      join fan_spend_lifetime ol on ol.fan_id = other.id and ol.platform_account_id = op.id and ol.gross_amount_mills > 0
      where (other.deleted_detected_at is not null or other.public_found = false or opf.account_contactability in ('gone', 'blocked'))
        and exists (
          select 1 from person_names n
          where n.name = lower(other.username)
            or n.name = lower(regexp_replace(split_part(trim(other.display_name), ' ', 1), '[^[:alnum:]]', '', 'g'))
        )
        and exists (select 1 from person_fans pf where pf.first_seen_at > other.first_seen_at)
    ),
    candidates as (
      select * from alias_matches union all select * from username_matches union all select * from replaced_matches
    ),
    open as (
      select distinct on (c.other_id) c.*
      from candidates c
      where not (c.other_id = any(${ids}))
        and not exists (
          select 1 from fan_links l
          where (l.fan_id = c.other_id and l.other_fan_id = any(${ids}))
             or (l.other_fan_id = c.other_id and l.fan_id = any(${ids}))
        )
      order by c.other_id, case c.reason_kind when 'same_alias' then 0 when 'same_username' then 1 else 2 end
    )
    select ${fanColumns}, o.reason_kind, o.shared, o.page_label,
      coalesce((select sum(l.gross_amount_mills) from fan_spend_lifetime l where l.fan_id = f.id), 0) as spent
    from open o
    join fans f on f.id = o.other_id
    order by spent desc, f.id
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    fan: fanOf(row),
    reasonKind: row.reason_kind,
    shared: row.shared,
    pageLabel: row.page_label,
  }));
}

export type FanLinkDecision = "same" | "different";

/** Records a chatter's decision on a pair; a pair decided before keeps its first decision. Answers whether this one was recorded. */
export async function recordFanLinkDecision(
  db: Database,
  input: { fanId: number; otherFanId: number; decision: FanLinkDecision; reasonKind: FanLinkReasonKind; reasonDetail: string | null; userId: number },
): Promise<{ recorded: boolean; decision: FanLinkDecision }> {
  const [low, high] = input.fanId < input.otherFanId ? [input.fanId, input.otherFanId] : [input.otherFanId, input.fanId];
  const inserted = await db.execute<{ decision: FanLinkDecision }>(sql`
    insert into fan_links (fan_id, other_fan_id, decision, reason_kind, reason_detail, decided_by_user_id)
    values (${low}, ${high}, ${input.decision}, ${input.reasonKind}, ${input.reasonDetail}, ${input.userId})
    on conflict (fan_id, other_fan_id) do nothing
    returning decision`);
  if (inserted.rows[0]) return { recorded: true, decision: inserted.rows[0].decision };
  const stored = await db.execute<{ decision: FanLinkDecision }>(sql`
    select decision from fan_links where fan_id = ${low} and other_fan_id = ${high}`);
  return { recorded: false, decision: stored.rows[0]!.decision };
}

/** The decision a pair already has, if any. */
export async function findFanLinkDecision(db: Database, fanId: number, otherFanId: number): Promise<FanLinkDecision | null> {
  const [low, high] = fanId < otherFanId ? [fanId, otherFanId] : [otherFanId, fanId];
  const result = await db.execute<{ decision: FanLinkDecision }>(sql`
    select decision from fan_links where fan_id = ${low} and other_fan_id = ${high}`);
  return result.rows[0]?.decision ?? null;
}
