import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { AWAITING_MASS_MIN_CHATS } from "./spender-stats.ts";

// Fan queues (0333, docs/plans/2026-10-29-fan-queues/spec.md): the fans of one
// page gathered by a rule or a list, kept here and handed out to the page's
// chatters in portions. The rule is the service's to read and say in words
// (apps/runtime/src/services/fan-queue-rules.ts); this file turns its
// normalized form into one query over what Hub holds, writes queues and items,
// hands out portions under row locks and counts outcomes. Nothing here talks
// to a platform.

/** The OnlyFans contactability values that say the page cannot write to the fan. */
const UNREACHABLE = ["unavailable", "restricted", "blocked", "gone"];
/** Marks a queue leaves out unless its rule says otherwise. */
export const FAN_QUEUE_DEFAULT_EXCLUDED_MARKERS: readonly string[] = ["💩", "бомж"];

export interface FanQueueMoment {
  /** At least this old: before the moment. */
  before: Date | null;
  /** At most this old: at or after the moment. */
  since: Date | null;
}
export interface FanQueueMillsRange {
  min: number | null;
  max: number | null;
}

/** The rule in Hub's terms: moments instead of days, mills instead of dollars. */
export interface FanQueueFilter {
  audience: "followers" | "subscribers" | "expired" | "any";
  fanWrote: "never" | "ever" | null;
  fanLastMessage: FanQueueMoment | null;
  pagePersonal: "never" | FanQueueMoment | null;
  lifetimeGross: FanQueueMillsRange | null;
  gross30d: FanQueueMillsRange | null;
  lastPurchase: FanQueueMoment | null;
  followed: FanQueueMoment | null;
  subscribed: FanQueueMoment | null;
  subscriptionEndsBy: Date | null;
  autoRenew: boolean | null;
  seenSince: Date | null;
  notSeenSince: Date | null;
  otherPagesGross: FanQueueMillsRange | null;
  markersInclude: readonly string[];
  /** null: the default marks (💩, «бомж»). */
  markersExclude: readonly string[] | null;
  order: "spend" | "seen" | "followed_new" | "followed_old" | "fan_message" | "random";
  limit: number | null;
}

export interface FanQueueCandidate {
  fanId: number;
  fanRef: string;
  username: string | null;
  displayName: string | null;
  alias: string | null;
  isFollower: boolean;
  followerSince: Date | null;
  isSubscriber: boolean;
  subscriberSince: Date | null;
  lifetimeGrossMills: number;
  lastTransactionAt: Date | null;
  seenAt: Date | null;
  lastFanMessageAt: Date | null;
  lastPageMessageAt: Date | null;
  /** Every chat of the fan with the page has its whole history in Hub (or there is none). */
  historyComplete: boolean;
  /** A list's own why. */
  listWhy: string | null;
}

export interface FanQueueSelection {
  fans: FanQueueCandidate[];
  excluded: { unreachable: number; dismissed: number; inOtherQueues: number; markers: number; overLimit: number };
}

const toDate = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));
const ts = (date: Date) => sql`${date.toISOString()}::timestamptz`;
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

function momentCondition(column: SQL, moment: FanQueueMoment, nullIsOld: boolean): SQL {
  const parts: SQL[] = [];
  if (moment.before !== null) parts.push(nullIsOld ? sql`(${column} is null or ${column} < ${ts(moment.before)})` : sql`${column} < ${ts(moment.before)}`);
  if (moment.since !== null) parts.push(sql`${column} >= ${ts(moment.since)}`);
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` and `);
}

function rangeCondition(column: SQL, range: FanQueueMillsRange): SQL {
  const parts: SQL[] = [];
  if (range.min !== null) parts.push(sql`${column} >= ${range.min}`);
  if (range.max !== null) parts.push(sql`${column} <= ${range.max}`);
  return parts.length === 0 ? sql`true` : sql.join(parts, sql` and `);
}

function markerMatch(markers: readonly string[]): SQL {
  if (markers.length === 0) return sql`false`;
  return sql`(${sql.join(markers.map((marker) => sql`position(${marker.toLowerCase()} in marktext) > 0`), sql` or `)})`;
}

const ORDERS: Record<FanQueueFilter["order"], SQL> = {
  spend: sql`gross desc, seen_at desc nulls last, fan_id`,
  seen: sql`seen_at desc nulls last, gross desc, fan_id`,
  followed_new: sql`follower_since desc nulls last, fan_id`,
  followed_old: sql`follower_since asc nulls last, fan_id`,
  fan_message: sql`last_fan_at desc nulls last, gross desc, fan_id`,
  random: sql`md5(fan_id::text || 'fan-queue'), fan_id`,
};

/**
 * The page's fans a filter (or a list of fans) takes, in queue order, and how
 * many it left out: a fan Hub cannot reach, one marked «Не предлагать», one in
 * an open queue of the page (other than `exceptQueueId`), one with an
 * excluded mark, and those beyond the limit.
 */
export async function selectFanQueueFans(
  db: Database,
  input: {
    pageId: number;
    platform: string;
    now: Date;
    filter: FanQueueFilter;
    siblingPageIds: readonly number[];
    list: ReadonlyArray<{ fanId: number; why: string | null }> | null;
    exceptQueueId: number | null;
  },
): Promise<FanQueueSelection> {
  const page = input.pageId;
  const filter = input.filter;
  const list = input.list;
  const needsPersonal = filter.pagePersonal !== null;
  const needs30 = filter.gross30d !== null;
  const needsOther = filter.otherPagesGross !== null;
  const conditions: SQL[] = [];
  switch (filter.audience) {
    case "followers": conditions.push(sql`is_follower`); break;
    case "subscribers": conditions.push(sql`is_subscriber`); break;
    case "expired": conditions.push(sql`not is_subscriber and had_subscription`); break;
    default: break;
  }
  if (filter.fanWrote === "never") conditions.push(sql`last_fan_at is null`);
  if (filter.fanWrote === "ever") conditions.push(sql`last_fan_at is not null`);
  if (filter.fanLastMessage !== null) conditions.push(momentCondition(sql`last_fan_at`, filter.fanLastMessage, false));
  if (filter.pagePersonal === "never") conditions.push(sql`last_personal_at is null`);
  else if (filter.pagePersonal !== null) conditions.push(momentCondition(sql`last_personal_at`, filter.pagePersonal, true));
  if (filter.lifetimeGross !== null) conditions.push(rangeCondition(sql`gross`, filter.lifetimeGross));
  if (filter.gross30d !== null) conditions.push(rangeCondition(sql`gross30`, filter.gross30d));
  if (filter.lastPurchase !== null) conditions.push(momentCondition(sql`last_tx`, filter.lastPurchase, true));
  if (filter.followed !== null) conditions.push(momentCondition(sql`follower_since`, filter.followed, false));
  if (filter.subscribed !== null) conditions.push(momentCondition(sql`subscriber_since`, filter.subscribed, false));
  if (filter.subscriptionEndsBy !== null) {
    conditions.push(sql`is_subscriber and subscription_expires_at > ${ts(input.now)} and subscription_expires_at <= ${ts(filter.subscriptionEndsBy)}`);
  }
  if (filter.autoRenew !== null) conditions.push(sql`auto_renew = ${filter.autoRenew}`);
  if (filter.seenSince !== null) conditions.push(sql`seen_at >= ${ts(filter.seenSince)}`);
  if (filter.notSeenSince !== null) conditions.push(sql`(seen_at is null or seen_at < ${ts(filter.notSeenSince)})`);
  if (filter.otherPagesGross !== null) conditions.push(rangeCondition(sql`other_gross`, filter.otherPagesGross));
  if (filter.markersInclude.length > 0) conditions.push(markerMatch(filter.markersInclude));
  const excludedMarks = filter.markersExclude ?? FAN_QUEUE_DEFAULT_EXCLUDED_MARKERS;
  const where = conditions.length === 0 ? sql`true` : sql.join(conditions, sql` and `);
  const order = list === null ? ORDERS[filter.order] : sql`list_ord, fan_id`;
  const listJoin = list === null
    ? sql``
    : sql`join unnest(${ids(list.map((one) => one.fanId))}, ${sql.param(list.map((one) => one.why ?? ""))}::text[]) with ordinality as lst(fan_id, why, ord) on lst.fan_id = pf.fan_id`;
  const result = await db.execute<{
    fan_id: string | number; fan_ref: string; username: string | null; display_name: string | null; alias: string | null;
    is_follower: boolean; follower_since: Date | string | null; is_subscriber: boolean; subscriber_since: Date | string | null;
    gross: string | number; last_tx: Date | string | null; seen_at: Date | string | null; last_fan_at: Date | string | null;
    last_page_at: Date | string | null; history_complete: boolean; list_why: string | null; excluded_by: string | null;
  }>(sql`
    with base as (
      select pf.fan_id, f.platform_user_id as fan_ref, f.username, f.display_name, pf.page_alias as alias,
        pf.is_follower, pf.follower_since, pf.is_subscriber, pf.subscriber_since, pf.subscription_expires_at, pf.auto_renew,
        pf.external_presence_at as seen_at,
        (f.deleted_detected_at is not null
          or coalesce(pf.account_contactability, '') = any(${sql.param(UNREACHABLE)}::text[])
          or pf.account_probe_resolved = false) as unreachable,
        coalesce(l.gross_amount_mills, 0)::bigint as gross, l.last_transaction_at as last_tx,
        ${list === null ? sql`null::text as list_why, 0::bigint as list_ord` : sql`nullif(lst.why, '') as list_why, lst.ord as list_ord`}
      from page_fans pf
      join fans f on f.id = pf.fan_id
      left join fan_spend_lifetime l on l.platform_account_id = pf.platform_account_id and l.fan_id = pf.fan_id
      ${listJoin}
      where pf.platform_account_id = ${page}
    ),
    th as (
      select t.fan_id, max(t.last_fan_message_at) as last_fan_at, max(t.last_model_message_at) as last_model_at,
        bool_and(t.message_backfill_complete) as history_complete
      from page_dm_threads t
      where t.platform_account_id = ${page} and t.fan_id is not null
      group by t.fan_id
    ),
    ${needsPersonal ? sql`
    mass_keys as (
      select date_trunc('hour', b.occurred_at) as h, coalesce(b.text_plain, '') as txt, coalesce(b.price_mills, 0) as price
      from message_archive b
      where b.account_id = ${page} and b.is_sent_by_me and b.deleted_at is null
      group by 1, 2, 3
      having count(distinct b.conversation_ref) >= ${AWAITING_MASS_MIN_CHATS}
    ),
    personal_rows as (
      select t.fan_id, max(m.occurred_at) as at
      from message_archive m
      join page_dm_threads t on t.platform_account_id = ${page} and t.platform_conversation_id = m.conversation_ref and t.fan_id is not null
      where m.account_id = ${page} and m.is_sent_by_me and m.deleted_at is null and coalesce(m.message_type, 1) <> 2
        and not exists (
          select 1 from mass_keys k
          where k.h = date_trunc('hour', m.occurred_at) and k.txt = coalesce(m.text_plain, '') and k.price = coalesce(m.price_mills, 0)
        )
      group by t.fan_id
      union all
      select f.id, max(a.observed_at)
      from client_send_attributions a
      join fans f on f.platform = ${input.platform} and f.platform_user_id = a.fan_ref
      where a.page_id = ${page}
      group by f.id
    ),
    personal as (select fan_id, max(at) as last_personal_at from personal_rows group by fan_id),` : sql``}
    ${needs30 ? sql`
    spend30 as (
      select d.fan_id, coalesce(sum(d.gross_amount_mills), 0)::bigint as gross30
      from fan_spend_daily d
      where d.platform_account_id = ${page} and d.business_date >= (${ts(input.now)})::date - 30
      group by d.fan_id
    ),` : sql``}
    ${needsOther ? sql`
    other as (
      select l2.fan_id, coalesce(sum(l2.gross_amount_mills), 0)::bigint as other_gross
      from fan_spend_lifetime l2
      where l2.platform_account_id = any(${ids(input.siblingPageIds)})
      group by l2.fan_id
    ),` : sql``}
    marks as (
      select o.fan_id,
        (array_agg(o.action order by o.attempted_at desc, o.id desc) filter (where o.action in ('dismissed', 'restored')))[1] as mark
      from online_attempts o
      where o.page_id = ${page}
      group by o.fan_id
    ),
    queued as (
      select distinct i.fan_id from fan_queue_items i
      where i.page_id = ${page} and i.state in ('pending', 'leased')
        ${input.exceptQueueId === null ? sql`` : sql`and i.queue_id <> ${input.exceptQueueId}`}
    ),
    notes as (
      select n.fan_id, string_agg(coalesce(n.title, '') || ' ' || coalesce(n.body, ''), ' ') as txt
      from page_fan_external_notes n
      where n.platform_account_id = ${page} and n.is_active
      group by n.fan_id
    ),
    facts as (
      select b.*, th.last_fan_at, th.last_model_at, coalesce(th.history_complete, true) as history_complete,
        ${needsPersonal ? sql`p.last_personal_at` : sql`null::timestamptz as last_personal_at`},
        ${needs30 ? sql`coalesce(s30.gross30, 0)::bigint as gross30` : sql`0::bigint as gross30`},
        ${needsOther ? sql`coalesce(o.other_gross, 0)::bigint as other_gross` : sql`0::bigint as other_gross`},
        ${filter.audience === "expired"
          ? sql`exists (select 1 from page_subscriptions s where s.platform_account_id = ${page} and s.fan_id = b.fan_id) as had_subscription`
          : sql`false as had_subscription`},
        coalesce(m.mark = 'dismissed', false) as dismissed,
        (q.fan_id is not null) as in_queue,
        lower(coalesce(b.alias, '') || ' ' || coalesce(nt.txt, '')) as marktext
      from base b
      left join th on th.fan_id = b.fan_id
      ${needsPersonal ? sql`left join personal p on p.fan_id = b.fan_id` : sql``}
      ${needs30 ? sql`left join spend30 s30 on s30.fan_id = b.fan_id` : sql``}
      ${needsOther ? sql`left join other o on o.fan_id = b.fan_id` : sql``}
      left join marks m on m.fan_id = b.fan_id
      left join queued q on q.fan_id = b.fan_id
      left join notes nt on nt.fan_id = b.fan_id
    )
    select fan_id, fan_ref, username, display_name, alias, is_follower, follower_since, is_subscriber, subscriber_since,
      gross, last_tx, seen_at, last_fan_at, greatest(last_personal_at, last_model_at) as last_page_at, history_complete, list_why,
      case
        when unreachable then 'unreachable'
        when dismissed then 'dismissed'
        when in_queue then 'in_queue'
        when ${markerMatch(excludedMarks)} then 'markers'
      end as excluded_by
    from facts
    where ${where}
    order by ${order}`);
  const fans: FanQueueCandidate[] = [];
  const excluded = { unreachable: 0, dismissed: 0, inOtherQueues: 0, markers: 0, overLimit: 0 };
  const limit = input.filter.limit;
  for (const row of result.rows) {
    switch (row.excluded_by) {
      case "unreachable": excluded.unreachable += 1; continue;
      case "dismissed": excluded.dismissed += 1; continue;
      case "in_queue": excluded.inOtherQueues += 1; continue;
      case "markers": excluded.markers += 1; continue;
      default: break;
    }
    if (limit !== null && fans.length >= limit) { excluded.overLimit += 1; continue; }
    fans.push({
      fanId: Number(row.fan_id),
      fanRef: row.fan_ref,
      username: row.username,
      displayName: row.display_name,
      alias: row.alias,
      isFollower: row.is_follower,
      followerSince: toDate(row.follower_since),
      isSubscriber: row.is_subscriber,
      subscriberSince: toDate(row.subscriber_since),
      lifetimeGrossMills: Number(row.gross),
      lastTransactionAt: toDate(row.last_tx),
      seenAt: toDate(row.seen_at),
      lastFanMessageAt: toDate(row.last_fan_at),
      lastPageMessageAt: toDate(row.last_page_at),
      historyComplete: row.history_complete,
      listWhy: row.list_why,
    });
  }
  return { fans, excluded };
}

/** The page's fans by platform id or username (case-insensitive), for a list. */
export async function resolveFanQueueRefs(
  db: Database,
  input: { pageId: number; platform: string; refs: readonly string[] },
): Promise<Map<string, number>> {
  if (input.refs.length === 0) return new Map();
  const result = await db.execute<{ ref: string; fan_id: string | number }>(sql`
    select r.ref, pf.fan_id
    from unnest(${sql.param([...input.refs])}::text[]) as r(ref)
    join fans f on f.platform = ${input.platform}
      and (f.platform_user_id = r.ref or lower(f.username) = lower(ltrim(r.ref, '@')))
    join page_fans pf on pf.fan_id = f.id and pf.platform_account_id = ${input.pageId}`);
  const found = new Map<string, number>();
  for (const row of result.rows) if (!found.has(row.ref)) found.set(row.ref, Number(row.fan_id));
  return found;
}

/** The model's other active pages of the same platform. */
export async function listFanQueueSiblingPageIds(db: Database, input: { pageId: number }): Promise<number[]> {
  const result = await db.execute<{ id: string | number }>(sql`
    select o.id from pages p
    join pages o on o.model_id = p.model_id and o.platform = p.platform and o.id <> p.id
    where p.id = ${input.pageId} and o.status = 'active' and o.deleted_at is null`);
  return result.rows.map((row) => Number(row.id));
}

/** A person by Hub username, and whether they may work the page (the owner may work every page). */
export async function findFanQueuePerson(
  db: Database,
  input: { username: string; pageId: number },
): Promise<{ userId: number; username: string; role: string; granted: boolean } | null> {
  const result = await db.execute<{ id: string | number; username: string; role: string; granted: boolean }>(sql`
    select u.id, u.username, u.role,
      (u.role = 'owner' or exists (
        select 1 from user_page_assignments a where a.user_id = u.id and a.platform_account_id = ${input.pageId}
      )) as granted
    from users u
    where lower(u.username) = lower(${input.username}) and u.deleted_at is null
    limit 1`);
  const row = result.rows[0];
  return row === undefined ? null : { userId: Number(row.id), username: row.username, role: row.role, granted: row.granted };
}

// ── queues ─────────────────────────────────────────────────────────────────

export interface FanQueueRow {
  id: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  name: string;
  goal: string | null;
  kind: "campaign" | "standing";
  status: "active" | "paused" | "done";
  rule: Record<string, unknown> | null;
  ruleText: string[] | null;
  scenario: Record<string, unknown>;
  distribution: "pool" | "people";
  people: number[];
  peopleNames: string[];
  perPerson: number | null;
  dailyLimit: number | null;
  endsAt: Date | null;
  refilledOn: string | null;
  requestedByUserId: number;
  requestedBy: string;
  createdByAgentKeyId: number | null;
  createdAt: Date;
  pausedAt: Date | null;
  pausedBy: string | null;
  finishedAt: Date | null;
}

const QUEUE_COLUMNS = sql`
  q.id, q.page_id, p.label as page_label, p.platform, q.name, q.goal, q.kind, q.status, q.rule, q.rule_text, q.scenario,
  q.distribution, q.people, coalesce((select array_agg(u.username order by u.username) from users u where u.id = any(q.people)), '{}') as people_names,
  q.per_person, q.daily_limit, q.ends_at, q.refilled_on::text as refilled_on, q.requested_by_user_id, rb.username as requested_by,
  q.created_by_agent_key_id, q.created_at, q.paused_at, pb.username as paused_by, q.finished_at`;
const QUEUE_FROM = sql`
  from fan_queues q
  join pages p on p.id = q.page_id
  join users rb on rb.id = q.requested_by_user_id
  left join users pb on pb.id = q.paused_by_user_id`;

type QueueDbRow = {
  id: string | number; page_id: string | number; page_label: string; platform: string; name: string; goal: string | null; kind: string;
  status: string; rule: Record<string, unknown> | null; rule_text: string | null; scenario: Record<string, unknown>; distribution: string;
  people: Array<string | number> | null; people_names: string[] | null; per_person: number | null; daily_limit: number | null;
  ends_at: Date | string | null; refilled_on: string | null; requested_by_user_id: string | number; requested_by: string;
  created_by_agent_key_id: string | number | null; created_at: Date | string; paused_at: Date | string | null; paused_by: string | null;
  finished_at: Date | string | null;
};

function queueOf(row: QueueDbRow): FanQueueRow {
  return {
    id: Number(row.id),
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    platform: row.platform,
    name: row.name,
    goal: row.goal,
    kind: row.kind === "standing" ? "standing" : "campaign",
    status: row.status === "paused" ? "paused" : row.status === "done" ? "done" : "active",
    rule: row.rule,
    ruleText: row.rule_text === null ? null : row.rule_text.split("\n"),
    scenario: row.scenario,
    distribution: row.distribution === "people" ? "people" : "pool",
    people: (row.people ?? []).map(Number),
    peopleNames: row.people_names ?? [],
    perPerson: row.per_person,
    dailyLimit: row.daily_limit,
    endsAt: toDate(row.ends_at),
    refilledOn: row.refilled_on,
    requestedByUserId: Number(row.requested_by_user_id),
    requestedBy: row.requested_by,
    createdByAgentKeyId: row.created_by_agent_key_id === null ? null : Number(row.created_by_agent_key_id),
    createdAt: new Date(row.created_at),
    pausedAt: toDate(row.paused_at),
    pausedBy: row.paused_by,
    finishedAt: toDate(row.finished_at),
  };
}

export async function findFanQueueByIdempotencyKey(db: Database, key: string): Promise<FanQueueRow | null> {
  const result = await db.execute<QueueDbRow>(sql`select ${QUEUE_COLUMNS} ${QUEUE_FROM} where q.idempotency_key = ${key}`);
  return result.rows[0] === undefined ? null : queueOf(result.rows[0]);
}

export async function getFanQueue(db: Database, queueId: number, options: { forUpdate?: boolean } = {}): Promise<FanQueueRow | null> {
  const result = await db.execute<QueueDbRow>(sql`
    select ${QUEUE_COLUMNS} ${QUEUE_FROM} where q.id = ${queueId} ${options.forUpdate ? sql`for update of q` : sql``}`);
  return result.rows[0] === undefined ? null : queueOf(result.rows[0]);
}

export async function listFanQueues(
  db: Database,
  input: { pageIds: readonly number[]; statuses: ReadonlyArray<FanQueueRow["status"]> },
): Promise<FanQueueRow[]> {
  if (input.pageIds.length === 0 || input.statuses.length === 0) return [];
  const result = await db.execute<QueueDbRow>(sql`
    select ${QUEUE_COLUMNS} ${QUEUE_FROM}
    where q.page_id = any(${ids(input.pageIds)}) and q.status = any(${sql.param([...input.statuses])}::text[])
    order by q.page_id, q.created_at, q.id`);
  return result.rows.map(queueOf);
}

export async function insertFanQueue(
  db: Database,
  input: {
    pageId: number; name: string; goal: string | null; kind: FanQueueRow["kind"]; rule: Record<string, unknown> | null;
    ruleText: string[] | null; scenario: Record<string, unknown>; distribution: FanQueueRow["distribution"]; people: readonly number[];
    perPerson: number | null; dailyLimit: number | null; endsAt: Date | null; refilledOn: string | null; requestedByUserId: number;
    createdByAgentKeyId: number | null; createdByUserId: number | null; idempotencyKey: string | null;
  },
): Promise<number> {
  const result = await db.execute<{ id: string | number }>(sql`
    insert into fan_queues (page_id, name, goal, kind, status, rule, rule_text, scenario, distribution, people, per_person, daily_limit,
      ends_at, refilled_on, requested_by_user_id, created_by_agent_key_id, created_by_user_id, idempotency_key)
    values (${input.pageId}, ${input.name}, ${input.goal}, ${input.kind}, 'active',
      ${input.rule === null ? null : JSON.stringify(input.rule)}::jsonb, ${input.ruleText === null ? null : input.ruleText.join("\n")},
      ${JSON.stringify(input.scenario)}::jsonb, ${input.distribution}, ${ids(input.people)}, ${input.perPerson}, ${input.dailyLimit},
      ${input.endsAt === null ? null : input.endsAt.toISOString()}::timestamptz, ${input.refilledOn}::date, ${input.requestedByUserId},
      ${input.createdByAgentKeyId}, ${input.createdByUserId}, ${input.idempotencyKey})
    returning id`);
  return Number(result.rows[0]!.id);
}

export async function updateFanQueue(
  db: Database,
  input: {
    queueId: number;
    status?: FanQueueRow["status"]; pausedByUserId?: number | null; name?: string; goal?: string | null;
    scenario?: Record<string, unknown>; perPerson?: number | null; dailyLimit?: number | null; endsAt?: Date | null;
    people?: readonly number[]; refilledOn?: string; now: Date;
  },
): Promise<void> {
  const sets: SQL[] = [sql`updated_at = ${ts(input.now)}`];
  if (input.status !== undefined) {
    sets.push(sql`status = ${input.status}`);
    if (input.status === "paused") sets.push(sql`paused_at = ${ts(input.now)}`, sql`paused_by_user_id = ${input.pausedByUserId ?? null}`);
    if (input.status === "active") sets.push(sql`paused_at = null`, sql`paused_by_user_id = null`);
    if (input.status === "done") sets.push(sql`finished_at = ${ts(input.now)}`);
  }
  if (input.name !== undefined) sets.push(sql`name = ${input.name}`);
  if (input.goal !== undefined) sets.push(sql`goal = ${input.goal}`);
  if (input.scenario !== undefined) sets.push(sql`scenario = ${JSON.stringify(input.scenario)}::jsonb`);
  if (input.perPerson !== undefined) sets.push(sql`per_person = ${input.perPerson}`);
  if (input.dailyLimit !== undefined) sets.push(sql`daily_limit = ${input.dailyLimit}`);
  if (input.endsAt !== undefined) sets.push(sql`ends_at = ${input.endsAt === null ? null : input.endsAt.toISOString()}::timestamptz`);
  if (input.people !== undefined) sets.push(sql`people = ${ids(input.people)}`);
  if (input.refilledOn !== undefined) sets.push(sql`refilled_on = ${input.refilledOn}::date`);
  await db.execute(sql`update fan_queues set ${sql.join(sets, sql`, `)} where id = ${input.queueId}`);
}

/**
 * Adds items at the end of a queue, in order. A fan already in an open item of
 * the page is skipped (the partial unique index decides, so two writers never
 * queue one fan twice). Returns how many were added.
 */
export async function insertFanQueueItems(
  db: Database,
  input: {
    queueId: number; pageId: number; now: Date;
    items: ReadonlyArray<{ fanId: number; fanRef: string; why: string | null; assigneeUserId: number | null }>;
  },
): Promise<number> {
  if (input.items.length === 0) return 0;
  const result = await db.execute<{ n: string | number }>(sql`
    with start as (select coalesce(max(rank), 0) as r from fan_queue_items where queue_id = ${input.queueId}),
    rows as (
      select x.fan_id, x.fan_ref, nullif(x.why, '') as why, nullif(x.assignee, 0) as assignee, x.ord
      from unnest(${ids(input.items.map((item) => item.fanId))}, ${sql.param(input.items.map((item) => item.fanRef))}::text[],
        ${sql.param(input.items.map((item) => item.why ?? ""))}::text[], ${ids(input.items.map((item) => item.assigneeUserId ?? 0))})
        with ordinality as x(fan_id, fan_ref, why, assignee, ord)
    ),
    added as (
      insert into fan_queue_items (queue_id, page_id, fan_id, fan_ref, rank, why, assignee_user_id, state, created_at, updated_at)
      select ${input.queueId}, ${input.pageId}, r.fan_id, r.fan_ref, (select r from start) + r.ord::int, r.why, r.assignee, 'pending',
        ${ts(input.now)}, ${ts(input.now)}
      from rows r
      order by r.ord
      on conflict (page_id, fan_id) where state in ('pending', 'leased') do nothing
      returning 1
    )
    select count(*) as n from added`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Pending items no longer in a standing queue's rule, and all pending items of a finished queue, leave it. */
export async function dropPendingFanQueueItems(
  db: Database,
  input: { queueId: number; keepFanIds: readonly number[] | null; reason: string; now: Date },
): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    with gone as (
      update fan_queue_items set state = 'dropped', reason = ${input.reason}, done_at = ${ts(input.now)}, updated_at = ${ts(input.now)}
      where queue_id = ${input.queueId} and state = 'pending'
        ${input.keepFanIds === null ? sql`` : sql`and not (fan_id = any(${ids(input.keepFanIds)}))`}
      returning 1
    )
    select count(*) as n from gone`);
  return Number(result.rows[0]?.n ?? 0);
}

export interface FanQueueCounts {
  pending: number; leased: number; sent: number; skipped: number; dropped: number;
}

export async function countFanQueueItems(db: Database, queueIds: readonly number[]): Promise<Map<number, FanQueueCounts>> {
  const out = new Map<number, FanQueueCounts>();
  if (queueIds.length === 0) return out;
  const result = await db.execute<{ queue_id: string | number; state: string; n: string | number }>(sql`
    select queue_id, state, count(*) as n from fan_queue_items where queue_id = any(${ids(queueIds)}) group by 1, 2`);
  for (const id of queueIds) out.set(id, { pending: 0, leased: 0, sent: 0, skipped: 0, dropped: 0 });
  for (const row of result.rows) {
    const counts = out.get(Number(row.queue_id))!;
    if (row.state in counts) counts[row.state as keyof FanQueueCounts] = Number(row.n);
  }
  return out;
}

/** Sends and skips of the day (from `dayStart`) per queue and person. */
export async function countFanQueueDay(
  db: Database,
  input: { queueIds: readonly number[]; dayStart: Date },
): Promise<Array<{ queueId: number; userId: number; username: string; sent: number; skipped: number }>> {
  if (input.queueIds.length === 0) return [];
  const result = await db.execute<{ queue_id: string | number; user_id: string | number; username: string; sent: string | number; skipped: string | number }>(sql`
    select i.queue_id, i.done_by_user_id as user_id, u.username,
      count(*) filter (where i.state = 'sent') as sent, count(*) filter (where i.state = 'skipped' or (i.state = 'pending' and i.reason = 'later')) as skipped
    from fan_queue_items i
    join users u on u.id = i.done_by_user_id
    where i.queue_id = any(${ids(input.queueIds)}) and i.done_at >= ${ts(input.dayStart)}
    group by 1, 2, 3`);
  return result.rows.map((row) => ({
    queueId: Number(row.queue_id), userId: Number(row.user_id), username: row.username, sent: Number(row.sent), skipped: Number(row.skipped),
  }));
}

/** What a person may still be handed per queue: the pool's pending (pool) or their own (people), past `not_before`. */
export async function countFanQueueAvailable(
  db: Database,
  input: { queueIds: readonly number[]; userId: number; now: Date },
): Promise<Map<number, { pending: number; leasedToMe: number }>> {
  const out = new Map<number, { pending: number; leasedToMe: number }>();
  if (input.queueIds.length === 0) return out;
  const result = await db.execute<{ queue_id: string | number; pending: string | number; mine: string | number }>(sql`
    select i.queue_id,
      count(*) filter (where (i.state = 'pending' or (i.state = 'leased' and i.lease_until < ${ts(input.now)}))
        and (q.distribution = 'pool' or i.assignee_user_id = ${input.userId})) as pending,
      count(*) filter (where i.state = 'leased' and i.leased_to_user_id = ${input.userId} and i.lease_until >= ${ts(input.now)}) as mine
    from fan_queue_items i
    join fan_queues q on q.id = i.queue_id
    where i.queue_id = any(${ids(input.queueIds)})
    group by 1`);
  for (const id of input.queueIds) out.set(id, { pending: 0, leasedToMe: 0 });
  for (const row of result.rows) out.set(Number(row.queue_id), { pending: Number(row.pending), leasedToMe: Number(row.mine) });
  return out;
}

/** Fans per person in a people queue: who has untouched (pending) items. */
export async function countFanQueueAssignees(db: Database, queueId: number): Promise<Map<number, number>> {
  const result = await db.execute<{ user_id: string | number; n: string | number }>(sql`
    select assignee_user_id as user_id, count(*) as n from fan_queue_items
    where queue_id = ${queueId} and state = 'pending' and assignee_user_id is not null group by 1`);
  return new Map(result.rows.map((row) => [Number(row.user_id), Number(row.n)]));
}

/** Hands a person's untouched items to another person (`toUserId`) or to the pool (null). */
export async function moveFanQueueItems(
  db: Database,
  input: { queueId: number; fromUserId: number; toUserId: number | null; count: number | null; now: Date },
): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    with picked as (
      select id from fan_queue_items
      where queue_id = ${input.queueId} and state = 'pending' and assignee_user_id = ${input.fromUserId}
      order by rank
      ${input.count === null ? sql`` : sql`limit ${input.count}`}
      for update skip locked
    ),
    moved as (
      update fan_queue_items i set assignee_user_id = ${input.toUserId}, updated_at = ${ts(input.now)}
      from picked where i.id = picked.id
      returning 1
    )
    select count(*) as n from moved`);
  return Number(result.rows[0]?.n ?? 0);
}

// ── portions ───────────────────────────────────────────────────────────────

export interface FanQueueItemRow {
  id: number;
  queueId: number;
  pageId: number;
  fanId: number;
  fanRef: string;
  rank: number;
  why: string | null;
  assigneeUserId: number | null;
  state: "pending" | "leased" | "sent" | "skipped" | "dropped";
  leasedToUserId: number | null;
  leaseUntil: Date | null;
  createdAt: Date;
}

type ItemDbRow = {
  id: string | number; queue_id: string | number; page_id: string | number; fan_id: string | number; fan_ref: string; rank: number;
  why: string | null; assignee_user_id: string | number | null; state: string; leased_to_user_id: string | number | null;
  lease_until: Date | string | null; created_at: Date | string;
};

function itemOf(row: ItemDbRow): FanQueueItemRow {
  return {
    id: Number(row.id),
    queueId: Number(row.queue_id),
    pageId: Number(row.page_id),
    fanId: Number(row.fan_id),
    fanRef: row.fan_ref,
    rank: Number(row.rank),
    why: row.why,
    assigneeUserId: row.assignee_user_id === null ? null : Number(row.assignee_user_id),
    state: row.state as FanQueueItemRow["state"],
    leasedToUserId: row.leased_to_user_id === null ? null : Number(row.leased_to_user_id),
    leaseUntil: toDate(row.lease_until),
    createdAt: new Date(row.created_at),
  };
}

const ITEM_COLUMNS = sql`id, queue_id, page_id, fan_id, fan_ref, rank, why, assignee_user_id, state, leased_to_user_id, lease_until, created_at`;

/** Portions nobody touched for their lease go back to the queue (the lazy expiry). */
export async function expireFanQueueLeases(db: Database, input: { queueId: number; now: Date }): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    with expired as (
      update fan_queue_items set state = 'pending', leased_to_user_id = null, lease_until = null, updated_at = ${ts(input.now)}
      where queue_id = ${input.queueId} and state = 'leased' and lease_until < ${ts(input.now)}
      returning 1
    )
    select count(*) as n from expired`);
  return Number(result.rows[0]?.n ?? 0);
}

/** A person's portion of a queue, renewed until `until`, in queue order. */
export async function renewFanQueueLeases(
  db: Database,
  input: { queueId: number; userId: number; until: Date; now: Date },
): Promise<FanQueueItemRow[]> {
  const result = await db.execute<ItemDbRow>(sql`
    update fan_queue_items set lease_until = ${ts(input.until)}, updated_at = ${ts(input.now)}
    where queue_id = ${input.queueId} and state = 'leased' and leased_to_user_id = ${input.userId}
    returning ${ITEM_COLUMNS}`);
  return result.rows.map(itemOf).sort((a, b) => a.rank - b.rank);
}

/** The next pending items a person may be handed, locked for this transaction; another taker skips them. */
export async function pickPendingFanQueueItems(
  db: Database,
  input: { queueId: number; userId: number; people: boolean; now: Date; limit: number; skipIds: readonly number[] },
): Promise<FanQueueItemRow[]> {
  const result = await db.execute<ItemDbRow>(sql`
    select ${ITEM_COLUMNS} from fan_queue_items
    where queue_id = ${input.queueId} and state = 'pending'
      and (not_before is null or not_before <= ${ts(input.now)})
      ${input.people ? sql`and assignee_user_id = ${input.userId}` : sql``}
      ${input.skipIds.length === 0 ? sql`` : sql`and not (id = any(${ids(input.skipIds)}))`}
    order by rank
    limit ${input.limit}
    for update skip locked`);
  return result.rows.map(itemOf);
}

export async function leaseFanQueueItems(
  db: Database,
  input: { itemIds: readonly number[]; userId: number; until: Date; now: Date },
): Promise<void> {
  if (input.itemIds.length === 0) return;
  await db.execute(sql`
    update fan_queue_items set state = 'leased', leased_to_user_id = ${input.userId}, lease_until = ${ts(input.until)}, updated_at = ${ts(input.now)}
    where id = any(${ids(input.itemIds)})`);
}

export async function dropFanQueueItems(
  db: Database,
  input: { items: ReadonlyArray<{ id: number; reason: string }>; now: Date },
): Promise<void> {
  if (input.items.length === 0) return;
  await db.execute(sql`
    update fan_queue_items i set state = 'dropped', reason = x.reason, done_at = ${ts(input.now)}, updated_at = ${ts(input.now)},
      leased_to_user_id = null, lease_until = null
    from unnest(${ids(input.items.map((item) => item.id))}, ${sql.param(input.items.map((item) => item.reason))}::text[]) as x(id, reason)
    where i.id = x.id`);
}

export async function deferFanQueueItems(
  db: Database,
  input: { items: ReadonlyArray<{ id: number; until: Date }>; now: Date },
): Promise<void> {
  if (input.items.length === 0) return;
  await db.execute(sql`
    update fan_queue_items i set not_before = x.until, updated_at = ${ts(input.now)}
    from unnest(${ids(input.items.map((item) => item.id))}, ${sql.param(input.items.map((item) => item.until.toISOString()))}::timestamptz[]) as x(id, until)
    where i.id = x.id`);
}

/** The person's leased item, locked; null when it is not theirs (any more). */
export async function findLeasedFanQueueItem(
  db: Database,
  input: { itemId: number; pageId: number; userId: number },
): Promise<FanQueueItemRow | null> {
  const result = await db.execute<ItemDbRow>(sql`
    select ${ITEM_COLUMNS} from fan_queue_items
    where id = ${input.itemId} and page_id = ${input.pageId} and state = 'leased' and leased_to_user_id = ${input.userId}
    for update`);
  return result.rows[0] === undefined ? null : itemOf(result.rows[0]);
}

export async function completeFanQueueItem(
  db: Database,
  input: {
    itemId: number; userId: number; now: Date; observationId: number;
    outcome: "sent" | "skipped" | "dropped" | "later"; act: string | null; templateId: string | null; reason: string | null; notBefore: Date | null;
  },
): Promise<FanQueueItemRow["state"]> {
  // «Позже»: the fan waits in the queue again; who put him off and when stay on the row for the day's count.
  const state = input.outcome === "later" ? "pending" : input.outcome;
  await db.execute(sql`
    update fan_queue_items set state = ${state}, leased_to_user_id = null, lease_until = null,
      done_at = ${ts(input.now)}, done_by_user_id = ${input.userId}, act = ${input.act}, template_id = ${input.templateId},
      reason = ${input.reason}, not_before = ${input.notBefore === null ? null : input.notBefore.toISOString()}::timestamptz,
      observation_id = ${input.observationId}, updated_at = ${ts(input.now)}
    where id = ${input.itemId}`);
  return state;
}

export async function releaseFanQueueLeases(
  db: Database,
  input: { queueId: number; userId: number; now: Date },
): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    with back as (
      update fan_queue_items set state = 'pending', leased_to_user_id = null, lease_until = null, updated_at = ${ts(input.now)}
      where queue_id = ${input.queueId} and state = 'leased' and leased_to_user_id = ${input.userId}
      returning 1
    )
    select count(*) as n from back`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Mass messages each fan got from the page within `days`, and the last one. */
export async function countFanQueueMassMessages(
  db: Database,
  input: { pageId: number; fanIds: readonly number[]; now: Date; days: number },
): Promise<Map<number, { count: number; lastAt: Date | null }>> {
  const out = new Map<number, { count: number; lastAt: Date | null }>();
  if (input.fanIds.length === 0) return out;
  const result = await db.execute<{ fan_id: string | number; n: string | number; last_at: Date | string | null }>(sql`
    with chats as (
      select t.fan_id, t.platform_conversation_id as ref from page_dm_threads t
      where t.platform_account_id = ${input.pageId} and t.fan_id = any(${ids(input.fanIds)})
    )
    select c.fan_id, count(*) as n, max(m.occurred_at) as last_at
    from chats c
    join message_archive m on m.account_id = ${input.pageId} and m.conversation_ref = c.ref
    where m.is_sent_by_me and m.deleted_at is null and m.occurred_at > ${ts(input.now)} - make_interval(days => ${input.days})
      and (coalesce(m.message_type, 1) = 2 or (
        select count(*) from (
          select distinct b.conversation_ref from message_archive b
          where b.account_id = m.account_id and b.is_sent_by_me
            and b.occurred_at >= date_trunc('hour', m.occurred_at) and b.occurred_at < date_trunc('hour', m.occurred_at) + interval '1 hour'
            and coalesce(b.text_plain, '') = coalesce(m.text_plain, '') and coalesce(b.price_mills, 0) = coalesce(m.price_mills, 0)
          limit ${AWAITING_MASS_MIN_CHATS}
        ) burst
      ) >= ${AWAITING_MASS_MIN_CHATS})
    group by c.fan_id`);
  for (const row of result.rows) out.set(Number(row.fan_id), { count: Number(row.n), lastAt: toDate(row.last_at) });
  return out;
}

/** The person's sends from the page's queues within `hours` whose fan answered after, with the answer. */
export async function listFanQueueAnswered(
  db: Database,
  input: { pageId: number; userId: number; now: Date; hours: number },
): Promise<Array<{
  itemId: number; queueId: number; fanId: number; fanRef: string; conversationRef: string | null; username: string | null;
  displayName: string | null; alias: string | null; sentAt: Date; act: string | null; templateId: string | null; answeredAt: Date;
  answerText: string | null;
}>> {
  const result = await db.execute<{
    id: string | number; queue_id: string | number; fan_id: string | number; fan_ref: string; conversation_ref: string | null;
    username: string | null; display_name: string | null; alias: string | null; done_at: Date | string; act: string | null;
    template_id: string | null; answered_at: Date | string; answer_text: string | null;
  }>(sql`
    with sent as (
      select i.id, i.queue_id, i.fan_id, i.fan_ref, i.done_at, i.act, i.template_id
      from fan_queue_items i
      where i.page_id = ${input.pageId} and i.state = 'sent' and i.done_by_user_id = ${input.userId}
        and i.done_at > ${ts(input.now)} - make_interval(hours => ${input.hours})
    ),
    chat as (
      select distinct on (t.fan_id) t.fan_id, t.platform_conversation_id as ref, t.last_fan_message_at, t.last_model_message_at
      from page_dm_threads t join sent s on s.fan_id = t.fan_id
      where t.platform_account_id = ${input.pageId} and t.is_visible
      order by t.fan_id, t.last_message_at desc nulls last
    )
    select s.id, s.queue_id, s.fan_id, s.fan_ref, c.ref as conversation_ref, f.username, f.display_name, pf.page_alias as alias,
      s.done_at, s.act, s.template_id, ans.occurred_at as answered_at, ans.text_plain as answer_text
    from sent s
    join fans f on f.id = s.fan_id
    left join page_fans pf on pf.platform_account_id = ${input.pageId} and pf.fan_id = s.fan_id
    left join chat c on c.fan_id = s.fan_id
    join lateral (
      select m.occurred_at, m.text_plain from message_archive m
      where m.account_id = ${input.pageId} and m.conversation_ref = coalesce(c.ref, s.fan_ref) and not m.is_sent_by_me
        and m.deleted_at is null and m.occurred_at > s.done_at
      order by m.occurred_at desc limit 1
    ) ans on true
    -- Answered already: the page wrote after the fan's answer.
    where not exists (
      select 1 from message_archive o
      where o.account_id = ${input.pageId} and o.conversation_ref = coalesce(c.ref, s.fan_ref) and o.is_sent_by_me
        and o.deleted_at is null and o.occurred_at > ans.occurred_at
    )
    order by ans.occurred_at desc`);
  return result.rows.map((row) => ({
    itemId: Number(row.id), queueId: Number(row.queue_id), fanId: Number(row.fan_id), fanRef: row.fan_ref, conversationRef: row.conversation_ref,
    username: row.username, displayName: row.display_name, alias: row.alias, sentAt: new Date(row.done_at), act: row.act,
    templateId: row.template_id, answeredAt: new Date(row.answered_at), answerText: row.answer_text,
  }));
}

export interface FanQueueResultCounts {
  sent: number; matured72h: number; replied72h: number; matured7d: number; bought7d: number; matured30d: number; spent30dMills: number;
}

/** The queue's sends within [from, to) and what came of them, in all and by person (win-back's counting). */
export async function listFanQueueResults(
  db: Database,
  input: { queueId: number; from: Date; to: Date; now: Date },
): Promise<{ total: FanQueueResultCounts; byPerson: Array<FanQueueResultCounts & { username: string }>; skipped: Record<string, number>; dropped: Record<string, number> }> {
  const now = ts(input.now);
  const result = await db.execute<{
    username: string | null; sent: string | number; m72: string | number; r72: string | number; m7: string | number; b7: string | number;
    m30: string | number; s30: string | number;
  }>(sql`
    with sent as (
      select i.page_id, i.fan_id, i.fan_ref, i.done_at, i.done_by_user_id
      from fan_queue_items i
      where i.queue_id = ${input.queueId} and i.state = 'sent'
        and i.done_at >= ${ts(input.from)} and i.done_at < ${ts(input.to)}
    ),
    judged as (
      select s.*,
        s.done_at <= ${now} - interval '72 hours' as m72,
        s.done_at <= ${now} - interval '7 days' as m7,
        s.done_at <= ${now} - interval '30 days' as m30,
        exists (
          select 1 from page_dm_threads t
          join message_archive m on m.account_id = s.page_id and m.conversation_ref = t.platform_conversation_id
          where t.platform_account_id = s.page_id and t.fan_id = s.fan_id and not m.is_sent_by_me
            and m.occurred_at > s.done_at and m.occurred_at <= s.done_at + interval '72 hours'
        ) as replied,
        exists (
          select 1 from transactions t
          where t.platform_account_id = s.page_id and t.fan_id = s.fan_id and t.is_active and t.gross_amount_mills > 0
            and t.canonical_type not in ('chargeback', 'refund', 'payout_reversal')
            and t.occurred_at > s.done_at and t.occurred_at <= s.done_at + interval '7 days'
        ) as bought,
        (
          select coalesce(sum(t.gross_amount_mills), 0) from transactions t
          where t.platform_account_id = s.page_id and t.fan_id = s.fan_id and t.is_active
            and t.occurred_at > s.done_at and t.occurred_at <= s.done_at + interval '30 days'
        ) as spent
      from sent s
    )
    select u.username, count(*) as sent,
      count(*) filter (where j.m72) as m72, count(*) filter (where j.m72 and j.replied) as r72,
      count(*) filter (where j.m7) as m7, count(*) filter (where j.m7 and j.bought) as b7,
      count(*) filter (where j.m30) as m30, coalesce(sum(j.spent) filter (where j.m30), 0) as s30
    from judged j
    left join users u on u.id = j.done_by_user_id
    group by rollup (u.username)
    order by u.username nulls first`);
  const counts = (row: (typeof result.rows)[number]): FanQueueResultCounts => ({
    sent: Number(row.sent), matured72h: Number(row.m72), replied72h: Number(row.r72), matured7d: Number(row.m7),
    bought7d: Number(row.b7), matured30d: Number(row.m30), spent30dMills: Number(row.s30),
  });
  const empty: FanQueueResultCounts = { sent: 0, matured72h: 0, replied72h: 0, matured7d: 0, bought7d: 0, matured30d: 0, spent30dMills: 0 };
  // `rollup` adds the grand total as the row whose username is null (a sender always has a name).
  let total = empty;
  const byPerson: Array<FanQueueResultCounts & { username: string }> = [];
  for (const row of result.rows) {
    if (row.username === null) total = counts(row);
    else byPerson.push({ username: row.username, ...counts(row) });
  }
  const reasons = await db.execute<{ state: string; reason: string | null; n: string | number }>(sql`
    select state, reason, count(*) as n from fan_queue_items
    where queue_id = ${input.queueId} and (state in ('skipped', 'dropped') or (state = 'pending' and reason = 'later'))
    group by 1, 2`);
  const skipped: Record<string, number> = {};
  const dropped: Record<string, number> = {};
  for (const row of reasons.rows) {
    const reason = row.reason ?? "unknown";
    if (row.state === "dropped") dropped[reason] = (dropped[reason] ?? 0) + Number(row.n);
    else skipped[reason] = (skipped[reason] ?? 0) + Number(row.n);
  }
  return { total, byPerson, skipped, dropped };
}
