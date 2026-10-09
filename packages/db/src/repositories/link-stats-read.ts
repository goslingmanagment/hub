// Reads of the OnlyFans link series for the owner's «Ссылки OnlyFans» API
// (traffic sources plan §2.6, PR 12): the latest snapshot of every link, the
// collection state of every (page, kind), a link's history, and the series
// with the "link → channel → contractor" bindings for channel totals.
// Read-only. The arithmetic over what is read here is link-stats-deltas.ts.
//
// Money is read as coalesce(revenue_net_mills, revenue_gross_mills): rows
// written before migration 0256, or by the previous image after a rollback,
// carry the value only in the deprecated column (same value, same meaning).

import { sql } from "drizzle-orm";

import type { TrafficLinkKind, TrafficValidFromBasis } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import type { LinkSeries, LinkSeriesPoint } from "./link-stats-deltas.ts";
import { linkStatRunUsableResultSql, type LinkStatKind, type LinkStatRunStatus } from "./ofapi.ts";

const NET_MILLS = sql.raw("coalesce(s.revenue_net_mills, s.revenue_gross_mills)");

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toDateOrNull(value: Date | string | null | undefined): Date | null {
  return value === null || value === undefined ? null : toDate(value);
}

function toBigIntOrNull(value: bigint | number | string | null | undefined): bigint | null {
  return value === null || value === undefined ? null : BigInt(value);
}

function pageFilter(column: string, pageIds: readonly number[] | null) {
  return pageIds === null
    ? sql`true`
    : sql`${sql.raw(column)} = any(${`{${pageIds.map((id) => Math.trunc(id)).join(",")}}`}::bigint[])`;
}

export interface OfLinkPageRow {
  pageId: number;
  pageLabel: string;
  pageCreatedAt: Date;
  ofapiAccountId: string | null;
  ofapiAuthStatus: string | null;
}

/** Every active OnlyFans page (the series' population, whose collection
 * state is current), or the one asked for (whatever its state). With
 * `withStoredSeries`, also every deleted page the series holds snapshots of:
 * history does not shrink when a page is deleted. */
export async function listOfLinkPages(
  db: Database,
  input: { pageId?: number; withStoredSeries?: boolean } = {},
): Promise<OfLinkPageRow[]> {
  const result = await db.execute<{
    pageId: number | string;
    pageLabel: string;
    pageCreatedAt: Date | string;
    ofapiAccountId: string | null;
    ofapiAuthStatus: string | null;
  }>(sql`
    select p.id as "pageId", p.label as "pageLabel", p.created_at as "pageCreatedAt",
           p.ofapi_account_id as "ofapiAccountId", p.ofapi_auth_status as "ofapiAuthStatus"
    from pages p
    where p.platform = 'onlyfans'
      and ${input.pageId !== undefined
        ? sql`p.id = ${input.pageId}`
        : input.withStoredSeries === true
          ? sql`(p.status = 'active'
                 or exists (select 1 from page_link_stat_snapshots s where s.platform_account_id = p.id))`
          : sql`p.status = 'active'`}
    order by p.id
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.pageId),
    pageLabel: row.pageLabel,
    pageCreatedAt: toDate(row.pageCreatedAt),
    ofapiAccountId: row.ofapiAccountId,
    ofapiAuthStatus: row.ofapiAuthStatus,
  }));
}

/** The series' first read: the floor of every vendor figure it holds. */
export async function readLinkSeriesFloor(db: Database): Promise<Date | null> {
  const result = await db.execute<{ floor: Date | string | null }>(sql`
    select min(r.pulled_at) as floor
    from page_link_stat_runs r
    where r.status in ('complete', 'partial')
  `);
  return toDateOrNull(result.rows[0]?.floor);
}

export interface LinkSeriesAttemptRow {
  runId: number;
  platformAccountId: number;
  linkKind: LinkStatKind;
  pulledAt: Date;
  windowAt: Date | null;
  attempt: number;
  status: LinkStatRunStatus;
  reason: string | null;
  apiPages: number;
  rawItems: number;
  writtenRows: number;
  /** The series' one definition of a usable result (linkStatRunUsableResultSql). */
  usable: boolean;
}

/** One (page, kind) of the series: its latest usable result, its first and
 * latest attempts. The shape of the series monitor's health row, so the same
 * stale rule judges both. */
export interface LinkSeriesPairState {
  platformAccountId: number;
  pageLabel: string;
  pageCreatedAt: Date;
  ofapiAccountId: string | null;
  ofapiAuthStatus: string | null;
  linkKind: LinkStatKind;
  lastUsableAt: Date | null;
  lastUsableRunId: number | null;
  /** Links in the latest usable result. */
  lastUsableLinkCount: number;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  lastAttemptStatus: LinkStatRunStatus | null;
  lastAttemptReason: string | null;
  lastAttempt: LinkSeriesAttemptRow | null;
}

/** Both kinds of every page given, by index-order lookups on (page, kind,
 * pulled_at) — the same plan as the series monitor's health read. */
export async function listLinkSeriesPairStates(
  db: Database,
  input: { pageIds: readonly number[] },
): Promise<LinkSeriesPairState[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const run = sql.raw("r");
  const result = await db.execute<{
    platformAccountId: number | string;
    pageLabel: string;
    pageCreatedAt: Date | string;
    ofapiAccountId: string | null;
    ofapiAuthStatus: string | null;
    linkKind: LinkStatKind;
    usableId: number | string | null;
    usableAt: Date | string | null;
    usableRows: number | null;
    firstAttemptAt: Date | string | null;
    lastId: number | string | null;
    lastAt: Date | string | null;
    lastWindowAt: Date | string | null;
    lastAttemptNo: number | null;
    lastStatus: LinkStatRunStatus | null;
    lastReason: string | null;
    lastApiPages: number | null;
    lastRawItems: number | null;
    lastWrittenRows: number | null;
    lastUsable: boolean | null;
  }>(sql`
    select p.id as "platformAccountId",
           p.label as "pageLabel",
           p.created_at as "pageCreatedAt",
           p.ofapi_account_id as "ofapiAccountId",
           p.ofapi_auth_status as "ofapiAuthStatus",
           kind.link_kind as "linkKind",
           usable.id as "usableId",
           usable.pulled_at as "usableAt",
           usable.written_rows as "usableRows",
           first_attempt.pulled_at as "firstAttemptAt",
           last_attempt.id as "lastId",
           last_attempt.pulled_at as "lastAt",
           last_attempt.window_at as "lastWindowAt",
           last_attempt.attempt as "lastAttemptNo",
           last_attempt.status as "lastStatus",
           last_attempt.reason as "lastReason",
           last_attempt.api_pages as "lastApiPages",
           last_attempt.raw_items as "lastRawItems",
           last_attempt.written_rows as "lastWrittenRows",
           last_attempt.usable as "lastUsable"
    from pages p
    cross join (values ('tracking'), ('trial')) as kind(link_kind)
    left join lateral (
      select r.id, r.pulled_at, r.written_rows
      from page_link_stat_runs r
      where r.platform_account_id = p.id
        and r.link_kind = kind.link_kind
        and ${linkStatRunUsableResultSql(run)}
      order by r.pulled_at desc, r.id desc
      limit 1
    ) usable on true
    left join lateral (
      select r.pulled_at
      from page_link_stat_runs r
      where r.platform_account_id = p.id and r.link_kind = kind.link_kind
      order by r.pulled_at asc, r.id asc
      limit 1
    ) first_attempt on true
    left join lateral (
      select r.id, r.pulled_at, r.window_at, r.attempt, r.status, r.reason,
             r.api_pages, r.raw_items, r.written_rows,
             ${linkStatRunUsableResultSql(run)} as usable
      from page_link_stat_runs r
      where r.platform_account_id = p.id and r.link_kind = kind.link_kind
      order by r.pulled_at desc, r.id desc
      limit 1
    ) last_attempt on true
    where ${pageFilter("p.id", input.pageIds)}
    order by p.id, kind.link_kind
  `);
  return result.rows.map((row) => {
    const platformAccountId = Number(row.platformAccountId);
    const lastAttempt: LinkSeriesAttemptRow | null = row.lastId === null || row.lastAt === null
      ? null
      : {
        runId: Number(row.lastId),
        platformAccountId,
        linkKind: row.linkKind,
        pulledAt: toDate(row.lastAt),
        windowAt: toDateOrNull(row.lastWindowAt),
        attempt: Number(row.lastAttemptNo ?? 1),
        status: row.lastStatus!,
        reason: row.lastReason,
        apiPages: Number(row.lastApiPages ?? 0),
        rawItems: Number(row.lastRawItems ?? 0),
        writtenRows: Number(row.lastWrittenRows ?? 0),
        usable: row.lastUsable === true,
      };
    return {
      platformAccountId,
      pageLabel: row.pageLabel,
      pageCreatedAt: toDate(row.pageCreatedAt),
      ofapiAccountId: row.ofapiAccountId,
      ofapiAuthStatus: row.ofapiAuthStatus,
      linkKind: row.linkKind,
      lastUsableAt: toDateOrNull(row.usableAt),
      lastUsableRunId: row.usableId === null ? null : Number(row.usableId),
      lastUsableLinkCount: Number(row.usableRows ?? 0),
      firstAttemptAt: toDateOrNull(row.firstAttemptAt),
      lastAttemptAt: lastAttempt?.pulledAt ?? null,
      lastAttemptStatus: lastAttempt?.status ?? null,
      lastAttemptReason: lastAttempt?.reason ?? null,
      lastAttempt,
    };
  });
}

/** Every attempt of one (page, kind) read in [from, to), oldest first. */
export async function listLinkSeriesAttempts(
  db: Database,
  input: { pageId: number; linkKind: LinkStatKind; from: Date; to: Date },
): Promise<LinkSeriesAttemptRow[]> {
  const run = sql.raw("r");
  const result = await db.execute<{
    runId: number | string;
    pulledAt: Date | string;
    windowAt: Date | string | null;
    attempt: number;
    status: LinkStatRunStatus;
    reason: string | null;
    apiPages: number;
    rawItems: number;
    writtenRows: number;
    usable: boolean;
  }>(sql`
    select r.id as "runId", r.pulled_at as "pulledAt", r.window_at as "windowAt", r.attempt,
           r.status, r.reason, r.api_pages as "apiPages", r.raw_items as "rawItems",
           r.written_rows as "writtenRows", ${linkStatRunUsableResultSql(run)} as usable
    from page_link_stat_runs r
    where r.platform_account_id = ${input.pageId}
      and r.link_kind = ${input.linkKind}
      and r.pulled_at >= ${input.from.toISOString()}::timestamptz
      and r.pulled_at < ${input.to.toISOString()}::timestamptz
    order by r.pulled_at asc, r.id asc
  `);
  return result.rows.map((row) => ({
    runId: Number(row.runId),
    platformAccountId: input.pageId,
    linkKind: input.linkKind,
    pulledAt: toDate(row.pulledAt),
    windowAt: toDateOrNull(row.windowAt),
    attempt: Number(row.attempt),
    status: row.status,
    reason: row.reason,
    apiPages: Number(row.apiPages),
    rawItems: Number(row.rawItems),
    writtenRows: Number(row.writtenRows),
    usable: row.usable === true,
  }));
}

/** The windows one (page, kind) stamped in [from, to), with whether any row
 * of the window is a usable result; and the pair's first stamp ever (null:
 * the pair never stamped a window). */
export async function listLinkSeriesWindowResults(
  db: Database,
  input: { pageId: number; linkKind: LinkStatKind; from: Date; to: Date },
): Promise<{ firstWindowAt: Date | null; windows: Array<{ windowAt: Date; usable: boolean }> }> {
  const run = sql.raw("r");
  const first = await db.execute<{ first: Date | string | null }>(sql`
    select min(r.window_at) as first
    from page_link_stat_runs r
    where r.platform_account_id = ${input.pageId} and r.link_kind = ${input.linkKind}
  `);
  const windows = await db.execute<{ windowAt: Date | string; usable: boolean }>(sql`
    select r.window_at as "windowAt", bool_or(${linkStatRunUsableResultSql(run)}) as usable
    from page_link_stat_runs r
    where r.platform_account_id = ${input.pageId}
      and r.link_kind = ${input.linkKind}
      and r.window_at >= ${input.from.toISOString()}::timestamptz
      and r.window_at < ${input.to.toISOString()}::timestamptz
    group by r.window_at
    order by r.window_at
  `);
  return {
    firstWindowAt: toDateOrNull(first.rows[0]?.first),
    windows: windows.rows.map((row) => ({ windowAt: toDate(row.windowAt), usable: row.usable === true })),
  };
}

export interface LatestLinkSnapshotRow {
  platformAccountId: number;
  linkKind: LinkStatKind;
  platformLinkId: string;
  runId: number;
  observedAt: Date;
  name: string | null;
  url: string | null;
  linkCreatedAt: Date | null;
  linkEndsAt: Date | null;
  isFinished: boolean | null;
  clicks: number;
  claims: number | null;
  subscribers: number;
  spenders: number | null;
  netMills: bigint | null;
  chargebacksMills: bigint | null;
  revenueIsLoading: boolean | null;
  revenueCalculatedAt: Date | null;
  trialDays: number | null;
  tags: string[] | null;
}

/** The latest snapshot of every link the series has seen on the given pages. */
export async function listLatestLinkSnapshots(
  db: Database,
  input: { pageIds: readonly number[] },
): Promise<LatestLinkSnapshotRow[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const result = await db.execute<{
    platformAccountId: number | string;
    linkKind: LinkStatKind;
    platformLinkId: string;
    runId: number | string;
    observedAt: Date | string;
    name: string | null;
    url: string | null;
    linkCreatedAt: Date | string | null;
    linkEndsAt: Date | string | null;
    isFinished: boolean | null;
    clicks: number;
    claims: number | null;
    subscribers: number;
    spenders: number | null;
    netMills: bigint | string | null;
    chargebacksMills: bigint | string | null;
    revenueIsLoading: boolean | null;
    revenueCalculatedAt: Date | string | null;
    trialDays: number | null;
    tags: string[] | null;
  }>(sql`
    select distinct on (s.platform_account_id, s.link_kind, s.platform_link_id)
           s.platform_account_id as "platformAccountId",
           s.link_kind as "linkKind",
           s.platform_link_id as "platformLinkId",
           r.id as "runId",
           r.pulled_at as "observedAt",
           s.name, s.url,
           s.link_created_at as "linkCreatedAt",
           s.link_ends_at as "linkEndsAt",
           s.is_finished as "isFinished",
           s.clicks_count as clicks,
           s.claims_count as claims,
           s.subscribers_count as subscribers,
           s.spenders_count as spenders,
           ${NET_MILLS} as "netMills",
           s.revenue_chargebacks_mills as "chargebacksMills",
           s.revenue_is_loading as "revenueIsLoading",
           s.revenue_calculated_at as "revenueCalculatedAt",
           s.trial_days as "trialDays",
           s.tags
    from page_link_stat_snapshots s
    join page_link_stat_runs r on r.id = s.run_id
    where ${pageFilter("s.platform_account_id", input.pageIds)}
    order by s.platform_account_id, s.link_kind, s.platform_link_id, r.pulled_at desc, s.id desc
  `);
  return result.rows.map((row) => ({
    platformAccountId: Number(row.platformAccountId),
    linkKind: row.linkKind,
    platformLinkId: row.platformLinkId,
    runId: Number(row.runId),
    observedAt: toDate(row.observedAt),
    name: row.name,
    url: row.url,
    linkCreatedAt: toDateOrNull(row.linkCreatedAt),
    linkEndsAt: toDateOrNull(row.linkEndsAt),
    isFinished: row.isFinished,
    clicks: Number(row.clicks),
    claims: row.claims === null ? null : Number(row.claims),
    subscribers: Number(row.subscribers),
    spenders: row.spenders === null ? null : Number(row.spenders),
    netMills: toBigIntOrNull(row.netMills),
    chargebacksMills: toBigIntOrNull(row.chargebacksMills),
    revenueIsLoading: row.revenueIsLoading,
    revenueCalculatedAt: toDateOrNull(row.revenueCalculatedAt),
    trialDays: row.trialDays === null ? null : Number(row.trialDays),
    tags: row.tags,
  }));
}

export interface LinkRecalculationRow {
  platformAccountId: number;
  linkKind: LinkStatKind;
  platformLinkId: string;
  observedAt: Date;
  previousObservedAt: Date;
  fromMills: bigint;
  toMills: bigint;
  bindingChanged: boolean;
}

/** Each link's latest recalculation: the last snapshot whose known net money
 * is below the previous known value. */
export async function listLastLinkRecalculations(
  db: Database,
  input: { pageIds: readonly number[] },
): Promise<LinkRecalculationRow[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const result = await db.execute<{
    platformAccountId: number | string;
    linkKind: LinkStatKind;
    platformLinkId: string;
    observedAt: Date | string;
    previousObservedAt: Date | string;
    fromMills: bigint | string;
    toMills: bigint | string;
    bindingChanged: boolean;
  }>(sql`
    with known as (
      select s.platform_account_id, s.link_kind, s.platform_link_id, s.id as snapshot_id,
             r.pulled_at, r.ofapi_account_id, r.reason, ${NET_MILLS} as net
      from page_link_stat_snapshots s
      join page_link_stat_runs r on r.id = s.run_id
      where ${pageFilter("s.platform_account_id", input.pageIds)}
        and ${NET_MILLS} is not null
    ), paired as (
      select known.*,
             lag(net) over w as previous_net,
             lag(pulled_at) over w as previous_at,
             lag(ofapi_account_id) over w as previous_account
      from known
      window w as (partition by platform_account_id, link_kind, platform_link_id order by pulled_at, snapshot_id)
    )
    select distinct on (platform_account_id, link_kind, platform_link_id)
           platform_account_id as "platformAccountId",
           link_kind as "linkKind",
           platform_link_id as "platformLinkId",
           pulled_at as "observedAt",
           previous_at as "previousObservedAt",
           previous_net as "fromMills",
           net as "toMills",
           (coalesce(reason, '') ~ '(^|,)binding_changed(,|$)'
             or (ofapi_account_id is not null and previous_account is not null
                 and ofapi_account_id <> previous_account)) as "bindingChanged"
    from paired
    where previous_net is not null and net < previous_net
    order by platform_account_id, link_kind, platform_link_id, pulled_at desc, snapshot_id desc
  `);
  return result.rows.map((row) => ({
    platformAccountId: Number(row.platformAccountId),
    linkKind: row.linkKind,
    platformLinkId: row.platformLinkId,
    observedAt: toDate(row.observedAt),
    previousObservedAt: toDate(row.previousObservedAt),
    fromMills: BigInt(row.fromMills),
    toMills: BigInt(row.toMills),
    bindingChanged: row.bindingChanged === true,
  }));
}

/** The moments each (page, kind) was first read under another OFAPI account
 * than the read before it (reads that finished; accounts known), oldest first. */
export async function listLinkSeriesAccountChanges(
  db: Database,
  input: { pageIds: readonly number[] },
): Promise<Array<{ platformAccountId: number; linkKind: LinkStatKind; at: Date }>> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const result = await db.execute<{ platformAccountId: number | string; linkKind: LinkStatKind; at: Date | string }>(sql`
    select platform_account_id as "platformAccountId", link_kind as "linkKind", pulled_at as at
    from (
      select r.platform_account_id, r.link_kind, r.pulled_at, r.ofapi_account_id,
             lag(r.ofapi_account_id) over (
               partition by r.platform_account_id, r.link_kind order by r.pulled_at, r.id
             ) as previous_account
      from page_link_stat_runs r
      where ${pageFilter("r.platform_account_id", input.pageIds)}
        and r.status in ('complete', 'partial')
        and r.ofapi_account_id is not null
    ) runs
    where previous_account is not null and ofapi_account_id <> previous_account
    order by pulled_at
  `);
  return result.rows.map((row) => ({
    platformAccountId: Number(row.platformAccountId),
    linkKind: row.linkKind,
    at: toDate(row.at),
  }));
}

export interface LinkSeriesWithMeta extends LinkSeries {
  name: string | null;
}

/** Every snapshot read before `before` of the given pages' links — or of one
 * link — grouped per link, oldest first. A link's name and creation are its
 * latest snapshot's. */
export async function listLinkSeries(
  db: Database,
  input: {
    pageIds: readonly number[];
    before: Date;
    link?: { pageId: number; linkKind: LinkStatKind; linkRef: string };
  },
): Promise<LinkSeriesWithMeta[]> {
  if (input.pageIds.length === 0) {
    return [];
  }
  const result = await db.execute<{
    platformAccountId: number | string;
    linkKind: LinkStatKind;
    platformLinkId: string;
    name: string | null;
    linkCreatedAt: Date | string | null;
    runId: number | string;
    observedAt: Date | string;
    ofapiAccountId: string | null;
    runReason: string | null;
    clicks: number;
    claims: number | null;
    subscribers: number;
    netMills: bigint | string | null;
  }>(sql`
    select s.platform_account_id as "platformAccountId",
           s.link_kind as "linkKind",
           s.platform_link_id as "platformLinkId",
           s.name,
           s.link_created_at as "linkCreatedAt",
           r.id as "runId",
           r.pulled_at as "observedAt",
           r.ofapi_account_id as "ofapiAccountId",
           r.reason as "runReason",
           s.clicks_count as clicks,
           s.claims_count as claims,
           s.subscribers_count as subscribers,
           ${NET_MILLS} as "netMills"
    from page_link_stat_snapshots s
    join page_link_stat_runs r on r.id = s.run_id
    where ${pageFilter("s.platform_account_id", input.pageIds)}
      and r.pulled_at < ${input.before.toISOString()}::timestamptz
      and ${input.link === undefined
        ? sql`true`
        : sql`s.platform_account_id = ${input.link.pageId}
              and s.link_kind = ${input.link.linkKind}
              and s.platform_link_id = ${input.link.linkRef}`}
    order by s.platform_account_id, s.link_kind, s.platform_link_id, r.pulled_at, s.id
  `);
  const series = new Map<string, LinkSeriesWithMeta & { points: LinkSeriesPoint[] }>();
  for (const row of result.rows) {
    const pageId = Number(row.platformAccountId);
    const key = `${pageId}:${row.linkKind}:${row.platformLinkId}`;
    let entry = series.get(key);
    if (entry === undefined) {
      entry = {
        pageId,
        linkKind: row.linkKind,
        linkRef: row.platformLinkId,
        name: row.name,
        linkCreatedAt: toDateOrNull(row.linkCreatedAt),
        points: [],
      };
      series.set(key, entry);
    }
    // Descriptive fields follow the latest snapshot.
    entry.name = row.name ?? entry.name;
    entry.linkCreatedAt = toDateOrNull(row.linkCreatedAt) ?? entry.linkCreatedAt;
    entry.points.push({
      observedAt: toDate(row.observedAt),
      runId: Number(row.runId),
      ofapiAccountId: row.ofapiAccountId,
      runReason: row.runReason,
      clicks: Number(row.clicks),
      claims: row.claims === null ? null : Number(row.claims),
      subscribers: Number(row.subscribers),
      netMills: toBigIntOrNull(row.netMills),
    });
  }
  return [...series.values()];
}

export interface LinkSnapshotHistoryRow {
  runId: number;
  observedAt: Date;
  windowAt: Date | null;
  runStatus: LinkStatRunStatus;
  runReason: string | null;
  ofapiAccountId: string | null;
  clicks: number;
  claims: number | null;
  subscribers: number;
  spenders: number | null;
  netMills: bigint | null;
  chargebacksMills: bigint | null;
  revenueCalculatedAt: Date | null;
  revenueIsLoading: boolean | null;
  isFinished: boolean | null;
  linkEndsAt: Date | null;
}

/** Every snapshot of one link read before `before`, oldest first, with its run. */
export async function listLinkSnapshotHistory(
  db: Database,
  input: { pageId: number; linkKind: LinkStatKind; linkRef: string; before: Date },
): Promise<LinkSnapshotHistoryRow[]> {
  const result = await db.execute<{
    runId: number | string;
    observedAt: Date | string;
    windowAt: Date | string | null;
    runStatus: LinkStatRunStatus;
    runReason: string | null;
    ofapiAccountId: string | null;
    clicks: number;
    claims: number | null;
    subscribers: number;
    spenders: number | null;
    netMills: bigint | string | null;
    chargebacksMills: bigint | string | null;
    revenueCalculatedAt: Date | string | null;
    revenueIsLoading: boolean | null;
    isFinished: boolean | null;
    linkEndsAt: Date | string | null;
  }>(sql`
    select r.id as "runId", r.pulled_at as "observedAt", r.window_at as "windowAt",
           r.status as "runStatus", r.reason as "runReason", r.ofapi_account_id as "ofapiAccountId",
           s.clicks_count as clicks, s.claims_count as claims, s.subscribers_count as subscribers,
           s.spenders_count as spenders, ${NET_MILLS} as "netMills",
           s.revenue_chargebacks_mills as "chargebacksMills",
           s.revenue_calculated_at as "revenueCalculatedAt",
           s.revenue_is_loading as "revenueIsLoading",
           s.is_finished as "isFinished", s.link_ends_at as "linkEndsAt"
    from page_link_stat_snapshots s
    join page_link_stat_runs r on r.id = s.run_id
    where s.platform_account_id = ${input.pageId}
      and s.link_kind = ${input.linkKind}
      and s.platform_link_id = ${input.linkRef}
      and r.pulled_at < ${input.before.toISOString()}::timestamptz
    order by r.pulled_at, s.id
  `);
  return result.rows.map((row) => ({
    runId: Number(row.runId),
    observedAt: toDate(row.observedAt),
    windowAt: toDateOrNull(row.windowAt),
    runStatus: row.runStatus,
    runReason: row.runReason,
    ofapiAccountId: row.ofapiAccountId,
    clicks: Number(row.clicks),
    claims: row.claims === null ? null : Number(row.claims),
    subscribers: Number(row.subscribers),
    spenders: row.spenders === null ? null : Number(row.spenders),
    netMills: toBigIntOrNull(row.netMills),
    chargebacksMills: toBigIntOrNull(row.chargebacksMills),
    revenueCalculatedAt: toDateOrNull(row.revenueCalculatedAt),
    revenueIsLoading: row.revenueIsLoading,
    isFinished: row.isFinished,
    linkEndsAt: toDateOrNull(row.linkEndsAt),
  }));
}

export interface TrafficBindingIntervalRow {
  platformAccountId: number;
  linkKind: TrafficLinkKind;
  platformLinkId: string;
  channelKey: string;
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
}

export interface TrafficChannelTermRow {
  channelKey: string;
  contractorKey: string;
  contractorTitle: string;
  validFrom: Date;
  validTo: Date | null;
  validFromBasis: TrafficValidFromBasis;
}

export interface TrafficBindingsSnapshot {
  channels: Array<{ key: string; title: string }>;
  contractors: Array<{ key: string; title: string }>;
  terms: TrafficChannelTermRow[];
  bindings: TrafficBindingIntervalRow[];
}

/** Every channel, contractor, term and link binding, open and closed (four
 * small tables, written by the owner's CLI only). */
export async function readTrafficBindingsSnapshot(db: Database): Promise<TrafficBindingsSnapshot> {
  const channels = await db.execute<{ key: string; title: string }>(sql`
    select key, title from traffic_channels order by key`);
  const contractors = await db.execute<{ key: string; title: string }>(sql`
    select key, title from traffic_contractors order by key`);
  const terms = await db.execute<{
    channelKey: string; contractorKey: string; contractorTitle: string;
    validFrom: Date | string; validTo: Date | string | null; validFromBasis: TrafficValidFromBasis;
  }>(sql`
    select c.key as "channelKey", k.key as "contractorKey", k.title as "contractorTitle",
           t.valid_from as "validFrom", t.valid_to as "validTo", t.valid_from_basis as "validFromBasis"
    from traffic_channel_contractors t
    join traffic_channels c on c.id = t.channel_id
    join traffic_contractors k on k.id = t.contractor_id
    order by c.key, t.valid_from, t.id`);
  const bindings = await db.execute<{
    platformAccountId: number | string; linkKind: TrafficLinkKind; platformLinkId: string; channelKey: string;
    validFrom: Date | string; validTo: Date | string | null; validFromBasis: TrafficValidFromBasis;
  }>(sql`
    select b.platform_account_id as "platformAccountId", b.link_kind as "linkKind",
           b.platform_link_id as "platformLinkId", c.key as "channelKey",
           b.valid_from as "validFrom", b.valid_to as "validTo", b.valid_from_basis as "validFromBasis"
    from traffic_link_bindings b
    join traffic_channels c on c.id = b.channel_id
    order by b.platform_account_id, b.link_kind, b.platform_link_id, b.valid_from, b.id`);
  return {
    channels: channels.rows,
    contractors: contractors.rows,
    terms: terms.rows.map((row) => ({
      ...row,
      validFrom: toDate(row.validFrom),
      validTo: toDateOrNull(row.validTo),
    })),
    bindings: bindings.rows.map((row) => ({
      ...row,
      platformAccountId: Number(row.platformAccountId),
      validFrom: toDate(row.validFrom),
      validTo: toDateOrNull(row.validTo),
    })),
  };
}
