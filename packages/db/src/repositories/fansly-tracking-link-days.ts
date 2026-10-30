// Fansly tracking links' days (0339): the writers of `tracking-links.daily`'s
// typed rows and the reader of the links the sweep walks. A row is replaced
// only by an answer received at the same instant or later.

import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { upsertRows, type CreatorStatsLineage } from "./fansly-creator-stats.ts";

export interface TrackingLinkDayRow {
  day: string;
  clicks: number | null;
  claims: number | null;
  follows: number | null;
  subscriptions: number | null;
}

export interface TrackingLinkRevenueDayRow {
  day: string;
  revenueType: number;
  grossMills: bigint | null;
  netMills: bigint | null;
}

export async function upsertTrackingLinkDays(
  db: Database,
  lineage: CreatorStatsLineage,
  linkRef: string,
  rows: readonly TrackingLinkDayRow[],
): Promise<number> {
  return upsertRows(db, "fansly_tracking_link_days", ["link_ref", "day"], ["link_ref", "day", "clicks", "claims", "follows", "subscriptions"], lineage,
    rows.map((row) => [linkRef, row.day, row.clicks, row.claims, row.follows, row.subscriptions]));
}

export async function upsertTrackingLinkRevenueDays(
  db: Database,
  lineage: CreatorStatsLineage,
  linkRef: string,
  rows: readonly TrackingLinkRevenueDayRow[],
): Promise<number> {
  return upsertRows(db, "fansly_tracking_link_revenue_days", ["link_ref", "day", "revenue_type"], ["link_ref", "day", "revenue_type", "gross_mills", "net_mills"], lineage,
    rows.map((row) => [linkRef, row.day, row.revenueType, row.grossMills, row.netMills]));
}

export interface PageTrackingLinkRef {
  linkRef: string;
  createdAt: Date | null;
}

/** The page's live tracking links (the latest daily snapshot of `/trackinglinks`). */
export async function listPageTrackingLinkRefs(db: Database, pageId: number): Promise<PageTrackingLinkRef[]> {
  const result = await db.execute<{ link_ref: string; created_at_platform: Date | string | null; missing_since: Date | string | null }>(sql`
    select distinct on (link_ref) link_ref, created_at_platform, missing_since
      from page_promo_links
     where page_id = ${pageId} and link_kind = 'tracking'
     order by link_ref, business_date desc
  `);
  return result.rows
    .filter((row) => row.missing_since === null)
    .map((row) => ({
      linkRef: String(row.link_ref),
      createdAt: row.created_at_platform === null ? null : new Date(String(row.created_at_platform instanceof Date ? row.created_at_platform.toISOString() : row.created_at_platform)),
    }));
}
