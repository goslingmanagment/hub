import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { domainEventNotSupersededSql } from "./domain-event-supersession.ts";

// chat-extension "new subscribers" list (hub-pr-plan H-7c): the reads behind
// GET /api/v1/client/pages/:pageLabel/audience-new. Raw SQL over tables other
// lanes own (domain_events, fans, page_fans, page_subscriptions,
// page_dm_threads, ofapi_webhook_events). Nothing here writes, and nothing
// reads a column of the Fansly chain in page_dm_threads.
//
// The rows are the canonical `subscription.started` / `subscription.renewed`
// events of one page (the OFAPI webhook canonicalizer writes them from
// `subscriptions.new` / `subscriptions.renewed`): `occurred_at` is the
// notification's own time, `data.subType` what OnlyFans called it.

/**
 * Which subscription events are rows, and as what OnlyFans names them. Any
 * other pair is not a row: one the hub does not know is counted
 * (countClientAudienceNewUnlisted), one it knows and leaves out on purpose
 * (CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES) is not.
 *
 * The EVENT TYPE takes part, not the subType alone: a `subscription.renewed`
 * event is a fan who came back and is never a row of kind `new`, whatever its
 * subType says. The other way round OnlyFans' word is not the last one: the
 * list's route turns a row it names new into a return when the hub holds an
 * earlier subscription of the fan.
 */
export const CLIENT_AUDIENCE_NEW_CLASSES = [
  { type: "subscription.started", subType: "new_subscriber", kind: "new", trial: false },
  { type: "subscription.started", subType: "new_subscriber_trial", kind: "new", trial: true },
  { type: "subscription.started", subType: "returning_subscriber", kind: "returning", trial: false },
  { type: "subscription.renewed", subType: "returning_subscriber", kind: "returning", trial: false },
] as const;

export type ClientAudienceNewClass = Pick<(typeof CLIENT_AUDIENCE_NEW_CLASSES)[number], "kind" | "trial">;

/**
 * SubTypes that are no subscription at all and are left out knowingly: neither
 * rows nor counted as unknown. OnlyFans reports the top-fan award as
 * `subscriptions.new`. Counting it would mark every long window as incomplete
 * for a fact the list is not about.
 *
 * The hub's one list of them: the Agent Read `subscription_events` dataset
 * (agent-dataset-map.ts) leaves the same subTypes out by reading it.
 */
export const CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES = ["customer_award_for_model_top"] as const;

const EVENT_TYPES = [...new Set(CLIENT_AUDIENCE_NEW_CLASSES.map((entry) => entry.type))];

/** The row an event is, or null for one that is only counted. */
export function classifyClientAudienceNewEvent(type: string, subType: string | null): ClientAudienceNewClass | null {
  const found = CLIENT_AUDIENCE_NEW_CLASSES.find((entry) => entry.type === type && entry.subType === subType);
  return found ? { kind: found.kind, trial: found.trial } : null;
}

/** The walk's fixed window: events of the page that happened in [from, to] and that the hub had recorded by `snapshotAt`. */
export interface ClientAudienceNewWindow {
  pageId: number;
  from: Date;
  to: Date;
  snapshotAt: Date;
}

/** A keyset position: `occurred_at` to the microsecond, as Postgres spells it, and the event id. */
export interface ClientAudienceNewPosition {
  at: string;
  id: string;
}

export interface ClientAudienceNewEventRow {
  eventId: string;
  type: string;
  subType: string | null;
  /** The fan's OnlyFans id: always the client's one numeric id shape. */
  fanRef: string;
  occurredAt: Date;
  position: ClientAudienceNewPosition;
}

const windowSql = (window: ClientAudienceNewWindow): SQL => sql`e.account_id = ${window.pageId}
  and e.type in (${sql.join(EVENT_TYPES.map((type) => sql`${type}`), sql`, `)})
  and e.occurred_at >= ${window.from} and e.occurred_at <= ${window.to}
  and e.created_at <= ${window.snapshotAt}
  and ${domainEventNotSupersededSql("e")}`;

/**
 * An event that is a row: a known (type, subType) pair and a fan id of the
 * client's numeric shape that is not the page's own account. The last one is
 * history: the first canonicalizer of subscription webhooks keyed the event to
 * the creator, and such an event names no fan. Null (no subType) is not true,
 * so the counter negates this with `is not true`.
 */
const LISTED_SQL: SQL = sql`((e.type, e.data->>'subType') in (${sql.join(
  CLIENT_AUDIENCE_NEW_CLASSES.map((entry) => sql`(${entry.type}, ${entry.subType})`),
  sql`, `,
)})
  and e.fan_identity_ref ~ '^[1-9][0-9]{0,29}$'
  and e.fan_identity_ref is distinct from (select p.external_page_id from pages p where p.id = e.account_id))`;

/**
 * One page of the window's rows, newest first: `occurred_at` descending, then
 * the event id descending (notification times are whole minutes, so ties are
 * common). `before` is the last row of the previous page; the next page holds
 * the rows strictly after it in that order.
 */
export async function listClientAudienceNewEvents(
  db: Database,
  input: ClientAudienceNewWindow & { before: ClientAudienceNewPosition | null; limit: number },
): Promise<{ rows: ClientAudienceNewEventRow[]; hasMore: boolean }> {
  const result = await db.execute<{
    id: string; type: string; sub_type: string | null; fan_ref: string; occurred_at: Date; position_at: string;
  }>(sql`
    select e.id::text as id, e.type, e.data->>'subType' as sub_type, e.fan_identity_ref as fan_ref, e.occurred_at,
      to_char(e.occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as position_at
    from domain_events e
    where ${windowSql(input)} and ${LISTED_SQL}
      ${input.before === null ? sql`` : sql`and (e.occurred_at, e.id) < (${input.before.at}::timestamptz, ${input.before.id}::bigint)`}
    order by e.occurred_at desc, e.id desc
    limit ${input.limit + 1}`);
  const rows = result.rows.slice(0, input.limit).map((row): ClientAudienceNewEventRow => ({
    eventId: row.id,
    type: row.type,
    subType: row.sub_type,
    fanRef: row.fan_ref,
    occurredAt: new Date(row.occurred_at),
    position: { at: row.position_at, id: row.id },
  }));
  return { rows, hasMore: result.rows.length > input.limit };
}

/**
 * The window's subscription events that are not rows and that the hub cannot
 * account for: a (type, subType) pair it does not know, an event keyed to the
 * page's own account, a fan id that is not the client's numeric shape. A
 * subType left out on purpose (the top-fan award) is not among them.
 */
export async function countClientAudienceNewUnlisted(db: Database, window: ClientAudienceNewWindow): Promise<number> {
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from domain_events e
    where ${windowSql(window)} and ${LISTED_SQL} is not true
      and coalesce(e.data->>'subType', '') not in (${sql.join(
        CLIENT_AUDIENCE_NEW_IGNORED_SUB_TYPES.map((subType) => sql`${subType}`),
        sql`, `,
      )})`);
  return Number(result.rows[0]?.n ?? 0);
}

export interface ClientAudienceNewSubscription {
  canonicalStatus: string;
  isCurrent: boolean;
  endsAt: Date | null;
  /** When the row was last written, by a sweep or by a notification. */
  lastSeenAt: Date;
  /**
   * The newest fact of the subscription's life its writers knew
   * (`source_updated_at`): the time of the last notification applied, or the
   * last renewal (else the start) a sweep read.
   */
  lastEvidenceAt: Date | null;
  /** The subscriber sweep that last saw the subscription; null while only notifications wrote it. */
  lastSeenGeneration: number | null;
  /** The subscription's start as its writer knew it (a sweep: OnlyFans' own `subscribeAt`). */
  sourceCreatedAt: Date | null;
}

export interface ClientAudienceNewThread {
  lastMessageAt: Date | null;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  storedMessageCount: number;
  messageCoverageStatus: string;
  messageBackfillComplete: boolean;
}

/** What the hub holds about one fan of the page right now. */
export interface ClientAudienceNewFan {
  username: string | null;
  displayName: string | null;
  /** `page_fans.is_subscriber`; null without a fan record on the page. */
  isSubscriber: boolean | null;
  subscription: ClientAudienceNewSubscription | null;
  thread: ClientAudienceNewThread | null;
}

const dateOrNull = (value: Date | null): Date | null => (value === null ? null : new Date(value));

/**
 * The fans of one page, by OnlyFans id: the fan record, the page's fan record,
 * the subscription and the chat. On OnlyFans the subscription's id and the
 * chat's id are the fan's id. Every fan asked for has an entry, however little
 * the hub holds.
 */
export async function readClientAudienceNewFans(
  db: Database,
  input: { pageId: number; fanRefs: readonly string[] },
): Promise<Map<string, ClientAudienceNewFan>> {
  const fanRefs = [...new Set(input.fanRefs)];
  if (fanRefs.length === 0) return new Map();
  const result = await db.execute<{
    fan_ref: string; username: string | null; display_name: string | null; is_subscriber: boolean | null;
    has_subscription: boolean; canonical_status: string | null; is_current: boolean | null; ends_at: Date | null;
    subscription_seen_at: Date | null; last_seen_generation: string | null; source_created_at: Date | null;
    source_updated_at: Date | null;
    has_thread: boolean; partner_username: string | null; partner_display_name: string | null;
    last_message_at: Date | null; last_fan_message_at: Date | null; last_model_message_at: Date | null;
    stored_message_count: number | null; message_coverage_status: string | null; message_backfill_complete: boolean | null;
  }>(sql`
    select r.fan_ref, f.username, f.display_name, pf.is_subscriber,
      s.id is not null as has_subscription, s.canonical_status, s.is_current, s.ends_at,
      s.last_seen_at as subscription_seen_at, s.last_seen_generation::text as last_seen_generation, s.source_created_at,
      s.source_updated_at,
      t.id is not null as has_thread, t.partner_username, t.partner_display_name,
      t.last_message_at, t.last_fan_message_at, t.last_model_message_at,
      t.stored_message_count, t.message_coverage_status::text as message_coverage_status, t.message_backfill_complete
    from unnest(${sql.param(fanRefs)}::text[]) as r(fan_ref)
    join pages p on p.id = ${input.pageId}
    left join fans f on f.platform = p.platform and f.platform_user_id = r.fan_ref
    left join page_fans pf on pf.platform_account_id = p.id and pf.fan_id = f.id
    left join page_subscriptions s on s.platform_account_id = p.id and s.platform_subscription_id = r.fan_ref
    left join page_dm_threads t on t.platform_account_id = p.id and t.platform_conversation_id = r.fan_ref`);
  return new Map(result.rows.map((row) => [row.fan_ref, {
    // The chat's own copy of the names covers a fan the fan record does not name.
    username: row.username ?? row.partner_username,
    displayName: row.display_name ?? row.partner_display_name,
    isSubscriber: row.is_subscriber,
    subscription: row.has_subscription ? {
      canonicalStatus: row.canonical_status!,
      isCurrent: row.is_current === true,
      endsAt: dateOrNull(row.ends_at),
      lastSeenAt: new Date(row.subscription_seen_at!),
      lastEvidenceAt: dateOrNull(row.source_updated_at),
      lastSeenGeneration: row.last_seen_generation === null ? null : Number(row.last_seen_generation),
      sourceCreatedAt: dateOrNull(row.source_created_at),
    } : null,
    thread: row.has_thread ? {
      lastMessageAt: dateOrNull(row.last_message_at),
      lastFanMessageAt: dateOrNull(row.last_fan_message_at),
      lastModelMessageAt: dateOrNull(row.last_model_message_at),
      storedMessageCount: Number(row.stored_message_count ?? 0),
      messageCoverageStatus: row.message_coverage_status ?? "pending_backfill",
      messageBackfillComplete: row.message_backfill_complete === true,
    } : null,
  }]));
}

/**
 * Notifications of the given webhook event types that the page received since
 * `since` and that are not applied to its subscriber state: still waiting, or
 * failed. While there is one, a row's subscription state may be out of date.
 */
export async function countClientAudienceProjectionBacklog(
  db: Database,
  input: { pageId: number; since: Date; eventTypes: readonly string[] },
): Promise<{ pending: number; failed: number }> {
  if (input.eventTypes.length === 0) return { pending: 0, failed: 0 };
  const result = await db.execute<{ pending: number; failed: number }>(sql`
    select count(*) filter (where projection_status = 'pending')::int as pending,
      count(*) filter (where projection_status = 'failed')::int as failed
    from ofapi_webhook_events
    where platform_account_id = ${input.pageId} and received_at >= ${input.since}
      and event_type in (${sql.join(input.eventTypes.map((type) => sql`${type}`), sql`, `)})
      and projection_status in ('pending', 'failed')`);
  return { pending: Number(result.rows[0]?.pending ?? 0), failed: Number(result.rows[0]?.failed ?? 0) };
}

/**
 * Subscription notifications of the page that the hub journaled since `since`
 * and has not turned into events yet: webhook observations of the given kinds
 * still below the canonicalizer's parse version. While there is one, the list
 * may be missing a row.
 *
 * One bounded probe per (kind, version below the floor) off
 * observations_health_floor_idx (0144: parse_version, source, kind,
 * received_at), the way the health-floor gauge reads the same backlog: a
 * caught-up page is an empty index range, never a walk of the journal. A
 * webhook observation carries no page id; it names its page by the provider's
 * account id (`native_account_ref`), which the canonicalize driver resolves
 * against the page's OFAPI account id and its own account id.
 */
export async function countClientAudiencePendingNotifications(
  db: Database,
  input: { pageId: number; since: Date; kinds: readonly string[]; belowParseVersion: number },
): Promise<number> {
  if (input.kinds.length === 0 || input.belowParseVersion <= 0) return 0;
  const result = await db.execute<{ n: number }>(sql`
    select count(*)::int as n
    from pages p
    cross join unnest(${sql.param([...input.kinds])}::text[]) as wanted(kind)
    cross join generate_series(0, ${input.belowParseVersion - 1}::integer) as below_floor(parse_version)
    cross join lateral (
      select 1 from observations o
      where o.parse_version = below_floor.parse_version and o.source = 'webhook' and o.kind = wanted.kind
        and o.received_at >= ${input.since}
        and (o.account_id = p.id or (o.account_id is null and o.platform = p.platform
          and o.native_account_ref in (p.ofapi_account_id, p.external_page_id)))
    ) pending
    where p.id = ${input.pageId}`);
  return Number(result.rows[0]?.n ?? 0);
}

/** The database's clock to the millisecond: the unit the wire and a cursor carry. */
export async function readClientAudienceClock(db: Database): Promise<Date> {
  const result = await db.execute<{ now: Date }>(sql`select date_trunc('milliseconds', clock_timestamp()) as now`);
  return new Date(result.rows[0]!.now);
}
