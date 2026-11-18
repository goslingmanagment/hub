// The page of one OnlyFans link, beside link-stats-read.ts: the fans the link
// brought (the projection of the paid walks of its fan lists, migration 0260,
// written by link-fans.ts), whether a link ever had a source and where its
// binding would start, the sources' vocabulary a new link's name is read
// against, and the links without a source the matter check looks at.
// Read-only.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { livePageSql } from "./realm.ts";

type LinkKind = "tracking" | "trial";

export interface OfLinkKey {
  pageId: number;
  linkKind: LinkKind;
  linkRef: string;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

const linkWhere = (alias: string, link: OfLinkKey) => sql`${sql.raw(alias)}.platform_account_id = ${link.pageId}
  and ${sql.raw(alias)}.link_kind = ${link.linkKind} and ${sql.raw(alias)}.platform_link_id = ${link.linkRef}`;

export interface OfLinkFanRow {
  fanId: number;
  fanRef: string;
  pageAlias: string | null;
  displayName: string | null;
  username: string | null;
  deleted: boolean;
  /** The platform's subscription date when the walk carries one, otherwise the start of the fan's first period on the
   *  link; null: before the link's floor, or no period at all. */
  subscribedAt: Date | null;
  firstSeenAt: Date;
  inSubscriberList: boolean;
  lastSeenActive: boolean | null;
  absentWalks: number;
  vendorNetMills: bigint | null;
}

export interface OfLinkFansRead {
  total: number;
  /** Fans with money above zero. */
  paying: number;
  /** Fans whose money is known at all. */
  moneyKnown: number;
  /** The latest finished walk of any list of the link. */
  walkedAt: Date | null;
  fans: OfLinkFanRow[];
}

/**
 * One link's fans, by the vendor's money for them (highest first, unknown
 * last), then the newest first. A deleted fan's names are not read.
 */
export async function readOfLinkFans(
  db: Database,
  input: OfLinkKey & { limit: number; offset: number },
): Promise<OfLinkFansRead> {
  const counts = await db.execute<{ total: number; paying: number; money_known: number; walked_at: Date | string | null }>(sql`
    select count(*)::int as total,
           count(*) filter (where lf.vendor_revenue_net_mills > 0)::int as paying,
           count(lf.vendor_revenue_net_mills)::int as money_known,
           (select max(w.finished_at) from page_link_fan_walks w where ${linkWhere("w", input)}) as walked_at
      from page_link_fans lf
     where ${linkWhere("lf", input)}
  `);
  const rows = await db.execute<{
    fan_id: string; fan_ref: string; page_alias: string | null; display_name: string | null; username: string | null;
    deleted: boolean; subscribed_at: Date | string | null; first_seen_at: Date | string; in_subscriber_list: boolean;
    last_seen_active: boolean | null; absent_walks: number; vendor_net: string | null;
  }>(sql`
    select lf.fan_id::text as fan_id, f.platform_user_id as fan_ref,
           case when f.deleted_detected_at is null then pf.page_alias end as page_alias,
           case when f.deleted_detected_at is null then f.display_name end as display_name,
           case when f.deleted_detected_at is null then f.username end as username,
           f.deleted_detected_at is not null as deleted,
           coalesce(lf.vendor_subscribed_at, first_period.period_start_at) as subscribed_at,
           lf.first_seen_at, lf.in_subscriber_list, lf.last_seen_active, lf.absent_walks,
           lf.vendor_revenue_net_mills::text as vendor_net
      from page_link_fans lf
      join fans f on f.id = lf.fan_id
      left join page_fans pf on pf.fan_id = lf.fan_id and pf.platform_account_id = lf.platform_account_id
      left join lateral (
        select p.period_start_at from page_link_fan_periods p
         where p.link_fan_id = lf.id
         order by p.opened_at, p.id
         limit 1
      ) first_period on true
     where ${linkWhere("lf", input)}
     order by lf.vendor_revenue_net_mills desc nulls last,
              coalesce(lf.vendor_subscribed_at, first_period.period_start_at, lf.first_seen_at) desc, lf.id desc
     limit ${input.limit} offset ${input.offset}
  `);
  const head = counts.rows[0];
  return {
    total: Number(head?.total ?? 0),
    paying: Number(head?.paying ?? 0),
    moneyKnown: Number(head?.money_known ?? 0),
    walkedAt: toDateOrNull(head?.walked_at ?? null),
    fans: rows.rows.map((row) => ({
      fanId: Number(row.fan_id),
      fanRef: row.fan_ref,
      pageAlias: row.page_alias,
      displayName: row.display_name,
      username: row.username,
      deleted: row.deleted,
      subscribedAt: toDateOrNull(row.subscribed_at),
      firstSeenAt: toDate(row.first_seen_at),
      inSubscriberList: row.in_subscriber_list,
      lastSeenActive: row.last_seen_active,
      absentWalks: Number(row.absent_walks),
      vendorNetMills: row.vendor_net === null ? null : BigInt(row.vendor_net),
    })),
  };
}

export interface OfLinkSeriesStart {
  /** The series has seen the link. */
  seen: boolean;
  name: string | null;
  /** The latest snapshot's link_created_at. */
  linkCreatedAt: Date | null;
  /** When the series first read the link. */
  firstObservedAt: Date | null;
}

/** What the series knows of when a link began: the latest snapshot's creation date and the link's first read. */
export async function readOfLinkSeriesStart(db: Database, link: OfLinkKey): Promise<OfLinkSeriesStart> {
  const result = await db.execute<{ name: string | null; link_created_at: Date | string | null; first_observed_at: Date | string | null }>(sql`
    select (select s.name from page_link_stat_snapshots s join page_link_stat_runs r on r.id = s.run_id
             where ${linkWhere("s", link)} order by r.pulled_at desc, s.id desc limit 1) as name,
           (select s.link_created_at from page_link_stat_snapshots s join page_link_stat_runs r on r.id = s.run_id
             where ${linkWhere("s", link)} order by r.pulled_at desc, s.id desc limit 1) as link_created_at,
           (select min(r.pulled_at) from page_link_stat_snapshots s join page_link_stat_runs r on r.id = s.run_id
             where ${linkWhere("s", link)}) as first_observed_at
  `);
  const row = result.rows[0];
  const firstObservedAt = toDateOrNull(row?.first_observed_at ?? null);
  return {
    seen: firstObservedAt !== null,
    name: row?.name ?? null,
    linkCreatedAt: toDateOrNull(row?.link_created_at ?? null),
    firstObservedAt,
  };
}

/** Whether the link has a binding at any time: open, closed or one that starts later. */
export async function ofLinkHasTrafficBinding(db: Database, link: OfLinkKey): Promise<boolean> {
  const result = await db.execute<{ bound: boolean }>(sql`
    select exists (select 1 from traffic_link_bindings b where ${linkWhere("b", link)}) as bound
  `);
  return result.rows[0]?.bound === true;
}

export interface TrafficSourceVocabularyRow {
  key: string;
  title: string;
  /** The latest names of the links bound to the source at any time. */
  linkNames: string[];
}

/** Every source with the names of its links: what a new link's name is read against. */
export async function readTrafficSourceVocabulary(db: Database): Promise<TrafficSourceVocabularyRow[]> {
  const result = await db.execute<{ key: string; title: string; link_names: string[] | null }>(sql`
    select c.key, c.title,
           array_remove(array_agg(distinct latest.name), null) as link_names
      from traffic_channels c
      left join traffic_link_bindings b on b.channel_id = c.id
      left join lateral (
        select s.name from page_link_stat_snapshots s join page_link_stat_runs r on r.id = s.run_id
         where s.platform_account_id = b.platform_account_id and s.link_kind = b.link_kind
           and s.platform_link_id = b.platform_link_id
         order by r.pulled_at desc, s.id desc
         limit 1
      ) latest on true
     group by c.key, c.title
     order by c.title, c.key
  `);
  return result.rows.map((row) => ({ key: row.key, title: row.title, linkNames: row.link_names ?? [] }));
}

export interface UnboundOfLinkRow extends OfLinkKey {
  pageLabel: string;
  name: string | null;
  linkCreatedAt: Date | null;
  linkEndsAt: Date | null;
  isFinished: boolean | null;
  firstObservedAt: Date;
  /** Fans (claims of a trial link, subscribers of a tracking link) at the latest read; null: unknown. */
  fansNow: number | null;
  /** The same at the last read at or before `fanSince`, else at the link's first read. */
  fansThen: number | null;
}

/**
 * The OnlyFans links of the live, active pages that have no binding at any
 * time, with what the matter check weighs: when the link was made, whether it
 * ended, and its fans now against `fanSince`.
 */
export async function listUnboundOfLinks(db: Database, input: { fanSince: Date }): Promise<UnboundOfLinkRow[]> {
  const fans = sql.raw("case when s.link_kind = 'trial' then s.claims_count else s.subscribers_count end");
  const result = await db.execute<{
    page_id: string; page_label: string; link_kind: LinkKind; link_ref: string; name: string | null;
    link_created_at: Date | string | null; link_ends_at: Date | string | null; is_finished: boolean | null;
    first_observed_at: Date | string; fans_now: number | null; fans_then: number | null;
  }>(sql`
    with links as (
      select distinct on (s.platform_account_id, s.link_kind, s.platform_link_id)
             s.platform_account_id, s.link_kind, s.platform_link_id, s.name, s.link_created_at, s.link_ends_at,
             s.is_finished, ${fans} as fans_now
        from page_link_stat_snapshots s
        join page_link_stat_runs r on r.id = s.run_id
        join pages p on p.id = s.platform_account_id
       where p.platform = 'onlyfans' and p.status = 'active' and ${livePageSql(sql`p.id`)}
         and not exists (
           select 1 from traffic_link_bindings b
            where b.platform_account_id = s.platform_account_id and b.link_kind = s.link_kind
              and b.platform_link_id = s.platform_link_id)
       order by s.platform_account_id, s.link_kind, s.platform_link_id, r.pulled_at desc, s.id desc
    )
    select l.platform_account_id::text as page_id, p.label as page_label, l.link_kind, l.platform_link_id as link_ref,
           l.name, l.link_created_at, l.link_ends_at, l.is_finished, l.fans_now,
           first_read.observed_at as first_observed_at,
           coalesce(then_read.fans, first_read.fans) as fans_then
      from links l
      join pages p on p.id = l.platform_account_id
      join lateral (
        select r.pulled_at as observed_at, ${fans} as fans
          from page_link_stat_snapshots s join page_link_stat_runs r on r.id = s.run_id
         where s.platform_account_id = l.platform_account_id and s.link_kind = l.link_kind
           and s.platform_link_id = l.platform_link_id
         order by r.pulled_at, s.id
         limit 1
      ) first_read on true
      left join lateral (
        select ${fans} as fans
          from page_link_stat_snapshots s join page_link_stat_runs r on r.id = s.run_id
         where s.platform_account_id = l.platform_account_id and s.link_kind = l.link_kind
           and s.platform_link_id = l.platform_link_id and r.pulled_at <= ${input.fanSince}
         order by r.pulled_at desc, s.id desc
         limit 1
      ) then_read on true
     order by l.platform_account_id, l.link_kind, l.platform_link_id
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    linkKind: row.link_kind,
    linkRef: row.link_ref,
    name: row.name,
    linkCreatedAt: toDateOrNull(row.link_created_at),
    linkEndsAt: toDateOrNull(row.link_ends_at),
    isFinished: row.is_finished,
    firstObservedAt: toDate(row.first_observed_at),
    fansNow: row.fans_now === null ? null : Number(row.fans_now),
    fansThen: row.fans_then === null ? null : Number(row.fans_then),
  }));
}
