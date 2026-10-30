// What Fansly's creator pages show about selling, read out of the projections
// Hub has written for months and never served: the tiers with their plans and
// promotions, the gift links, the tracking links (with what they brought in
// the last 7 and 30 days, from the daily snapshots), the creator's place among
// creators per month («Top X%»), the yearly Recap, the polls, the automated
// messages and the mass messages with their delivery and sales.
//
// Read-only. Money is mills; a balance or a sum of one page is far below 2^53,
// so it is a JS number on the wire, as everywhere in the insights routes.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const at = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function isoMs(value: unknown): string | null {
  const ms = num(value);
  return ms === null || ms <= 0 ? null : new Date(ms).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  if (typeof value === "string") {
    try {
      return list(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

// ── tiers, plans, promotions ─────────────────────────────────────────────────

export interface PagePromoPromotion {
  promoRef: string | null;
  priceMills: number | null;
  durationDays: number | null;
  status: number | null;
  maxUses: number | null;
  newSubscribersOnly: boolean;
  startsAt: string | null;
  endsAt: string | null;
  description: string | null;
}

export interface PagePromoPlan {
  planRef: string;
  status: number | null;
  durationDays: number | null;
  priceMills: number | null;
  missingSince: string | null;
  promotions: PagePromoPromotion[];
}

export interface PagePromoTier {
  tierRef: string;
  name: string | null;
  color: string | null;
  pos: number | null;
  basePriceMills: number | null;
  maxSubscribers: number | null;
  benefits: string[];
  missingSince: string | null;
  plans: PagePromoPlan[];
}

function promotionOf(value: unknown): PagePromoPromotion {
  const promo = record(value);
  return {
    promoRef: text(promo.id),
    priceMills: num(promo.price),
    durationDays: num(promo.duration),
    status: num(promo.status),
    maxUses: num(promo.maxUses),
    newSubscribersOnly: promo.newSubscribersOnly === 1 || promo.newSubscribersOnly === true,
    startsAt: isoMs(promo.startsAt),
    endsAt: isoMs(promo.endsAt),
    description: text(promo.description),
  };
}

async function readTiers(db: Database, pageId: number): Promise<PagePromoTier[]> {
  const tiers = await db.execute<Record<string, unknown>>(sql`
    select tier_ref, name, color, pos, base_price_mills, max_subscribers, subscription_benefits, missing_since
      from page_subscription_tiers
     where page_id = ${pageId}
     order by missing_since is not null, pos asc nulls last, tier_ref asc
  `);
  const plans = await db.execute<Record<string, unknown>>(sql`
    select tier_ref, plan_ref, status, duration_days, price_mills, promos, missing_since
      from page_subscription_tier_plans
     where page_id = ${pageId}
     order by tier_ref asc, duration_days asc nulls last, plan_ref asc
  `);
  return tiers.rows.map((row) => ({
    tierRef: String(row.tier_ref),
    name: text(row.name),
    color: text(row.color),
    pos: num(row.pos),
    basePriceMills: num(row.base_price_mills),
    maxSubscribers: num(row.max_subscribers),
    benefits: list(row.subscription_benefits).filter((item): item is string => typeof item === "string"),
    missingSince: iso(row.missing_since),
    plans: plans.rows
      .filter((plan) => String(plan.tier_ref) === String(row.tier_ref))
      .map((plan) => ({
        planRef: String(plan.plan_ref),
        status: num(plan.status),
        durationDays: num(plan.duration_days),
        priceMills: num(plan.price_mills),
        missingSince: iso(plan.missing_since),
        promotions: list(plan.promos).map(promotionOf),
      })),
  }));
}

// ── gift links and tracking links (daily snapshots) ──────────────────────────

export interface PagePromoGiftLink {
  linkRef: string;
  label: string | null;
  status: number | null;
  priceMills: number | null;
  originalPriceMills: number | null;
  durationDays: number | null;
  uses: number | null;
  maxUses: number | null;
  newSubscribersOnly: boolean;
  createdAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  missingSince: string | null;
  lastSeenDay: string;
}

export interface PagePromoLinkGrowth {
  /** The snapshot day the growth is counted from (the latest at or before N days back). */
  sinceDay: string;
  clicks: number | null;
  claims: number | null;
  follows: number | null;
  subscriptions: number | null;
  /** Fansly serves a link's revenue gross only (`totalNet` is always 0). */
  grossMills: number | null;
}

export interface PagePromoTrackingLink {
  linkRef: string;
  label: string | null;
  description: string | null;
  /** 1 Fansly's own (FYP, Suggestions, Search); 1000 a link the creator made. */
  linkType: number | null;
  status: number | null;
  createdAt: string | null;
  clicks: number | null;
  claims: number | null;
  follows: number | null;
  subscriptions: number | null;
  grossMills: number | null;
  netMills: number | null;
  missingSince: string | null;
  lastSeenDay: string;
  /** Since the snapshot 7 / 30 days before the latest; null without one. */
  last7: PagePromoLinkGrowth | null;
  last30: PagePromoLinkGrowth | null;
}

async function readGiftLinks(db: Database, pageId: number): Promise<PagePromoGiftLink[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    select distinct on (link_ref)
           link_ref, label, status, price_mills, original_price_mills, metadata, uses, max_uses,
           created_at_platform, starts_at_platform, ends_at_platform, missing_since, business_date::text as day
      from page_promo_links
     where page_id = ${pageId} and link_kind = 'gift_code'
     order by link_ref, business_date desc
  `);
  return result.rows
    .map((row) => {
      const metadata = record(row.metadata);
      return {
        linkRef: String(row.link_ref),
        label: text(row.label),
        status: num(row.status),
        priceMills: num(row.price_mills),
        originalPriceMills: num(row.original_price_mills),
        durationDays: num(metadata.durationDays),
        uses: num(row.uses),
        maxUses: num(row.max_uses),
        newSubscribersOnly: metadata.newSubscribersOnly === 1 || metadata.newSubscribersOnly === true,
        createdAt: iso(row.created_at_platform),
        startsAt: iso(row.starts_at_platform),
        endsAt: iso(row.ends_at_platform),
        missingSince: iso(row.missing_since),
        lastSeenDay: String(row.day),
      };
    })
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

async function readTrackingLinks(db: Database, pageId: number): Promise<PagePromoTrackingLink[]> {
  const result = await db.execute<Record<string, unknown>>(sql`
    with snaps as (
      select link_ref, business_date, label, description, link_type, status, created_at_platform,
             clicks, claims, follows, subscriptions, total_gross_mills, total_net_mills, missing_since
        from page_promo_links
       where page_id = ${pageId} and link_kind = 'tracking'
    ), latest as (
      select distinct on (link_ref) * from snaps order by link_ref, business_date desc
    )
    select l.*, l.business_date::text as day,
           w.business_date::text as w_day, w.clicks as w_clicks, w.claims as w_claims, w.follows as w_follows,
           w.subscriptions as w_subscriptions, w.total_gross_mills as w_gross,
           m.business_date::text as m_day, m.clicks as m_clicks, m.claims as m_claims, m.follows as m_follows,
           m.subscriptions as m_subscriptions, m.total_gross_mills as m_gross
      from latest l
      left join lateral (
        select * from snaps s where s.link_ref = l.link_ref and s.business_date <= l.business_date - 7
         order by s.business_date desc limit 1
      ) w on true
      left join lateral (
        select * from snaps s where s.link_ref = l.link_ref and s.business_date <= l.business_date - 30
         order by s.business_date desc limit 1
      ) m on true
  `);
  const growth = (row: Record<string, unknown>, prefix: "w" | "m"): PagePromoLinkGrowth | null => {
    const day = text(row[`${prefix}_day`]);
    if (day === null) return null;
    const delta = (now: unknown, then: unknown) => {
      const a = num(now);
      const b = num(then);
      return a === null || b === null ? null : a - b;
    };
    return {
      sinceDay: day,
      clicks: delta(row.clicks, row[`${prefix}_clicks`]),
      claims: delta(row.claims, row[`${prefix}_claims`]),
      follows: delta(row.follows, row[`${prefix}_follows`]),
      subscriptions: delta(row.subscriptions, row[`${prefix}_subscriptions`]),
      grossMills: delta(row.total_gross_mills, row[`${prefix}_gross`]),
    };
  };
  return result.rows
    .map((row) => ({
      linkRef: String(row.link_ref),
      label: text(row.label),
      description: text(row.description),
      linkType: num(row.link_type),
      status: num(row.status),
      createdAt: iso(row.created_at_platform),
      clicks: num(row.clicks),
      claims: num(row.claims),
      follows: num(row.follows),
      subscriptions: num(row.subscriptions),
      grossMills: num(row.total_gross_mills),
      netMills: num(row.total_net_mills),
      missingSince: iso(row.missing_since),
      lastSeenDay: String(row.day),
      last7: growth(row, "w"),
      last30: growth(row, "m"),
    }))
    .sort((a, b) => (b.subscriptions ?? -1) - (a.subscriptions ?? -1) || (b.claims ?? -1) - (a.claims ?? -1));
}

// ── place among creators, recap, polls, automated messages ───────────────────

export interface PagePromoMonth {
  year: number;
  month: number;
  grossMills: number | null;
  netMills: number | null;
  /** Fansly's «Top X%» of the month among creators (smaller is better). */
  topPercent: number | null;
  maxTopPercent: number | null;
}

export interface PagePromoRecapStat {
  year: number;
  statRef: string;
  statName: string;
  /** As Fansly serves it (JSON text). */
  value: string | null;
}

export interface PagePromoPoll {
  pollRef: string;
  title: string | null;
  description: string | null;
  status: number | null;
  createdAt: string | null;
  options: { title: string | null; votes: number | null }[];
}

export interface PagePromoAutomation {
  automationRef: string;
  triggerType: number | null;
  /** The tier a per-tier trigger names (`triggerMetadata.subscriptionTierName`). */
  tierName: string | null;
  delaySeconds: number | null;
  cooldownSeconds: number | null;
  messageText: string | null;
  attachmentCount: number;
  missingSince: string | null;
}

/** Fansly's rolling window (the last 30 days, served as year 0 month 0). */
export interface PagePromoCurrentRank {
  topPercent: number | null;
  maxTopPercent: number | null;
  grossMills: number | null;
  netMills: number | null;
  windowStart: string | null;
  windowEnd: string | null;
}

/** One tracking link's day (0339). */
export interface PagePromoTrackingDay {
  day: string;
  linkRef: string;
  follows: number | null;
  subscriptions: number | null;
  grossMills: number | null;
}

export interface FanslyPagePromoRead {
  /** The place among creators over the last 30 days; null when not read. */
  currentRank: PagePromoCurrentRank | null;
  tiers: PagePromoTier[];
  giftLinks: PagePromoGiftLink[];
  trackingLinks: PagePromoTrackingLink[];
  months: PagePromoMonth[];
  recap: PagePromoRecapStat[];
  polls: PagePromoPoll[];
  automations: PagePromoAutomation[];
  /** The tracking links' days of the last 90 UTC days (only days with activity). */
  trackingDays: PagePromoTrackingDay[];
}

export async function readFanslyPagePromo(db: Database, pageId: number): Promise<FanslyPagePromoRead> {
  const months = await db.execute<Record<string, unknown>>(sql`
    select year, month, total_gross_mills, total_net_mills, top_percent, max_top_percent, window_start, window_end
      from revenue_month_totals
     where page_id = ${pageId}
     order by year desc, month desc
  `);
  const rolling = months.rows.find((row) => Number(row.year) === 0) ?? null;
  const recap = await db.execute<Record<string, unknown>>(sql`
    select recap_year, stat_ref, stat_name, stat_value
      from page_recap_stats
     where page_id = ${pageId}
     order by recap_year desc, stat_ref asc
  `);
  const polls = await db.execute<Record<string, unknown>>(sql`
    select p.poll_ref, p.title, p.description, p.status, p.created_at_platform,
           coalesce((
             select jsonb_agg(jsonb_build_object('title', o.title, 'votes', o.vote_count) order by o.option_ordinal, o.option_ref)
               from page_poll_options o
              where o.page_id = p.page_id and o.poll_ref = p.poll_ref
           ), '[]'::jsonb) as options
      from page_polls p
     where p.page_id = ${pageId}
     order by p.created_at_platform desc nulls last, p.poll_ref desc
  `);
  const automations = await db.execute<Record<string, unknown>>(sql`
    select automation_ref, trigger_type, trigger_metadata, delay_seconds, cooldown_seconds, message_text,
           jsonb_array_length(coalesce(attachment_refs, '[]'::jsonb))::int as attachment_count, missing_since
      from page_automated_messages
     where page_id = ${pageId}
     order by missing_since is not null, trigger_type asc nulls last, automation_ref asc
  `);
  const trackingDays = await db.execute<Record<string, unknown>>(sql`
    with days as (
      select link_ref, day from fansly_tracking_link_days where page_id = ${pageId} and day > (now() at time zone 'utc')::date - 90
      union
      select link_ref, day from fansly_tracking_link_revenue_days where page_id = ${pageId} and day > (now() at time zone 'utc')::date - 90
    )
    select d.day::text as day, d.link_ref, s.follows, s.subscriptions,
           (select sum(r.gross_mills) from fansly_tracking_link_revenue_days r
             where r.page_id = ${pageId} and r.link_ref = d.link_ref and r.day = d.day) as gross_mills
      from days d
      left join fansly_tracking_link_days s on s.page_id = ${pageId} and s.link_ref = d.link_ref and s.day = d.day
     order by d.day asc, d.link_ref asc
  `);
  return {
    trackingDays: trackingDays.rows.map((row) => ({
      day: String(row.day),
      linkRef: String(row.link_ref),
      follows: num(row.follows),
      subscriptions: num(row.subscriptions),
      grossMills: num(row.gross_mills),
    })),
    currentRank: rolling === null ? null : {
      topPercent: num(rolling.top_percent),
      maxTopPercent: num(rolling.max_top_percent),
      grossMills: num(rolling.total_gross_mills),
      netMills: num(rolling.total_net_mills),
      windowStart: iso(rolling.window_start),
      windowEnd: iso(rolling.window_end),
    },
    tiers: await readTiers(db, pageId),
    giftLinks: await readGiftLinks(db, pageId),
    trackingLinks: await readTrackingLinks(db, pageId),
    months: months.rows.filter((row) => Number(row.year) > 0).map((row) => ({
      year: Number(row.year),
      month: Number(row.month),
      grossMills: num(row.total_gross_mills),
      netMills: num(row.total_net_mills),
      topPercent: num(row.top_percent),
      maxTopPercent: num(row.max_top_percent),
    })),
    recap: recap.rows.map((row) => ({
      year: Number(row.recap_year),
      statRef: String(row.stat_ref),
      statName: String(row.stat_name),
      value: text(row.stat_value),
    })),
    polls: polls.rows.map((row) => ({
      pollRef: String(row.poll_ref),
      title: text(row.title),
      description: text(row.description),
      status: num(row.status),
      createdAt: iso(row.created_at_platform),
      options: list(row.options).map((option) => {
        const o = record(option);
        return { title: text(o.title), votes: num(o.votes) };
      }),
    })),
    automations: automations.rows.map((row) => ({
      automationRef: String(row.automation_ref),
      triggerType: num(row.trigger_type),
      tierName: text(record(row.trigger_metadata).subscriptionTierName),
      delaySeconds: num(row.delay_seconds),
      cooldownSeconds: num(row.cooldown_seconds),
      messageText: text(row.message_text),
      attachmentCount: Number(row.attachment_count ?? 0),
      missingSince: iso(row.missing_since),
    })),
  };
}

// ── mass messages ────────────────────────────────────────────────────────────

/** `page_broadcasts.source_list`: the stats list a mass message was read from. */
export type FanslyMassMessageList = "live" | "scheduled" | "deleted";

export interface FanslyMassMessage {
  broadcastRef: string;
  list: string;
  createdAt: string | null;
  scheduledFor: string | null;
  deletedAt: string | null;
  text: string | null;
  sent: number | null;
  delivered: number | null;
  read: number | null;
  tipsMills: number | null;
  offeredMedia: number;
  offeredBundles: number;
  /** The lowest and highest price among the offers (mills); null without a priced offer. */
  minPriceMills: number | null;
  maxPriceMills: number | null;
  salesCount: number | null;
  salesNetMills: number | null;
  salesPendingMills: number | null;
}

export interface FanslyMassMessagesRead {
  total: number;
  /** Over every mass message of the asked lists, not only this page of rows. */
  totals: { sent: number; read: number; salesCount: number; salesNetMills: number; tipsMills: number };
  rows: FanslyMassMessage[];
}

export async function readFanslyMassMessages(
  db: Database,
  input: { pageId: number; lists: readonly FanslyMassMessageList[]; limit: number; offset: number },
): Promise<FanslyMassMessagesRead> {
  if (input.lists.length === 0) return { total: 0, totals: { sent: 0, read: 0, salesCount: 0, salesNetMills: 0, tipsMills: 0 }, rows: [] };
  const lists = sql.join(input.lists.map((list) => sql`${list}`), sql`, `);
  const totals = await db.execute<Record<string, unknown>>(sql`
    select count(*)::int as total,
           coalesce(sum(stats_total), 0) as sent, coalesce(sum(stats_read), 0) as read,
           coalesce(sum(sales_count), 0) as sales_count, coalesce(sum(sales_net_mills), 0) as sales_net_mills,
           coalesce(sum(total_tip_amount_mills), 0) as tips_mills
      from page_broadcasts
     where page_id = ${input.pageId} and source_list in (${lists})
  `);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select broadcast_ref, source_list, created_at_platform, scheduled_for, deleted_at_platform, content,
           stats_total, stats_delivered, stats_read, total_tip_amount_mills,
           coalesce(array_length(offered_media_refs, 1), 0) as offered_media,
           coalesce(array_length(offered_bundle_refs, 1), 0) as offered_bundles,
           (select min((p->>'priceMills')::bigint) from jsonb_array_elements(coalesce(offer_prices, '[]'::jsonb)) p
             where (p->>'priceMills') ~ '^[0-9]+$' and (p->>'priceMills')::bigint > 0) as min_price,
           (select max((p->>'priceMills')::bigint) from jsonb_array_elements(coalesce(offer_prices, '[]'::jsonb)) p
             where (p->>'priceMills') ~ '^[0-9]+$' and (p->>'priceMills')::bigint > 0) as max_price,
           sales_count, sales_net_mills, sales_pending_mills
      from page_broadcasts
     where page_id = ${input.pageId} and source_list in (${lists})
     order by coalesce(scheduled_for, created_at_platform) desc nulls last, broadcast_ref desc
     limit ${input.limit} offset ${input.offset}
  `);
  const head = totals.rows[0] ?? {};
  return {
    total: Number(head.total ?? 0),
    totals: {
      sent: Number(head.sent ?? 0),
      read: Number(head.read ?? 0),
      salesCount: Number(head.sales_count ?? 0),
      salesNetMills: Number(head.sales_net_mills ?? 0),
      tipsMills: Number(head.tips_mills ?? 0),
    },
    rows: rows.rows.map((row) => ({
      broadcastRef: String(row.broadcast_ref),
      list: String(row.source_list),
      createdAt: iso(row.created_at_platform),
      scheduledFor: iso(row.scheduled_for),
      deletedAt: iso(row.deleted_at_platform),
      text: text(row.content),
      sent: num(row.stats_total),
      delivered: num(row.stats_delivered),
      read: num(row.stats_read),
      tipsMills: num(row.total_tip_amount_mills),
      offeredMedia: Number(row.offered_media ?? 0),
      offeredBundles: Number(row.offered_bundles ?? 0),
      minPriceMills: num(row.min_price),
      maxPriceMills: num(row.max_price),
      salesCount: num(row.sales_count),
      salesNetMills: num(row.sales_net_mills),
      salesPendingMills: num(row.sales_pending_mills),
    })),
  };
}
