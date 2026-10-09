import { sql, type SQL } from "drizzle-orm";
import {
  LINK_FAN_JOURNAL_ENDPOINTS,
  type LinkFanListKind,
  type LinkFanPeriodStartSource,
  type TrafficLinkKind,
} from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { capturePayloadRefFromColumns, type CapturePayloadRef } from "./capture-payloads.ts";
import { CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES } from "./client-audience-new.ts";
import { domainEventNotSupersededSql } from "./domain-event-supersession.ts";

// OnlyFans link ↔ fan (migration 0260; plan 2026-10-08, PR 8). The store of a
// projection of the paid fan sweep's journal: every write here applies ONE
// journal page (a sync_raw_payloads row of a link_fans_* kind), in journal-id
// order, under the page's projection lock, and moves the page's cursor past
// it in the same transaction. The live sweep and the rebuild command
// (link-fans:reproject) drive the same functions, so a rebuild from the
// journal arrives at the state the sweep wrote.
//
// The period rule (ofapi_subscription_period_equal_split.v1) is spelled out in
// packages/shared/src/link-fans.ts and migration 0260.

/** The endpoint list as SQL constants — the predicate of the partial index
 *  sync_raw_payloads_link_fans_idx (0261). A bound parameter would not imply
 *  it, and the read would scan the whole journal. */
export const LINK_FAN_JOURNAL_ENDPOINTS_SQL = `(${
  LINK_FAN_JOURNAL_ENDPOINTS.map((endpoint) => `'${endpoint}'`).join(", ")
})`;

const NOT_A_SUBSCRIPTION_SUB_TYPES = [...CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES] as string[];

// One lock space for the projection; the key is the page id.
const LINK_FAN_PROJECTION_LOCK_CLASS = 0x4c46; // "LF"

/** Take the page's projection lock if it is free; false when another
 *  transaction (a rebuild, the other sweep chunk) holds it. */
export async function tryLockLinkFanProjection(tx: Database, pageId: number): Promise<boolean> {
  const result = await tx.execute<{ locked: boolean }>(sql`
    select pg_try_advisory_xact_lock(${LINK_FAN_PROJECTION_LOCK_CLASS}::integer, ${pageId}::integer) as locked
  `);
  return result.rows[0]?.locked === true;
}

export interface LinkFanJournalCursor {
  lastRawPayloadId: number;
  rule: string;
}

/** The page's cursor without a lock; a page never projected reads as id 0. */
export async function readLinkFanJournalCursor(db: Database, pageId: number): Promise<LinkFanJournalCursor | null> {
  const result = await db.execute<{ last_raw_payload_id: string; rule: string }>(sql`
    select last_raw_payload_id::text, rule
      from page_link_fan_journal_cursors
     where platform_account_id = ${pageId}
  `);
  const row = result.rows[0];
  return row ? { lastRawPayloadId: Number(row.last_raw_payload_id), rule: row.rule } : null;
}

/** The page's cursor, created at 0 under `rule` when missing, locked for the
 *  rest of the transaction. Call with the projection lock held. */
export async function lockLinkFanJournalCursor(
  tx: Database,
  pageId: number,
  rule: string,
): Promise<LinkFanJournalCursor> {
  await tx.execute(sql`
    insert into page_link_fan_journal_cursors (platform_account_id, rule)
    values (${pageId}, ${rule})
    on conflict (platform_account_id) do nothing
  `);
  const result = await tx.execute<{ last_raw_payload_id: string; rule: string }>(sql`
    select last_raw_payload_id::text, rule
      from page_link_fan_journal_cursors
     where platform_account_id = ${pageId}
     for update
  `);
  const row = result.rows[0];
  if (!row) throw new Error(`link-fans: cursor of page ${pageId} vanished under its lock`);
  return { lastRawPayloadId: Number(row.last_raw_payload_id), rule: row.rule };
}

/** Move an existing cursor past one journal page, applied or not; false when
 *  the page has no cursor (it is never created here). */
export async function advanceLinkFanJournalCursor(
  tx: Database,
  input: { pageId: number; rawPayloadId: number; applied: boolean },
): Promise<boolean> {
  const result = await tx.execute(sql`
    update page_link_fan_journal_cursors
       set last_raw_payload_id = ${input.rawPayloadId},
           pages_applied = pages_applied + ${input.applied ? 1 : 0},
           pages_skipped = pages_skipped + ${input.applied ? 0 : 1},
           updated_at = now()
     where platform_account_id = ${input.pageId}
       and last_raw_payload_id < ${input.rawPayloadId}
  `);
  return Number((result as { rowCount?: number | null }).rowCount ?? 0) > 0;
}

export interface LinkFanJournalRow {
  id: number;
  endpoint: string;
  capturedAt: Date;
  /** The inline body; null on a pointer-only row (resolve it through the
   *  runtime's payload seam, never here). */
  payload: unknown;
  payloadRef: CapturePayloadRef | null;
}

/** The page's next journal pages of the link_fans_* kinds after `afterId`, in
 *  id order. The sweep is their only writer and journals one page at a time
 *  per page (one sync chunk per page and stream), so id order is the order
 *  they were captured in and no lower id can commit after a higher one. */
export async function listLinkFanJournalRowsAfter(
  db: Database,
  input: { pageId: number; afterId: number; limit: number },
): Promise<LinkFanJournalRow[]> {
  const result = await db.execute<{
    id: string;
    endpoint: string;
    captured_at: Date | string;
    response_payload: unknown;
    payload_bucket_month: string | null;
    payload_object_id: string | null;
  }>(sql`
    select rp.id::text as id, rp.endpoint, rp.captured_at, rp.response_payload,
           to_char(rp.payload_bucket_month, 'YYYY-MM-DD') as payload_bucket_month,
           rp.payload_object_id::text as payload_object_id
      from sync_raw_payloads rp
     where rp.page_id = ${input.pageId}
       and rp.endpoint in ${sql.raw(LINK_FAN_JOURNAL_ENDPOINTS_SQL)}
       and rp.id > ${input.afterId}
     order by rp.id
     limit ${Math.max(1, Math.min(input.limit, 500))}
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    endpoint: row.endpoint,
    capturedAt: row.captured_at instanceof Date ? row.captured_at : new Date(row.captured_at),
    payload: row.response_payload,
    payloadRef: capturePayloadRefFromColumns(row.payload_bucket_month, row.payload_object_id),
  }));
}

/** Where the walk goes after this page, as the journaled page says. */
export type LinkFansPageNext =
  | { kind: "last" }
  | { kind: "offset"; offset: number }
  | { kind: "invalid" };

export interface LinkFanSubscriberItem {
  platformUserId: string;
  /** subscribedOnExpiredNow === false — the only state a period is open in. */
  active: boolean;
  vendorStatus: "active" | "expired" | null;
  vendorSubscribedAt: Date | null;
  vendorExpiresAt: Date | null;
}

export interface LinkFanSpenderItem {
  platformUserId: string;
  revenueNetMills: bigint | null;
  chargebacksMills: bigint | null;
  calculatedAt: Date | null;
}

export interface LinkFansPageInput {
  pageId: number;
  rawPayloadId: number;
  capturedAt: Date;
  linkKind: TrafficLinkKind;
  linkId: string;
  listKind: LinkFanListKind;
  requestSeq: number;
  ofapiAccountId: string | null;
  offset: number;
  /** Items the page carried, readable or not (the walk's item count). */
  itemCount: number;
  next: LinkFansPageNext;
  subscribers: LinkFanSubscriberItem[];
  spenders: LinkFanSpenderItem[];
}

export interface LinkFansPageResult {
  walkId: number;
  walkState: "reading" | "finished" | "broken" | "ignored";
  fansSeen: number;
  unknownFans: number;
  periodsOpened: number;
  periodsClosed: number;
}

interface WalkRow {
  id: number;
  ofapiAccountId: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  brokenReason: string | null;
  nextOffset: number | null;
  lastOffset: number;
  lastPageItems: number;
  items: number;
  evidential: boolean | null;
}

type WalkSqlRow = {
  id: string;
  ofapi_account_id: string | null;
  started_at: Date | string;
  finished_at: Date | string | null;
  broken_reason: string | null;
  next_offset: number | null;
  last_offset: number;
  last_page_items: number;
  items: number;
  evidential: boolean | null;
};

const WALK_COLUMNS = sql.raw(
  "id::text, ofapi_account_id, started_at, finished_at, broken_reason, next_offset, last_offset, last_page_items, items, evidential",
);

function toWalk(row: WalkSqlRow): WalkRow {
  return {
    id: Number(row.id),
    ofapiAccountId: row.ofapi_account_id,
    startedAt: new Date(row.started_at),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at),
    brokenReason: row.broken_reason,
    nextOffset: row.next_offset,
    lastOffset: row.last_offset,
    lastPageItems: row.last_page_items,
    items: row.items,
    evidential: row.evidential,
  };
}

function nextOffsetOf(next: LinkFansPageNext, offset: number): number | null | "invalid" {
  if (next.kind === "last") return null;
  if (next.kind === "invalid" || next.offset <= offset) return "invalid";
  return next.offset;
}

/** Apply one page of the walk to the walk's row: append, re-read, finish or
 *  break. A page is the walk's next one only at the offset the previous page
 *  pointed to; the same offset again is a re-read (the sweep re-buys the page
 *  a failed chunk had journaled) and replaces that page's items. A finishing
 *  page also settles whether the walk is evidential: whether some subscriber
 *  list of the page under the walk's OFAPI account has returned a fan, this
 *  walk included (П9.10). */
async function applyWalkPage(tx: Database, page: LinkFansPageInput): Promise<{
  walk: WalkRow;
  state: LinkFansPageResult["walkState"];
  finishedNow: boolean;
}> {
  const existing = await tx.execute<WalkSqlRow>(sql`
    select ${WALK_COLUMNS}
      from page_link_fan_walks
     where platform_account_id = ${page.pageId} and link_kind = ${page.linkKind}
       and platform_link_id = ${page.linkId} and list_kind = ${page.listKind}
       and request_seq = ${page.requestSeq}
     for update
  `);
  const following = nextOffsetOf(page.next, page.offset);
  const current = existing.rows[0];
  const evidentialSql = (items: number) => sql`(
    ${page.listKind === "subscribers" && items > 0}::boolean
    or exists (
      select 1 from page_link_fan_walks other
       where other.platform_account_id = ${page.pageId}
         and other.list_kind = 'subscribers'
         and other.ofapi_account_id is not distinct from ${page.ofapiAccountId}
         and other.items > 0
    )
  )`;

  if (!current) {
    const broken = page.offset !== 0 ? "offset_gap" : following === "invalid" ? "pagination_invalid" : null;
    const finished = broken === null && following === null;
    const inserted = await tx.execute<WalkSqlRow>(sql`
      insert into page_link_fan_walks (
        platform_account_id, link_kind, platform_link_id, list_kind, request_seq, ofapi_account_id,
        started_at, finished_at, api_pages, items, next_offset, last_offset, last_page_items,
        broken_reason, evidential, first_raw_payload_id, last_raw_payload_id
      ) values (
        ${page.pageId}, ${page.linkKind}, ${page.linkId}, ${page.listKind}, ${page.requestSeq}, ${page.ofapiAccountId},
        ${page.capturedAt}, ${finished ? page.capturedAt : null}, 1, ${page.itemCount},
        ${broken === null && typeof following === "number" ? following : null},
        ${page.offset}, ${page.itemCount}, ${broken},
        ${finished ? evidentialSql(page.itemCount) : null},
        ${page.rawPayloadId}, ${page.rawPayloadId}
      )
      returning ${WALK_COLUMNS}
    `);
    const walk = toWalk(inserted.rows[0]!);
    return { walk, state: finished ? "finished" : broken === null ? "reading" : "broken", finishedNow: finished };
  }

  const walk = toWalk(current);
  if (walk.finishedAt !== null || walk.brokenReason !== null) {
    // A finished walk read again under the same revision (a lost sweep cursor
    // restarts it) or pages after a break: their fans are still sightings,
    // the walk's own record stays as it was.
    return { walk, state: "ignored", finishedNow: false };
  }

  // A walk is one account's answer. After a rebind mid-walk the sweep goes on
  // under the same revision with the new account; a walk glued from two
  // accounts' pages proves nothing (the new one's cold list is no absence).
  const reread = page.offset === walk.lastOffset && page.offset !== walk.nextOffset;
  const breaking = page.ofapiAccountId !== walk.ofapiAccountId
    ? "account_changed"
    : page.offset !== walk.nextOffset && !reread ? "offset_gap" : null;
  if (breaking !== null) {
    const broken = await tx.execute<WalkSqlRow>(sql`
      update page_link_fan_walks
         set broken_reason = ${breaking}, next_offset = null,
             last_raw_payload_id = ${page.rawPayloadId}, updated_at = now()
       where id = ${walk.id}
      returning ${WALK_COLUMNS}
    `);
    return { walk: toWalk(broken.rows[0]!), state: "broken", finishedNow: false };
  }

  const items = reread ? walk.items - walk.lastPageItems + page.itemCount : walk.items + page.itemCount;
  const brokenReason = following === "invalid" ? "pagination_invalid" : null;
  const finished = brokenReason === null && following === null;
  const updated = await tx.execute<WalkSqlRow>(sql`
    update page_link_fan_walks
       set api_pages = api_pages + ${reread ? 0 : 1},
           items = ${items},
           last_offset = ${page.offset},
           last_page_items = ${page.itemCount},
           next_offset = ${brokenReason === null && typeof following === "number" ? following : null},
           broken_reason = ${brokenReason},
           finished_at = ${finished ? page.capturedAt : null},
           evidential = ${finished ? evidentialSql(items) : null},
           last_raw_payload_id = ${page.rawPayloadId},
           updated_at = now()
     where id = ${walk.id}
    returning ${WALK_COLUMNS}
  `);
  return {
    walk: toWalk(updated.rows[0]!),
    state: finished ? "finished" : brokenReason === null ? "reading" : "broken",
    finishedNow: finished,
  };
}

/** The page's fans among the platform ids: a fan without his page_fans row
 *  on this page (erased from it, or never upserted) is not written. */
async function resolveFanIds(tx: Database, pageId: number, platformUserIds: string[]): Promise<Map<string, number>> {
  if (platformUserIds.length === 0) return new Map();
  const result = await tx.execute<{ id: string; platform_user_id: string }>(sql`
    select f.id::text, f.platform_user_id
      from fans f
      join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${pageId}
     where f.platform = 'onlyfans'
       and f.platform_user_id = any(${sql.param(platformUserIds)}::text[])
  `);
  return new Map(result.rows.map((row) => [row.platform_user_id, Number(row.id)]));
}

/** The last item of a fan on a page wins (a page should not repeat him). */
function lastPerFan<T extends { platformUserId: string }>(items: readonly T[]): T[] {
  const byFan = new Map<string, T>();
  for (const item of items) byFan.set(item.platformUserId, item);
  return [...byFan.values()];
}

const isoOrNull = (value: Date | null) => (value === null ? null : value.toISOString());

/**
 * Apply one journaled page of a link's subscribers or spenders list. Call in a
 * transaction holding the page's projection lock and the erasure fence, in
 * journal order; the fans the page names must already be the page's (the
 * sweep upserts fans and page_fans before it projects; a fan erased since is
 * skipped, never recreated).
 */
export async function applyLinkFansPage(tx: Database, page: LinkFansPageInput): Promise<LinkFansPageResult> {
  const { walk, state, finishedNow } = await applyWalkPage(tx, page);
  const linkKey = sql`platform_account_id = ${page.pageId} and link_kind = ${page.linkKind}
    and platform_link_id = ${page.linkId}`;

  const result: LinkFansPageResult = {
    walkId: walk.id,
    walkState: state,
    fansSeen: 0,
    unknownFans: 0,
    periodsOpened: 0,
    periodsClosed: 0,
  };

  if (page.listKind === "spenders") {
    const spenders = lastPerFan(page.spenders);
    const fanIds = await resolveFanIds(tx, page.pageId, spenders.map((item) => item.platformUserId));
    const known = spenders.filter((item) => fanIds.has(item.platformUserId));
    result.unknownFans = spenders.length - known.length;
    result.fansSeen = known.length;
    if (known.length > 0) {
      await tx.execute(sql`
        insert into page_link_fans (
          platform_account_id, link_kind, platform_link_id, fan_id, in_subscriber_list,
          first_seen_at, last_seen_at, vendor_revenue_net_mills, vendor_chargebacks_mills,
          vendor_revenue_calculated_at, vendor_revenue_seen_at, first_raw_payload_id, last_raw_payload_id
        )
        select ${page.pageId}, ${page.linkKind}, ${page.linkId}, s.fan_id, false,
               ${page.capturedAt}, ${page.capturedAt}, s.net, s.chargebacks, s.calculated_at,
               ${page.capturedAt}, ${page.rawPayloadId}, ${page.rawPayloadId}
          from unnest(
            ${sql.param(known.map((item) => fanIds.get(item.platformUserId)!))}::bigint[],
            ${sql.param(known.map((item) => item.revenueNetMills?.toString() ?? null))}::bigint[],
            ${sql.param(known.map((item) => item.chargebacksMills?.toString() ?? null))}::bigint[],
            ${sql.param(known.map((item) => isoOrNull(item.calculatedAt)))}::timestamptz[]
          ) as s(fan_id, net, chargebacks, calculated_at)
        on conflict (platform_account_id, link_kind, platform_link_id, fan_id) do update set
          last_seen_at = excluded.last_seen_at,
          vendor_revenue_net_mills = excluded.vendor_revenue_net_mills,
          vendor_chargebacks_mills = excluded.vendor_chargebacks_mills,
          vendor_revenue_calculated_at = excluded.vendor_revenue_calculated_at,
          vendor_revenue_seen_at = excluded.vendor_revenue_seen_at,
          last_raw_payload_id = excluded.last_raw_payload_id,
          updated_at = now()
      `);
    }
    return result;
  }

  const subscribers = lastPerFan(page.subscribers);
  const fanIds = await resolveFanIds(tx, page.pageId, subscribers.map((item) => item.platformUserId));
  const known = subscribers.filter((item) => fanIds.has(item.platformUserId));
  result.unknownFans = subscribers.length - known.length;
  result.fansSeen = known.length;

  if (known.length > 0) {
    // A sighting: the fan is in the list now, with the vendor's flag.
    await tx.execute(sql`
      insert into page_link_fans (
        platform_account_id, link_kind, platform_link_id, fan_id, in_subscriber_list,
        first_seen_at, last_seen_at, last_seen_walk_id, last_seen_active, absent_since, absent_walks,
        vendor_subscribed_at, vendor_expires_at, vendor_status, first_raw_payload_id, last_raw_payload_id
      )
      select ${page.pageId}, ${page.linkKind}, ${page.linkId}, s.fan_id, true,
             ${page.capturedAt}, ${page.capturedAt}, ${walk.id}, s.active, null, 0,
             s.subscribed_at, s.expires_at, s.status, ${page.rawPayloadId}, ${page.rawPayloadId}
        from unnest(
          ${sql.param(known.map((item) => fanIds.get(item.platformUserId)!))}::bigint[],
          ${sql.param(known.map((item) => item.active))}::boolean[],
          ${sql.param(known.map((item) => isoOrNull(item.vendorSubscribedAt)))}::timestamptz[],
          ${sql.param(known.map((item) => isoOrNull(item.vendorExpiresAt)))}::timestamptz[],
          ${sql.param(known.map((item) => item.vendorStatus))}::text[]
        ) as s(fan_id, active, subscribed_at, expires_at, status)
      on conflict (platform_account_id, link_kind, platform_link_id, fan_id) do update set
        in_subscriber_list = true,
        last_seen_at = excluded.last_seen_at,
        last_seen_walk_id = excluded.last_seen_walk_id,
        last_seen_active = excluded.last_seen_active,
        absent_since = null,
        absent_walks = 0,
        vendor_subscribed_at = excluded.vendor_subscribed_at,
        vendor_expires_at = excluded.vendor_expires_at,
        vendor_status = excluded.vendor_status,
        last_raw_payload_id = excluded.last_raw_payload_id,
        updated_at = now()
    `);

    const active = known.filter((item) => item.active).map((item) => fanIds.get(item.platformUserId)!);
    if (active.length > 0) {
      result.periodsOpened = await openPeriods(tx, page, walk.id, active, fanIds, known);
    }
  }

  if (finishedNow) {
    result.periodsClosed = await closeAtFinishedWalk(tx, page, walk, linkKey);
  }
  return result;
}

/** Open a period for each active fan that has none open: before the link's
 *  floor as "before floor"; after it at the fan's one subscription.started
 *  webhook since the link's last finished walk, else at this sighting. */
async function openPeriods(
  tx: Database,
  page: LinkFansPageInput,
  walkId: number,
  activeFanIds: number[],
  fanIds: Map<string, number>,
  known: LinkFanSubscriberItem[],
): Promise<number> {
  const open = await tx.execute<{ fan_id: string }>(sql`
    select fan_id::text from page_link_fan_periods
     where platform_account_id = ${page.pageId} and link_kind = ${page.linkKind}
       and platform_link_id = ${page.linkId} and closed_at is null
       and fan_id = any(${sql.param(activeFanIds)}::bigint[])
  `);
  const hasOpen = new Set(open.rows.map((row) => Number(row.fan_id)));
  const opening = activeFanIds.filter((fanId) => !hasOpen.has(fanId));
  if (opening.length === 0) return 0;

  // The link's floor is its first finished evidential subscriber walk: before
  // one exists every active fan is "before floor". The last such walk bounds
  // the webhook window from below. The walk this page belongs to is not
  // "before" its own pages, even when this page finished it.
  const floor = await tx.execute<{ last_finished_at: Date | string | null }>(sql`
    select max(started_at) as last_finished_at
      from page_link_fan_walks
     where platform_account_id = ${page.pageId} and link_kind = ${page.linkKind}
       and platform_link_id = ${page.linkId} and list_kind = 'subscribers'
       and finished_at is not null and evidential
       and id <> ${walkId}
  `);
  const lastFinishedAt = floor.rows[0]?.last_finished_at ?? null;

  const starts = new Map<number, { at: Date | null; source: LinkFanPeriodStartSource }>();
  if (lastFinishedAt === null) {
    for (const fanId of opening) starts.set(fanId, { at: null, source: "before_floor" });
  } else {
    const refByFanId = new Map(known.map((item) => [fanIds.get(item.platformUserId)!, item.platformUserId]));
    const refs = opening.map((fanId) => refByFanId.get(fanId)!);
    const events = await tx.execute<{ fan_ref: string; n: number; occurred_at: Date | string }>(sql`
      select e.fan_identity_ref as fan_ref, count(*)::int as n, min(e.occurred_at) as occurred_at
        from domain_events e
       where e.account_id = ${page.pageId}
         and e.type = 'subscription.started'
         and e.occurred_at > ${new Date(lastFinishedAt)}
         and e.occurred_at <= ${page.capturedAt}
         and e.fan_identity_ref = any(${sql.param(refs)}::text[])
         and coalesce(e.data ->> 'subType', '') <> all(${sql.param(NOT_A_SUBSCRIPTION_SUB_TYPES)}::text[])
         and ${domainEventNotSupersededSql("e")}
       group by e.fan_identity_ref
    `);
    const unique = new Map(events.rows.filter((row) => row.n === 1)
      .map((row) => [row.fan_ref, new Date(row.occurred_at)]));
    for (const fanId of opening) {
      const at = unique.get(refByFanId.get(fanId)!);
      starts.set(fanId, at ? { at, source: "hub_subscription_event" } : { at: page.capturedAt, source: "first_seen" });
    }
  }

  const inserted = await tx.execute(sql`
    insert into page_link_fan_periods (
      platform_account_id, link_kind, platform_link_id, fan_id, link_fan_id,
      period_start_at, period_start_source, opened_at, opened_walk_id
    )
    select ${page.pageId}, ${page.linkKind}, ${page.linkId}, s.fan_id, f.id,
           s.start_at, s.source, ${page.capturedAt}, ${walkId}
      from unnest(
        ${sql.param(opening)}::bigint[],
        ${sql.param(opening.map((fanId) => isoOrNull(starts.get(fanId)!.at)))}::timestamptz[],
        ${sql.param(opening.map((fanId) => starts.get(fanId)!.source))}::text[]
      ) as s(fan_id, start_at, source)
      join page_link_fans f
        on f.platform_account_id = ${page.pageId} and f.link_kind = ${page.linkKind}
       and f.platform_link_id = ${page.linkId} and f.fan_id = s.fan_id
  `);
  return Number((inserted as { rowCount?: number | null }).rowCount ?? 0);
}

/** At the end of a finished subscriber walk: close the periods of fans it
 *  showed not active, then count the fans it missed — when it may (П9.10) —
 *  and close the periods of those it missed twice in a row. */
async function closeAtFinishedWalk(
  tx: Database,
  page: LinkFansPageInput,
  walk: WalkRow,
  linkKey: SQL,
): Promise<number> {
  // A period opened inside this very walk and shown not active by a later
  // page of it (a re-read) closes where it starts: it covers nothing.
  const notActive = await tx.execute(sql`
    update page_link_fan_periods p
       set closed_at = case when p.opened_walk_id = ${walk.id}
                            then coalesce(p.period_start_at, p.opened_at)
                            else ${walk.startedAt} end,
           close_reason = 'not_active', closed_walk_id = ${walk.id}, updated_at = now()
      from page_link_fans f
     where f.id = p.link_fan_id
       and p.closed_at is null
       and p.platform_account_id = ${page.pageId} and p.link_kind = ${page.linkKind}
       and p.platform_link_id = ${page.linkId}
       and f.last_seen_walk_id = ${walk.id}
       and f.last_seen_active is false
  `);
  let closed = Number((notActive as { rowCount?: number | null }).rowCount ?? 0);

  if (walk.evidential !== true) return closed;

  // Counted up to two: past that nothing is open to close, and a sighting
  // resets the count.
  await tx.execute(sql`
    update page_link_fans
       set absent_walks = absent_walks + 1,
           absent_since = coalesce(absent_since, ${walk.startedAt}),
           updated_at = now()
     where ${linkKey}
       and in_subscriber_list
       and last_seen_walk_id is distinct from ${walk.id}
       and absent_walks < 2
  `);
  const absent = await tx.execute(sql`
    update page_link_fan_periods p
       set closed_at = f.absent_since, close_reason = 'absent', closed_walk_id = ${walk.id}, updated_at = now()
      from page_link_fans f
     where f.id = p.link_fan_id
       and p.closed_at is null
       and p.platform_account_id = ${page.pageId} and p.link_kind = ${page.linkKind}
       and p.platform_link_id = ${page.linkId}
       and f.absent_walks >= 2
  `);
  closed += Number((absent as { rowCount?: number | null }).rowCount ?? 0);
  return closed;
}
