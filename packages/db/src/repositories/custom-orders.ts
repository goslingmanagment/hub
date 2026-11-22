import { sql, type SQL } from "drizzle-orm";

import { livePageSql, testPageSql, testUserSql } from "./realm.ts";
import { ppvBoughtSql } from "./shift-sql.ts";
import type { Database } from "../client.ts";

// Заказ кастома (0399; ecosystem plan 2026-11-12, package I): the order, its
// payments (sales of the fan, one sale pays at most one order), its Telegram
// cards, «не кастом» marks, and what the checks and the hints read. Raw SQL:
// the tables are defined by their migration alone. Every change of an order
// leaves an object event (object_events, 0382) in the same transaction — the
// service writes both.

export type CustomOrderStateRow =
  | "recorded" | "paid" | "checked" | "at_model" | "partly" | "shot" | "revision" | "refused" | "given" | "closed" | "cancelled";
export type CustomOrderOriginRow = "extension" | "agent" | "workboard" | "import";

export interface CustomOrderRow {
  id: number;
  pageId: number | null;
  pageLabel: string | null;
  platform: string | null;
  modelName: string | null;
  modelSlug: string | null;
  fanId: number | null;
  fanRef: string | null;
  fanUsername: string | null;
  fanDisplayName: string | null;
  buyer: string | null;
  fanErasedAt: Date | null;
  /** The fan's chat on the page: written at the record, or the fan's thread found now. */
  conversationRef: string | null;
  card: Record<string, unknown>;
  deadlineOn: string | null;
  state: CustomOrderStateRow;
  stateAt: Date;
  stateNote: string | null;
  stateRef: string | null;
  givenMessageRef: string | null;
  givenAt: Date | null;
  acceptedByUserId: number | null;
  acceptedBy: string | null;
  /** The person's name in the people registry; the login when the login has no person. */
  acceptedByName: string | null;
  origin: CustomOrderOriginRow;
  contentopsRef: string | null;
  sourceText: string | null;
  /** The parts ready in the current round (services/custom-orders/rules.ts, `roundOf`). */
  partsDone: Array<"video" | "photos">;
  /** When a person last set «снят» by hand on the board (0410): their word stands for every part until a newer revision request. */
  shotByHandAt: Date | null;
  personFields: string[];
  version: number;
  openRevisions: number;
  createdAt: Date;
  updatedAt: Date;
  paidGrossMills: number;
  paidNetMills: number;
  payments: number;
  firstPaidAt: Date | null;
  /**
   * A sale that pays the order was taken back: OnlyFans wrote its `<id>:reversal` or `<id>:chargeback` row on the
   * page (money-negation-guards.ts), whether or not that row counts in the money. A sale missing from a sync window is
   * not taken back; Fansly writes no such row.
   */
  paymentReversed: boolean;
  telegramRefs: string[];
  /** The agreed total, gross (0436); null — not named. */
  priceMills: number | null;
  /** The deadline was set by the system, «примерно» (0436). */
  deadlineDefault: boolean;
  /** The owner's word on the payment as stored, `{kind, note, by, at}` (0436). */
  paidWord: Record<string, unknown> | null;
  /** Why the order waits on purpose (0436). */
  holdReason: string | null;
  /** The fan asked where the order is: when, and his message (0436). */
  fanAskedAt: Date | null;
  fanAskedRef: string | null;
  /** The sources disagree: the agent's sentence as stored, `{text, by, at}` (0436). */
  issue: Record<string, unknown> | null;
  /** Every file sent and a priced one not bought yet: when, and the last message that carried one (0436). */
  sentAt: Date | null;
  sentMessageRef: string | null;
}

type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const date = (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value)));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const texts = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;

function orderOf(row: Row): CustomOrderRow {
  return {
    id: Number(row.id),
    pageId: num(row.page_id),
    pageLabel: (row.page_label as string | null) ?? null,
    platform: (row.platform as string | null) ?? null,
    modelName: (row.model_name as string | null) ?? null,
    modelSlug: (row.model_slug as string | null) ?? null,
    fanId: num(row.fan_id),
    fanRef: (row.fan_ref as string | null) ?? null,
    fanUsername: (row.fan_username as string | null) ?? null,
    fanDisplayName: (row.fan_display_name as string | null) ?? null,
    buyer: (row.buyer as string | null) ?? null,
    fanErasedAt: date(row.fan_erased_at),
    conversationRef: (row.conversation_ref as string | null) ?? null,
    card: (row.card as Record<string, unknown> | null) ?? {},
    deadlineOn: (row.deadline_on as string | null) ?? null,
    state: row.state as CustomOrderStateRow,
    stateAt: date(row.state_at)!,
    stateNote: (row.state_note as string | null) ?? null,
    stateRef: (row.state_ref as string | null) ?? null,
    givenMessageRef: (row.given_message_ref as string | null) ?? null,
    givenAt: date(row.given_at),
    acceptedByUserId: num(row.accepted_by_user_id),
    acceptedBy: (row.accepted_by as string | null) ?? null,
    acceptedByName: (row.accepted_by_name as string | null) ?? (row.accepted_by as string | null) ?? null,
    origin: row.origin as CustomOrderOriginRow,
    contentopsRef: (row.contentops_ref as string | null) ?? null,
    sourceText: (row.source_text as string | null) ?? null,
    partsDone: ((row.parts_done as string[] | null) ?? []).filter((part): part is "video" | "photos" => part === "video" || part === "photos"),
    shotByHandAt: date(row.shot_by_hand_at),
    personFields: (row.person_fields as string[] | null) ?? [],
    version: Number(row.version ?? 1),
    openRevisions: Number(row.open_revisions ?? 0),
    createdAt: date(row.created_at)!,
    updatedAt: date(row.updated_at)!,
    paidGrossMills: Number(row.paid_gross ?? 0),
    paidNetMills: Number(row.paid_net ?? 0),
    payments: Number(row.payments ?? 0),
    firstPaidAt: date(row.first_paid_at),
    paymentReversed: row.payment_reversed === true,
    telegramRefs: ((row.telegram_refs as string[] | null) ?? []).filter((ref) => typeof ref === "string"),
    priceMills: num(row.price_mills),
    deadlineDefault: row.deadline_default === true,
    paidWord: (row.paid_word as Record<string, unknown> | null) ?? null,
    holdReason: (row.hold_reason as string | null) ?? null,
    fanAskedAt: date(row.fan_asked_at),
    fanAskedRef: (row.fan_asked_ref as string | null) ?? null,
    issue: (row.issue as Record<string, unknown> | null) ?? null,
    sentAt: date(row.sent_at),
    sentMessageRef: (row.sent_message_ref as string | null) ?? null,
  };
}

const ORDER_SELECT = sql`
  select o.id, o.page_id, p.label as page_label, p.platform, m.name as model_name, m.slug as model_slug,
    o.fan_id, f.platform_user_id as fan_ref, f.username as fan_username, f.display_name as fan_display_name,
    o.buyer, o.fan_erased_at,
    coalesce(o.conversation_ref, case when p.platform = 'onlyfans' then f.platform_user_id else (
      select th.platform_conversation_id from page_dm_threads th
      where th.platform_account_id = o.page_id and th.fan_id = o.fan_id
      order by th.last_message_at desc nulls last limit 1) end) as conversation_ref,
    o.card, o.deadline_on::text as deadline_on, o.state, o.state_at, o.state_note, o.state_ref,
    o.given_message_ref, o.given_at, o.accepted_by_user_id, u.username as accepted_by, ap.display_name as accepted_by_name, o.origin, o.contentops_ref,
    o.source_text, o.parts_done, o.shot_by_hand_at, o.person_fields, o.version,
    (select count(*) from custom_order_messages mm where mm.order_id = o.id and mm.kind = 'revision' and mm.done_at is null) as open_revisions,
    o.created_at, o.updated_at,
    coalesce(pay.gross, 0) as paid_gross, coalesce(pay.net, 0) as paid_net, coalesce(pay.n, 0) as payments, pay.first_at as first_paid_at,
    coalesce(pay.reversed, false) as payment_reversed,
    coalesce(cards.refs, '{}'::text[]) as telegram_refs,
    o.price_mills, o.deadline_default, o.paid_word, o.hold_reason, o.fan_asked_at, o.fan_asked_ref, o.issue, o.sent_at, o.sent_message_ref
  from custom_orders o
  left join pages p on p.id = o.page_id
  left join models m on m.id = p.model_id
  left join fans f on f.id = o.fan_id
  left join users u on u.id = o.accepted_by_user_id
  left join person_logins apl on apl.user_id = o.accepted_by_user_id
  left join people ap on ap.id = apl.person_id
  left join lateral (
    -- The money that came: active sales only. One the platform retired (an OnlyFans pending payment gone from its sync
    -- window, a reversal's own row) is no money of the order, though its link stays.
    select sum(t.gross_amount_mills) filter (where t.is_active) as gross, sum(t.creator_net_amount_mills) filter (where t.is_active) as net,
      count(cp.transaction_id) filter (where t.is_active) as n, min(t.occurred_at) filter (where t.is_active) as first_at,
      -- OnlyFans writes a sale's reversal or chargeback as a row of its own, '<id>:reversal' / '<id>:chargeback', on the
      -- same page (money-negation-guards.ts); a guard may write it inactive, it is still the sale taken back. A row
      -- retired as missing from a sync window is not.
      bool_or(exists (
        select 1 from transactions r
        where r.platform_account_id = t.platform_account_id
          and r.transaction_id in (t.transaction_id || ':reversal', t.transaction_id || ':chargeback')
          and r.inactive_reason is distinct from 'missing_from_sync_window')) as reversed
    from custom_order_payments cp left join transactions t on t.id = cp.transaction_id
    where cp.order_id = o.id) pay on true
  left join lateral (
    select array_agg(c.telegram_ref order by c.added_at, c.telegram_ref) as refs
    from custom_order_cards c where c.order_id = o.id) cards on true`;

export const CUSTOM_ORDER_ENDED_STATES: readonly CustomOrderStateRow[] = ["given", "closed", "cancelled"];

/**
 * A given order something still stands against (customs facts spec §7): the agent's sentence of a disagreement, or a sale
 * of it the platform took back (whether or not the original row still counts) with no owner's word, and no hold. It burns, so the board lists it with the live orders
 * (never in «Отдано, ждём слово фана»), and the checks do not close it while it stands. The same rule as the facts'
 * (`customOrderBurnsOf`), over the order `o`.
 */
const GIVEN_STANDS = sql`(o.state = 'given' and o.hold_reason is null and (o.issue is not null or (o.paid_word is null and exists (
    select 1 from custom_order_payments sp
    join transactions st on st.id = sp.transaction_id
    join transactions sr on sr.platform_account_id = st.platform_account_id
      and sr.transaction_id in (st.transaction_id || ':reversal', st.transaction_id || ':chargeback')
    where sp.order_id = o.id and sr.inactive_reason is distinct from 'missing_from_sync_window'))))`;

/** Which realm's orders a board reads (0414): a test viewer's are the test pages' alone, a live one's every other order. */
export type CustomOrderRealmRow = "live" | "test";

function boardScope(input: { pageIds: "all" | readonly number[]; unknownPage: boolean; realm?: CustomOrderRealmRow }): SQL {
  const pages = input.pageIds === "all" ? sql`o.page_id is not null` : input.pageIds.length === 0 ? sql`false` : sql`o.page_id = any(${ids(input.pageIds)})`;
  const scope = input.unknownPage ? sql`(${pages} or o.page_id is null)` : pages;
  // The wall in the query itself: an order of no known page is the live agency's.
  if (input.realm === undefined) return scope;
  return sql`${scope} and ${input.realm === "test" ? testPageSql(sql`o.page_id`) : livePageSql(sql`o.page_id`)}`;
}

/**
 * The orders a board shows, of `pageIds` (all — every page), with or without the orders of no known page, of `realm`;
 * the oldest step first. `live` — the open ones alone, and the given ones that still burn (the facts screen); else the
 * open ones and the given and closed since `doneSince`.
 */
export async function listCustomOrders(
  db: Database,
  input: { pageIds: "all" | readonly number[]; unknownPage: boolean; realm?: CustomOrderRealmRow; doneSince: Date; live?: boolean; limit: number },
): Promise<CustomOrderRow[]> {
  const states = input.live === true
    ? sql`(o.state not in ('given', 'closed', 'cancelled') or ${GIVEN_STANDS})`
    : sql`(o.state not in ('given', 'closed', 'cancelled')
        or (o.state in ('given', 'closed') and coalesce(o.given_at, o.state_at) >= ${input.doneSince.toISOString()}::timestamptz))`;
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where ${boardScope(input)} and ${states}
    order by o.state_at asc, o.id asc
    limit ${input.limit}`);
  return result.rows.map(orderOf);
}

/**
 * «Отдано, ждём слово фана» and «Закрыто за месяц» of a board: the given orders (not closed yet, whatever their age) that
 * nothing stands against (those burn with the live ones), and the closed since `closedSince`, the newest step first.
 */
export async function listCustomOrdersDone(
  db: Database,
  input: { pageIds: "all" | readonly number[]; unknownPage: boolean; realm: CustomOrderRealmRow; closedSince: Date; limit: number },
): Promise<CustomOrderRow[]> {
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where ${boardScope(input)}
      and ((o.state = 'given' and not ${GIVEN_STANDS}) or (o.state = 'closed' and o.state_at >= ${input.closedSince.toISOString()}::timestamptz))
    order by o.state_at desc, o.id desc
    limit ${input.limit}`);
  return result.rows.map(orderOf);
}

/** How many of a board's orders are given (not closed) and closed since `closedSince`. */
export async function countCustomOrdersDone(
  db: Database,
  input: { pageIds: "all" | readonly number[]; unknownPage: boolean; realm: CustomOrderRealmRow; closedSince: Date },
): Promise<{ given: number; closed: number }> {
  const result = await db.execute<{ given: unknown; closed: unknown }>(sql`
    select count(*) filter (where o.state = 'given' and not ${GIVEN_STANDS}) as given,
      count(*) filter (where o.state = 'closed' and o.state_at >= ${input.closedSince.toISOString()}::timestamptz) as closed
    from custom_orders o
    where ${boardScope(input)} and o.state in ('given', 'closed')`);
  return { given: Number(result.rows[0]?.given ?? 0), closed: Number(result.rows[0]?.closed ?? 0) };
}

/** Orders by their ids (the self-changes' orders), in no order. */
export async function listCustomOrdersByIds(db: Database, orderIds: readonly number[]): Promise<CustomOrderRow[]> {
  if (orderIds.length === 0) return [];
  const result = await db.execute<Row>(sql`${ORDER_SELECT} where o.id = any(${ids(orderIds)})`);
  return result.rows.map(orderOf);
}

/** A step of an order taken through the system's or an agent's door (customs facts spec §10). */
export interface CustomOrderSelfChangeRow {
  id: number;
  orderId: number;
  event: string;
  door: string;
  actorAgentKeyId: number | null;
  changes: Record<string, unknown>;
  at: Date;
  /**
   * A sale's link or a delivery: whether its evidence is still on the order (the sale linked, the delivery not taken
   * back); null — another step.
   */
  applied: boolean | null;
}

/**
 * The steps of the system's and the agents' doors since `since` on the orders of `realm` and of the viewer's pages (the
 * board's scope, before the limit), from the orders changed since then (every step bumps the order), the newest first.
 */
export async function listCustomOrderSelfChanges(
  db: Database,
  input: { since: Date; realm: CustomOrderRealmRow; pageIds: "all" | readonly number[]; unknownPage: boolean; limit: number },
): Promise<CustomOrderSelfChangeRow[]> {
  const since = input.since.toISOString();
  const result = await db.execute<Row>(sql`
    select e.id, o.id as order_id, e.event, e.door, e.actor_agent_key_id, e.changes, e.created_at,
      case
        when e.event in ('custom_order.payment', 'custom_order.recorded') and (e.changes ->> 'transactionId') is not null
          then exists (select 1 from custom_order_payments cp where cp.order_id = o.id and cp.transaction_id::text = e.changes ->> 'transactionId')
        when e.event = 'custom_order.delivery'
          then exists (select 1 from custom_order_messages m where m.order_id = o.id and m.kind = 'delivery' and m.retracted_at is null
            and (case when (e.changes ->> 'eventRef') is not null then m.event_ref = e.changes ->> 'eventRef' else m.telegram_ref = e.changes ->> 'telegramRef' end))
        else null
      end as applied
    from custom_orders o
    join object_events e on e.object_type = 'custom_order' and e.object_id = o.id::text
    where o.updated_at >= ${since}::timestamptz and e.created_at >= ${since}::timestamptz and e.door in ('system', 'api')
      and ${boardScope(input)}
    order by e.id desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    orderId: Number(row.order_id),
    event: String(row.event),
    door: String(row.door),
    actorAgentKeyId: num(row.actor_agent_key_id),
    changes: (row.changes as Record<string, unknown> | null) ?? {},
    at: date(row.created_at)!,
    applied: row.applied === null || row.applied === undefined ? null : row.applied === true,
  }));
}

/** The orders of these fans (a person's accounts): open ones, and the ended within `recentDays`; open first, newest first. */
export async function listCustomOrdersOfFans(
  db: Database,
  input: { fanIds: readonly number[]; now: Date; recentDays: number },
): Promise<CustomOrderRow[]> {
  if (input.fanIds.length === 0) return [];
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where o.fan_id = any(${ids(input.fanIds)})
      and (o.state not in ('given', 'closed', 'cancelled', 'refused')
        or o.updated_at > ${input.now.toISOString()}::timestamptz - make_interval(days => ${input.recentDays}))
    order by (o.state not in ('given', 'closed', 'cancelled', 'refused')) desc, o.created_at desc`);
  return result.rows.map(orderOf);
}

/** A page's orders in work (not given, not ended, not refused), the oldest payment first: the extension's «Передача». */
export async function listPageCustomOrdersInWork(db: Database, input: { pageId: number; limit: number }): Promise<CustomOrderRow[]> {
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where o.page_id = ${input.pageId} and o.state not in ('given', 'closed', 'cancelled', 'refused')
    order by pay.first_at asc nulls last, o.created_at asc
    limit ${input.limit}`);
  return result.rows.map(orderOf);
}

/**
 * The orders that wait to be given to the fan: paid (a payment, or the state) or shot, and not given — what
 * «Кастомы оплачены, не отданы» counts. The oldest payment first.
 */
export async function listCustomOrdersAwaitingGiving(db: Database, input: { pageIds: "all" | readonly number[]; limit: number }): Promise<CustomOrderRow[]> {
  // "all": every order of the live agency (0414: the test realm's orders only to whoever names its pages).
  const pages = input.pageIds === "all" ? livePageSql(sql`o.page_id`) : input.pageIds.length === 0 ? sql`false` : sql`o.page_id = any(${ids(input.pageIds)})`;
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where ${pages} and o.state in ('paid', 'checked', 'at_model', 'partly', 'shot', 'revision')
      and (o.state in ('paid', 'shot') or coalesce(pay.n, 0) > 0)
    order by coalesce(pay.first_at, o.state_at) asc, o.id asc
    limit ${input.limit}`);
  return result.rows.map(orderOf);
}

/** Every order in a state of `states`: what the checks read. */
export async function listCustomOrdersInStates(db: Database, states: readonly CustomOrderStateRow[]): Promise<CustomOrderRow[]> {
  if (states.length === 0) return [];
  const result = await db.execute<Row>(sql`${ORDER_SELECT} where o.state = any(${texts(states)}) order by o.id`);
  return result.rows.map(orderOf);
}

/**
 * Orders by agent filters: open, live (open and the given ones not closed yet) or every state, of `pageIds` and — with
 * `noPage` — of no known page (the live agency's: never to a test key, 0414).
 */
export async function listAgentCustomOrders(
  db: Database,
  input: { pageIds: readonly number[]; noPage: boolean; open: boolean; live?: boolean; orderId?: number | null; telegramRef?: string | null; limit: number },
): Promise<CustomOrderRow[]> {
  const parts: SQL[] = [input.noPage
    ? sql`(o.page_id is null or o.page_id = any(${ids(input.pageIds)}))`
    : sql`o.page_id = any(${ids(input.pageIds)})`];
  if (input.open) parts.push(sql`o.state not in ('given', 'closed', 'cancelled')`);
  else if (input.live === true) parts.push(sql`o.state not in ('closed', 'cancelled')`);
  if (input.orderId) parts.push(sql`o.id = ${input.orderId}`);
  if (input.telegramRef) parts.push(sql`exists (select 1 from custom_order_cards c where c.order_id = o.id and c.telegram_ref = ${input.telegramRef})`);
  const result = await db.execute<Row>(sql`${ORDER_SELECT} where ${sql.join(parts, sql` and `)} order by o.id desc limit ${input.limit}`);
  return result.rows.map(orderOf);
}

export async function findCustomOrder(db: Database, orderId: number): Promise<CustomOrderRow | null> {
  const result = await db.execute<Row>(sql`${ORDER_SELECT} where o.id = ${orderId}`);
  return result.rows[0] ? orderOf(result.rows[0]) : null;
}

/** Takes the order's row lock for the rest of the transaction; false — no such order. */
export async function lockCustomOrder(db: Database, orderId: number): Promise<boolean> {
  const result = await db.execute<{ id: unknown }>(sql`select id from custom_orders where id = ${orderId} for update`);
  return result.rows.length > 0;
}

/** The order a Telegram card belongs to. */
export async function findCustomOrderIdByCard(db: Database, telegramRef: string): Promise<number | null> {
  const result = await db.execute<{ order_id: unknown }>(sql`select order_id from custom_order_cards where telegram_ref = ${telegramRef}`);
  return num(result.rows[0]?.order_id);
}

/** Which of `refs` belong to an order, and to which. */
export async function listCustomOrderCardOwners(db: Database, refs: readonly string[]): Promise<Map<string, number>> {
  if (refs.length === 0) return new Map();
  const result = await db.execute<{ telegram_ref: string; order_id: unknown }>(sql`
    select telegram_ref, order_id from custom_order_cards where telegram_ref = any(${texts(refs)})`);
  return new Map(result.rows.map((row) => [row.telegram_ref, Number(row.order_id)]));
}

export async function findCustomOrderIdByContentops(db: Database, contentopsRef: string): Promise<number | null> {
  const result = await db.execute<{ id: unknown }>(sql`select id from custom_orders where contentops_ref = ${contentopsRef}`);
  return num(result.rows[0]?.id);
}

/**
 * One create of an order at a time per fan of a page (the fan, or — none confirmed — the buyer's string): the rest of
 * the transaction holds it, so a second create waits and then reads the first one's order among the open ones.
 */
export async function lockCustomOrderCreate(db: Database, input: { pageId: number; fanId: number | null; buyer: string | null }): Promise<void> {
  const who = input.fanId !== null ? `fan:${input.fanId}` : `buyer:${(input.buyer ?? "").toLowerCase()}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`custom_order_create:${input.pageId}:${who}`}, 0))`);
}

/** The fan's open orders on the page (the fan, or — none confirmed — the same buyer's string), the oldest first. */
export async function listOpenCustomOrdersOfFan(
  db: Database,
  input: { pageId: number; fanId: number | null; buyer: string | null },
): Promise<Array<{ id: number; state: CustomOrderStateRow; createdAt: Date }>> {
  const who = input.fanId !== null ? sql`fan_id = ${input.fanId}` : input.buyer !== null ? sql`fan_id is null and lower(buyer) = lower(${input.buyer})` : null;
  if (who === null) return [];
  const result = await db.execute<Row>(sql`
    select id, state, created_at from custom_orders
    where page_id = ${input.pageId} and ${who} and state not in ('given', 'closed', 'cancelled')
    order by created_at, id limit 20`);
  return result.rows.map((row) => ({ id: Number(row.id), state: row.state as CustomOrderStateRow, createdAt: date(row.created_at)! }));
}

/**
 * An earlier import's order that nothing but its page and fan names (no Telegram card, no ContentOps order): the
 * board's «нет карточки» brought in once, found again by the same page and fan (or buyer's string).
 */
export async function findImportedCustomOrderWithoutCard(
  db: Database,
  input: { pageId: number | null; fanId: number | null; buyer: string | null },
): Promise<number | null> {
  const who = input.fanId !== null ? sql`o.fan_id = ${input.fanId}` : input.buyer !== null ? sql`o.fan_id is null and lower(o.buyer) = lower(${input.buyer})` : sql`o.fan_id is null and o.buyer is null`;
  const page = input.pageId === null ? sql`o.page_id is null` : sql`o.page_id = ${input.pageId}`;
  const result = await db.execute<{ id: unknown }>(sql`
    select o.id from custom_orders o
    where o.origin = 'import' and o.contentops_ref is null and ${page} and ${who}
      and not exists (select 1 from custom_order_cards c where c.order_id = o.id)
    order by o.id limit 1`);
  return num(result.rows[0]?.id);
}

export interface NewCustomOrderRow {
  pageId: number | null;
  fanId: number | null;
  buyer: string | null;
  conversationRef: string | null;
  card: Record<string, unknown>;
  deadlineOn: string | null;
  state: CustomOrderStateRow;
  acceptedByUserId: number | null;
  origin: CustomOrderOriginRow;
  contentopsRef: string | null;
  sourceText: string | null;
  /** 0436: the agreed total, gross; a wait on purpose. */
  priceMills?: number | null;
  holdReason?: string | null;
  /** The fields a person gave at the record (their price): an agent's later edit of one of them is refused. */
  personFields?: readonly string[];
  at: Date;
}

export async function insertCustomOrder(db: Database, input: NewCustomOrderRow): Promise<number> {
  const at = input.at.toISOString();
  const result = await db.execute<{ id: unknown }>(sql`
    insert into custom_orders (page_id, fan_id, buyer, conversation_ref, card, deadline_on, state, state_at, accepted_by_user_id,
      origin, contentops_ref, source_text, price_mills, hold_reason, person_fields, created_at, updated_at)
    values (${input.pageId}, ${input.fanId}, ${input.buyer}, ${input.conversationRef}, ${JSON.stringify(input.card)}::jsonb,
      ${input.deadlineOn}::date, ${input.state}, ${at}::timestamptz, ${input.acceptedByUserId}, ${input.origin},
      ${input.contentopsRef}, ${input.sourceText}, ${input.priceMills ?? null}, ${input.holdReason ?? null}, ${texts(input.personFields ?? [])},
      ${at}::timestamptz, ${at}::timestamptz)
    returning id`);
  return Number(result.rows[0]!.id);
}

export interface CustomOrderFieldsPatch {
  card?: Record<string, unknown>;
  deadlineOn?: string | null;
  pageId?: number | null;
  fanId?: number | null;
  buyer?: string | null;
  conversationRef?: string | null;
  sourceText?: string | null;
  partsDone?: readonly string[];
  shotByHandAt?: Date;
  personFields?: readonly string[];
  /** 0436: the agreed price, the deadline's «примерно», the owner's word, a hold, an issue, the fan's «where is it». */
  priceMills?: number | null;
  deadlineDefault?: boolean;
  paidWord?: Record<string, unknown> | null;
  holdReason?: string | null;
  issue?: Record<string, unknown> | null;
  fanAsked?: { at: Date; ref: string } | null;
  /** «Отправлен, фан не открыл» taken off (a revision of an order that stays in it). */
  sentCleared?: true;
}

/** The order's fields (not its state). */
export async function updateCustomOrderFields(db: Database, orderId: number, patch: CustomOrderFieldsPatch, at: Date): Promise<void> {
  const sets: SQL[] = [sql`updated_at = ${at.toISOString()}::timestamptz`];
  const json = (value: Record<string, unknown> | null) => (value === null ? sql`null` : sql`${JSON.stringify(value)}::jsonb`);
  if (patch.priceMills !== undefined) sets.push(sql`price_mills = ${patch.priceMills}`);
  if (patch.deadlineDefault !== undefined) sets.push(sql`deadline_default = ${patch.deadlineDefault}`);
  if (patch.paidWord !== undefined) sets.push(sql`paid_word = ${json(patch.paidWord)}`);
  if (patch.holdReason !== undefined) sets.push(sql`hold_reason = ${patch.holdReason}`);
  if (patch.issue !== undefined) sets.push(sql`issue = ${json(patch.issue)}`);
  if (patch.fanAsked !== undefined) {
    sets.push(sql`fan_asked_at = ${patch.fanAsked?.at.toISOString() ?? null}::timestamptz, fan_asked_ref = ${patch.fanAsked?.ref ?? null}`);
  }
  if (patch.sentCleared === true) sets.push(sql`sent_at = null, sent_message_ref = null`);
  if (patch.card !== undefined) sets.push(sql`card = ${JSON.stringify(patch.card)}::jsonb`);
  if (patch.deadlineOn !== undefined) sets.push(sql`deadline_on = ${patch.deadlineOn}::date`);
  if (patch.pageId !== undefined) sets.push(sql`page_id = ${patch.pageId}`);
  if (patch.fanId !== undefined) sets.push(sql`fan_id = ${patch.fanId}`);
  if (patch.buyer !== undefined) sets.push(sql`buyer = ${patch.buyer}`);
  if (patch.conversationRef !== undefined) sets.push(sql`conversation_ref = ${patch.conversationRef}`);
  if (patch.sourceText !== undefined) sets.push(sql`source_text = ${patch.sourceText}`);
  if (patch.partsDone !== undefined) sets.push(sql`parts_done = ${texts(patch.partsDone)}`);
  if (patch.shotByHandAt !== undefined) sets.push(sql`shot_by_hand_at = ${patch.shotByHandAt.toISOString()}::timestamptz`);
  if (patch.personFields !== undefined) sets.push(sql`person_fields = ${texts(patch.personFields)}`);
  await db.execute(sql`update custom_orders set ${sql.join(sets, sql`, `)} where id = ${orderId}`);
}

/**
 * The order's new state, when it is in one of `from` now. Answers whether it moved. A state keeps its note and
 * the model's message; «отдали» its platform message.
 */
export async function moveCustomOrder(
  db: Database,
  input: {
    orderId: number;
    from: readonly CustomOrderStateRow[];
    to: CustomOrderStateRow;
    note?: string | null;
    ref?: string | null;
    /** `messageRef` null — given by a person's word, no message named. */
    given?: { messageRef: string | null; at: Date };
    /**
     * What the move takes off the order (0436): «отдан» (taken back, or a revision of a given order), «отправлен, фан не
     * открыл» (given, or a revision), the fan's «where is it» (given).
     */
    clear?: { given?: boolean; sent?: boolean; fanAsked?: boolean };
    at: Date;
  },
): Promise<boolean> {
  const at = input.at.toISOString();
  const given = input.given === undefined ? sql`` : sql`, given_message_ref = ${input.given.messageRef}, given_at = ${input.given.at.toISOString()}::timestamptz`;
  const clears: SQL[] = [
    ...(input.clear?.given === true && input.given === undefined ? [sql`, given_message_ref = null, given_at = null`] : []),
    ...(input.clear?.sent === true ? [sql`, sent_at = null, sent_message_ref = null`] : []),
    ...(input.clear?.fanAsked === true ? [sql`, fan_asked_at = null, fan_asked_ref = null`] : []),
  ];
  const result = await db.execute(sql`
    update custom_orders set state = ${input.to}, state_at = ${at}::timestamptz, state_note = ${input.note ?? null},
      state_ref = ${input.ref ?? null}, updated_at = ${at}::timestamptz ${given} ${clears.length === 0 ? sql`` : sql.join(clears, sql` `)}
    where id = ${input.orderId} and state = any(${texts(input.from)})`);
  return (result.rowCount ?? 0) > 0;
}

/** One more version of the order: every step that changed something calls it once. */
export async function bumpCustomOrder(db: Database, orderId: number, at: Date): Promise<void> {
  await db.execute(sql`update custom_orders set version = version + 1, updated_at = ${at.toISOString()}::timestamptz where id = ${orderId}`);
}

/** A sale pays the order; false — another order holds it already (or this one). */
export async function addCustomOrderPayment(db: Database, input: { orderId: number; transactionId: number; userId: number | null; at: Date }): Promise<boolean> {
  const result = await db.execute(sql`
    insert into custom_order_payments (transaction_id, order_id, added_by_user_id, added_at)
    values (${input.transactionId}, ${input.orderId}, ${input.userId}, ${input.at.toISOString()}::timestamptz)
    on conflict (transaction_id) do nothing`);
  return (result.rowCount ?? 0) > 0;
}

export async function removeCustomOrderPayment(db: Database, input: { orderId: number; transactionId: number }): Promise<boolean> {
  const result = await db.execute(sql`delete from custom_order_payments where order_id = ${input.orderId} and transaction_id = ${input.transactionId}`);
  return (result.rowCount ?? 0) > 0;
}

/** A Telegram card is the order's; false — it belongs to an order already (this one or another). */
export async function addCustomOrderCard(
  db: Database,
  input: { orderId: number; telegramRef: string; at: Date; postedAt?: Date | null; author?: string | null },
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into custom_order_cards (telegram_ref, order_id, posted_at, author, added_at)
    values (${input.telegramRef}, ${input.orderId}, ${input.postedAt?.toISOString() ?? null}::timestamptz, ${input.author ?? null},
      ${input.at.toISOString()}::timestamptz)
    on conflict (telegram_ref) do nothing`);
  return (result.rowCount ?? 0) > 0;
}

export type CustomOrderMessageKindRow = "repost" | "delivery" | "revision" | "confirmation" | "note";

export interface CustomOrderMessageRow {
  /** The Telegram message: the row's identity, or the evidence of an event named by `eventRef`; null — none. */
  telegramRef: string | null;
  /** The sender's own id of the event (0406: ContentOps' delivery or retraction); null — a Telegram message. */
  eventRef: string | null;
  ordinal: number;
  kind: CustomOrderMessageKindRow;
  /** A delivery: its part. A revision request: the part it is about; null — the whole order. */
  part: "video" | "photos" | null;
  /** A delivery: that part whole; null — not said (recorded before 0406). */
  complete: boolean | null;
  postedAt: Date | null;
  author: string | null;
  excerpt: string | null;
  doneAt: Date | null;
  /** A delivery taken back: its part no longer counts. */
  retractedAt: Date | null;
}

/**
 * What became of a message given to the order: `stored`; `already` — the same message (its link and ordinal, or its
 * event ref) of the same kind is the order's; `taken` — that identity holds another kind of message: nothing kept.
 */
export type CustomOrderMessageResult = "stored" | "already" | "taken";

/**
 * A message of the order. With `eventRef` the event is known by it (the link, if any, only its evidence): unique
 * per order. Without it the Telegram link and ordinal are the identity, as the readers of the groups give them.
 */
export async function addCustomOrderMessage(
  db: Database,
  input: { orderId: number; telegramRef: string | null; eventRef?: string | null; ordinal: number; kind: CustomOrderMessageKindRow;
    part: "video" | "photos" | null; complete?: boolean | null; postedAt: Date | null; author: string | null; excerpt: string | null; at: Date },
): Promise<CustomOrderMessageResult> {
  const eventRef = input.eventRef ?? null;
  if (eventRef === null && input.telegramRef === null) throw new Error("A message of an order is known by its Telegram link or its event ref");
  const values = sql`(${input.orderId}, ${eventRef === null ? input.telegramRef : null}, ${eventRef}, ${eventRef === null ? null : input.telegramRef},
    ${input.ordinal}, ${input.kind}, ${input.part}, ${input.complete ?? null}::boolean, ${input.postedAt?.toISOString() ?? null}::timestamptz,
    ${input.author}, ${input.excerpt}, ${input.at.toISOString()}::timestamptz)`;
  const result = await db.execute(eventRef === null
    ? sql`
      insert into custom_order_messages (order_id, telegram_ref, event_ref, evidence_ref, ordinal, kind, part, complete, posted_at, author, excerpt, added_at)
      values ${values} on conflict (order_id, telegram_ref, ordinal) do nothing`
    : sql`
      insert into custom_order_messages (order_id, telegram_ref, event_ref, evidence_ref, ordinal, kind, part, complete, posted_at, author, excerpt, added_at)
      values ${values} on conflict (order_id, event_ref) where event_ref is not null do nothing`);
  if ((result.rowCount ?? 0) > 0) return "stored";
  const existing = await db.execute<Row>(eventRef === null
    ? sql`select kind from custom_order_messages where order_id = ${input.orderId} and telegram_ref = ${input.telegramRef} and ordinal = ${input.ordinal}`
    : sql`select kind from custom_order_messages where order_id = ${input.orderId} and event_ref = ${eventRef}`);
  return existing.rows[0]?.kind === input.kind ? "already" : "taken";
}

/** A revision request fixed by a word (it stays fixed); false — none open by that message (or event ref) and ordinal. */
export async function markCustomOrderRevisionDone(
  db: Database,
  input: { orderId: number; telegramRef: string | null; eventRef?: string | null; ordinal: number; at: Date },
): Promise<boolean> {
  const by = input.eventRef ? sql`event_ref = ${input.eventRef}` : sql`telegram_ref = ${input.telegramRef} and ordinal = ${input.ordinal}`;
  const result = await db.execute(sql`
    update custom_order_messages set done_at = ${input.at.toISOString()}::timestamptz
    where order_id = ${input.orderId} and ${by} and kind = 'revision' and done_at is null`);
  return (result.rowCount ?? 0) > 0;
}

/** Every open revision request of the order fixed by a word («снят»): how many. Such a request stays fixed. */
export async function closeCustomOrderRevisions(db: Database, input: { orderId: number; at: Date }): Promise<number> {
  const result = await db.execute(sql`
    update custom_order_messages set done_at = ${input.at.toISOString()}::timestamptz
    where order_id = ${input.orderId} and kind = 'revision' and done_at is null`);
  return result.rowCount ?? 0;
}

/** These open revision requests fixed by the round itself: every part they are about came whole after them. */
export async function answerCustomOrderRevisions(db: Database, input: { orderId: number; ids: readonly number[]; at: Date }): Promise<number> {
  if (input.ids.length === 0) return 0;
  const result = await db.execute(sql`
    update custom_order_messages set done_at = ${input.at.toISOString()}::timestamptz, done_by_delivery = true
    where order_id = ${input.orderId} and id = any(${ids(input.ids)}) and kind = 'revision' and done_at is null`);
  return result.rowCount ?? 0;
}

/** These requests open again: the delivery that had answered them was taken back. Never one fixed by a word. */
export async function reopenCustomOrderRevisions(db: Database, input: { orderId: number; ids: readonly number[] }): Promise<number> {
  if (input.ids.length === 0) return 0;
  const result = await db.execute(sql`
    update custom_order_messages set done_at = null, done_by_delivery = false
    where order_id = ${input.orderId} and id = any(${ids(input.ids)}) and kind = 'revision' and done_by_delivery`);
  return result.rowCount ?? 0;
}

/**
 * The deliveries of the order named by an event ref, or by a Telegram link (every delivery of that message, its
 * own or as evidence), taken back: `matched` — how many the ref names at all, `retracted` — the ones taken back now.
 */
export async function retractCustomOrderDeliveries(
  db: Database,
  input: { orderId: number; eventRef: string } | { orderId: number; telegramRef: string },
  at: Date,
): Promise<{ matched: number; retracted: Array<{ part: "video" | "photos" | null; complete: boolean | null }> }> {
  const by = "eventRef" in input ? sql`event_ref = ${input.eventRef}` : sql`(telegram_ref = ${input.telegramRef} or evidence_ref = ${input.telegramRef})`;
  const matched = await db.execute<Row>(sql`
    select count(*)::int as n from custom_order_messages where order_id = ${input.orderId} and kind = 'delivery' and ${by}`);
  const result = await db.execute<Row>(sql`
    update custom_order_messages set retracted_at = ${at.toISOString()}::timestamptz
    where order_id = ${input.orderId} and kind = 'delivery' and retracted_at is null and ${by}
    returning part, complete`);
  return {
    matched: Number(matched.rows[0]?.n ?? 0),
    retracted: result.rows.map((row) => ({ part: (row.part as "video" | "photos" | null) ?? null, complete: (row.complete as boolean | null) ?? null })),
  };
}

/** A delivery or a revision request of an order, as its round reads it (services/custom-orders/rules.ts, `roundOf`). */
export interface CustomOrderRoundRow {
  id: number;
  kind: "delivery" | "revision";
  /** A delivery: its part. A request: the part it is about; null — the whole order. */
  part: "video" | "photos" | null;
  /** The message's own time; when its sender gave none, when the hub kept it. */
  at: Date;
  complete: boolean | null;
  retracted: boolean;
  done: boolean;
  /** A request the round itself fixed (0410); false — fixed by a word, or open. */
  doneByDelivery: boolean;
  /** The Telegram message (its own link, or an event's evidence) and its words: what the state «правка» names. */
  telegramRef: string | null;
  excerpt: string | null;
}

/** Every delivery and revision request of the order, the oldest first (by its own time, then as the hub kept them). */
export async function listCustomOrderRoundMessages(db: Database, orderId: number): Promise<CustomOrderRoundRow[]> {
  const result = await db.execute<Row>(sql`
    select id, kind, part, coalesce(posted_at, added_at) as at, complete, retracted_at, done_at, done_by_delivery,
      coalesce(telegram_ref, evidence_ref) as telegram_ref, excerpt
    from custom_order_messages
    where order_id = ${orderId} and kind in ('delivery', 'revision')
    order by coalesce(posted_at, added_at), id`);
  return result.rows.map((row) => ({
    id: Number(row.id),
    kind: row.kind as "delivery" | "revision",
    part: (row.part as "video" | "photos" | null) ?? null,
    at: date(row.at)!,
    complete: (row.complete as boolean | null) ?? null,
    retracted: row.retracted_at !== null && row.retracted_at !== undefined,
    done: row.done_at !== null && row.done_at !== undefined,
    doneByDelivery: row.done_by_delivery === true,
    telegramRef: (row.telegram_ref as string | null) ?? null,
    excerpt: (row.excerpt as string | null) ?? null,
  }));
}

/** What the order's state is about, while the state itself stays: «правка» follows the requests still open. */
export async function setCustomOrderStateNote(db: Database, orderId: number, input: { note: string | null; ref: string | null }, at: Date): Promise<void> {
  await db.execute(sql`
    update custom_orders set state_note = ${input.note}, state_ref = ${input.ref}, updated_at = ${at.toISOString()}::timestamptz
    where id = ${orderId}`);
}

/** The messages of these orders, each order's in their order. */
export async function listCustomOrderMessagesOf(db: Database, orderIds: readonly number[]): Promise<Map<number, CustomOrderMessageRow[]>> {
  const byOrder = new Map<number, CustomOrderMessageRow[]>();
  if (orderIds.length === 0) return byOrder;
  const result = await db.execute<Row>(sql`
    select order_id, coalesce(telegram_ref, evidence_ref) as telegram_ref, event_ref, ordinal, kind, part, complete, posted_at, author, excerpt,
      done_at, retracted_at
    from custom_order_messages
    where order_id = any(${ids(orderIds)}) order by order_id, coalesce(posted_at, added_at), id`);
  for (const row of result.rows) {
    const list = byOrder.get(Number(row.order_id)) ?? [];
    list.push({
      telegramRef: (row.telegram_ref as string | null) ?? null,
      eventRef: (row.event_ref as string | null) ?? null,
      ordinal: Number(row.ordinal),
      kind: row.kind as CustomOrderMessageKindRow,
      part: (row.part as "video" | "photos" | null) ?? null,
      complete: (row.complete as boolean | null) ?? null,
      postedAt: date(row.posted_at),
      author: (row.author as string | null) ?? null,
      excerpt: (row.excerpt as string | null) ?? null,
      doneAt: date(row.done_at),
      retractedAt: date(row.retracted_at),
    });
    byOrder.set(Number(row.order_id), list);
  }
  return byOrder;
}

export async function listCustomOrderMessages(db: Database, orderId: number): Promise<CustomOrderMessageRow[]> {
  return (await listCustomOrderMessagesOf(db, [orderId])).get(orderId) ?? [];
}

export interface CustomOrderSaleRow {
  transactionId: number;
  /** The sale's page; null — not read (an order's own payments). */
  pageId: number | null;
  kind: string;
  grossMills: number;
  netMills: number;
  at: Date;
  note: string | null;
}

const NOTE_OF = sql`case when t.canonical_type = 'tip' then coalesce(
    (select tc.tip_message_text from transaction_tip_contexts tc
      where tc.account_id = t.platform_account_id and tc.platform_tip_id = t.correlation_id limit 1),
    (select ma.tip_text_plain from message_archive ma
      where ma.account_id = t.platform_account_id and ma.is_tip and ma.tip_text_plain is not null
        and ma.fan_native_id = f.platform_user_id and ma.occurred_at between t.occurred_at - interval '5 minutes' and t.occurred_at + interval '5 minutes'
      limit 1)) end`;

const saleOf = (row: Row): CustomOrderSaleRow => ({
  transactionId: Number(row.id),
  pageId: num(row.page_id),
  kind: String(row.canonical_type),
  grossMills: Number(row.gross_amount_mills ?? 0),
  netMills: Number(row.creator_net_amount_mills ?? 0),
  at: date(row.occurred_at)!,
  note: (row.note as string | null) ?? null,
});

/** The sales that pay the order, the oldest first. */
export async function listCustomOrderPayments(db: Database, orderId: number): Promise<CustomOrderSaleRow[]> {
  const result = await db.execute<Row>(sql`
    select cp.transaction_id as id, coalesce(t.canonical_type::text, 'unknown') as canonical_type, t.gross_amount_mills, t.creator_net_amount_mills,
      coalesce(t.occurred_at, cp.added_at) as occurred_at, ${NOTE_OF} as note
    from custom_order_payments cp
    left join transactions t on t.id = cp.transaction_id
    left join fans f on f.id = t.fan_id
    where cp.order_id = ${orderId}
    order by coalesce(t.occurred_at, cp.added_at), cp.transaction_id`);
  return result.rows.map(saleOf);
}

/**
 * The fan's sales on the page (or on `pageIds`) in the last `days` (or since `since`) that no order holds, of `kinds`,
 * the newest first: «Это оплата?». `notRejectedFor` — and none a person took off that order (0436).
 */
export async function listCustomPaymentCandidates(
  db: Database,
  input: {
    pageId?: number; pageIds?: readonly number[]; fanIds: readonly number[]; kinds: readonly string[]; now: Date; days: number;
    since?: Date; notRejectedFor?: number; limit: number;
  },
): Promise<CustomOrderSaleRow[]> {
  const pageIds = input.pageIds ?? (input.pageId === undefined ? [] : [input.pageId]);
  if (input.fanIds.length === 0 || pageIds.length === 0) return [];
  const since = input.since === undefined ? sql`` : sql`and t.occurred_at >= ${input.since.toISOString()}::timestamptz`;
  const rejected = input.notRejectedFor === undefined ? sql`` : sql`and not exists (
        select 1 from custom_order_rejections x where x.order_id = ${input.notRejectedFor} and x.kind = 'payment' and x.ref = t.id::text)`;
  const result = await db.execute<Row>(sql`
    select t.id, t.platform_account_id as page_id, t.canonical_type::text as canonical_type, t.gross_amount_mills, t.creator_net_amount_mills,
      t.occurred_at, ${NOTE_OF} as note
    from transactions t
    join fans f on f.id = t.fan_id
    where t.platform_account_id = any(${ids(pageIds)}) and t.fan_id = any(${ids(input.fanIds)})
      and t.canonical_type::text = any(${texts(input.kinds)}) and t.is_active and t.gross_amount_mills > 0
      and t.occurred_at > ${input.now.toISOString()}::timestamptz - make_interval(days => ${input.days})
      ${since}
      and not exists (select 1 from custom_order_payments cp where cp.transaction_id = t.id)
      ${rejected}
    order by t.occurred_at desc
    limit ${input.limit}`);
  return result.rows.map(saleOf);
}

/** One sale with its page and fan, for a record from it. */
export async function findCustomSale(
  db: Database,
  transactionId: number,
): Promise<{ transactionId: number; pageId: number; fanId: number | null; at: Date; grossMills: number } | null> {
  const result = await db.execute<Row>(sql`
    select id, platform_account_id, fan_id, occurred_at, gross_amount_mills from transactions where id = ${transactionId}`);
  const row = result.rows[0];
  return row
    ? { transactionId: Number(row.id), pageId: Number(row.platform_account_id), fanId: num(row.fan_id), at: date(row.occurred_at)!, grossMills: Number(row.gross_amount_mills ?? 0) }
    : null;
}

// ── What an agent names, and undo remembered (0436; customs facts spec §5, §6, §10) ──

/** What a named sale is checked by before it pays an order. */
export interface CustomSaleFactsRow {
  transactionId: number;
  pageId: number;
  fanId: number | null;
  /** The transaction's kind: tip | subscription | message_purchase | … */
  kind: string;
  /** Active and of money: a sale that counts. */
  live: boolean;
  /** The order that holds it; null — none. */
  heldBy: number | null;
  /** OnlyFans wrote its reversal or chargeback (a row retired as missing from a sync window is not one). */
  reversed: boolean;
  /** A person took it off this order (`custom_order_rejections`). */
  rejected: boolean;
}

export async function listCustomSaleFacts(
  db: Database,
  input: { orderId: number; transactionIds: readonly number[] },
): Promise<Map<number, CustomSaleFactsRow>> {
  if (input.transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select t.id, t.platform_account_id, t.fan_id, t.canonical_type::text as kind, t.is_active and t.gross_amount_mills > 0 as live,
      (select cp.order_id from custom_order_payments cp where cp.transaction_id = t.id) as held_by,
      exists (
        select 1 from transactions r
        where r.platform_account_id = t.platform_account_id
          and r.transaction_id in (t.transaction_id || ':reversal', t.transaction_id || ':chargeback')
          and r.inactive_reason is distinct from 'missing_from_sync_window') as reversed,
      exists (
        select 1 from custom_order_rejections x
        where x.order_id = ${input.orderId} and x.kind = 'payment' and x.ref = t.id::text) as rejected
    from transactions t
    where t.id = any(${ids(input.transactionIds)})`);
  return new Map(result.rows.map((row) => [Number(row.id), {
    transactionId: Number(row.id),
    pageId: Number(row.platform_account_id),
    fanId: num(row.fan_id),
    kind: String(row.kind),
    live: row.live === true,
    heldBy: num(row.held_by),
    reversed: row.reversed === true,
    rejected: row.rejected === true,
  }]));
}

/** A page's message as the agent's «отдан» and «where is it» are checked by. */
export interface CustomPageMessageRow {
  pageId: number;
  messageRef: string;
  at: Date | null;
  sentByPage: boolean;
  /** How many media it carries. */
  media: number;
  /** Its price: its own, or the dearest of its media offers (a Fansly PPV prices its offers, not the message); 0 — free. */
  priceMills: number;
  /**
   * The fan of the message's chat, from the chat itself (`page_dm_threads`; an OnlyFans chat is named by the fan's own
   * id), never from a media offer's recipient. Null — the chat names no fan Hub knows.
   */
  chatFanId: number | null;
  /** A priced message bought (`ppvBoughtSql`, the one rule). */
  bought: boolean;
}

/** One message by its platform id on one of `pageIds`, not deleted; null — none. */
export async function findCustomPageMessage(
  db: Database,
  input: { pageIds: readonly number[]; messageRef: string },
): Promise<CustomPageMessageRow | null> {
  if (input.pageIds.length === 0) return null;
  const result = await db.execute<Row>(sql`
    select m.account_id, m.message_ref, m.occurred_at, m.is_sent_by_me, jsonb_array_length(m.media_metadata) as media,
      greatest(coalesce(m.price_mills, 0), coalesce((
        select max(po.price_mills) from message_media_offers po where po.page_id = m.account_id and po.message_ref = m.message_ref), 0)) as price_mills,
      coalesce(
        (select th.fan_id from page_dm_threads th
          where th.platform_account_id = m.account_id and th.platform_conversation_id = m.conversation_ref and th.fan_id is not null
          order by th.id limit 1),
        (select f.id from fans f
          where m.platform = 'onlyfans' and f.platform = 'onlyfans' and f.platform_user_id = m.conversation_ref limit 1)) as chat_fan_id,
      ${ppvBoughtSql({ pageId: "m.account_id", platform: "m.platform", ref: "m.message_ref", conv: "m.conversation_ref", at: "m.occurred_at" })} as bought
    from message_archive m
    where m.account_id = any(${ids(input.pageIds)}) and m.message_ref = ${input.messageRef} and m.deleted_at is null
    order by m.occurred_at desc nulls last
    limit 1`);
  const row = result.rows[0];
  if (!row) return null;
  return {
    pageId: Number(row.account_id),
    messageRef: String(row.message_ref),
    at: date(row.occurred_at),
    sentByPage: row.is_sent_by_me === true,
    media: Number(row.media ?? 0),
    priceMills: Number(row.price_mills ?? 0),
    chatFanId: num(row.chat_fan_id),
    bought: row.bought === true,
  };
}

export type CustomRejectionKind = "payment" | "given";

/** A sale (`payment`) or a delivering message (`given`) the system or an agent applied and a person took off the order. */
export async function addCustomOrderRejection(
  db: Database,
  input: { orderId: number; kind: CustomRejectionKind; ref: string; userId: number | null; at: Date },
): Promise<void> {
  await db.execute(sql`
    insert into custom_order_rejections (order_id, kind, ref, rejected_by_user_id, rejected_at)
    values (${input.orderId}, ${input.kind}, ${input.ref}, ${input.userId}, ${input.at.toISOString()}::timestamptz)
    on conflict (order_id, kind, ref) do nothing`);
}

/** A person applied it to the order by hand again: the undo is not remembered any more. Whether there was one. */
export async function removeCustomOrderRejection(db: Database, input: { orderId: number; kind: CustomRejectionKind; ref: string }): Promise<boolean> {
  const result = await db.execute(sql`
    delete from custom_order_rejections where order_id = ${input.orderId} and kind = ${input.kind} and ref = ${input.ref}`);
  return (result.rowCount ?? 0) > 0;
}

export async function hasCustomOrderRejection(db: Database, input: { orderId: number; kind: CustomRejectionKind; ref: string }): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from custom_order_rejections where order_id = ${input.orderId} and kind = ${input.kind} and ref = ${input.ref}`);
  return result.rows.length > 0;
}

/**
 * The door of the newest step of the order's history that applied this evidence: a payment by the sale (or the record
 * that brought it), «отдан» by the message. Null — none.
 */
export async function findCustomOrderLinkDoor(db: Database, input: { orderId: number; kind: CustomRejectionKind; ref: string }): Promise<string | null> {
  const match = input.kind === "payment"
    ? sql`event in ('custom_order.payment', 'custom_order.recorded') and changes ->> 'transactionId' = ${input.ref}`
    : sql`event = 'custom_order.given' and changes ->> 'messageRef' = ${input.ref}`;
  const result = await db.execute<{ door: string }>(sql`
    select door from object_events
    where object_type = 'custom_order' and object_id = ${String(input.orderId)} and ${match}
    order by id desc limit 1`);
  return result.rows[0]?.door ?? null;
}

/** Whether `eventId` is a step of the order's history (a person's undo names the step it takes back). */
export async function isCustomOrderEvent(db: Database, input: { orderId: number; eventId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from object_events where id = ${input.eventId} and object_type = 'custom_order' and object_id = ${String(input.orderId)}`);
  return result.rows.length > 0;
}

/**
 * Whether the order's standing issue was set by this agent: the newest «источники расходятся» of its history came through
 * this key, or another key of the same agent (`person_agent_keys`: a key's replacement is the same agent).
 */
export async function isCustomOrderIssueOfAgent(db: Database, input: { orderId: number; agentKeyId: number }): Promise<boolean> {
  const result = await db.execute<{ same: boolean }>(sql`
    select e.actor_agent_key_id is not null and (e.actor_agent_key_id = ${input.agentKeyId} or exists (
      select 1 from person_agent_keys a join person_agent_keys b on b.person_id = a.person_id
      where a.agent_key_id = e.actor_agent_key_id and b.agent_key_id = ${input.agentKeyId})) as same
    from object_events e
    where e.object_type = 'custom_order' and e.object_id = ${String(input.orderId)} and e.event = 'custom_order.issue'
    order by e.id desc limit 1`);
  return result.rows[0]?.same === true;
}

/**
 * Whose the evidence an order holds is: each sale that pays it (its fan and its page's model), and — given by a page's
 * message — that message's chat fan and model; and the model of `pageId` (a page the order may be moved to). A fan
 * changed on the order must be these fans' person, on that model.
 */
export async function listCustomOrderEvidenceOwners(
  db: Database,
  input: { orderId: number; pageId: number },
): Promise<{ owners: Array<{ kind: "payment" | "given"; fanId: number | null; modelId: number | null }>; modelId: number | null }> {
  const result = await db.execute<Row>(sql`
    select 'payment' as kind, t.fan_id, p.model_id from custom_order_payments cp
    join transactions t on t.id = cp.transaction_id
    left join pages p on p.id = t.platform_account_id
    where cp.order_id = ${input.orderId}
    union all
    select 'given', coalesce(th.fan_id, ofan.id), p.model_id from custom_orders o
    join pages op on op.id = o.page_id
    join pages p on p.model_id = op.model_id
    join message_archive m on m.account_id = p.id and m.platform = p.platform and m.message_ref = o.given_message_ref
    left join page_dm_threads th on th.platform_account_id = m.account_id and th.platform_conversation_id = m.conversation_ref
    left join fans ofan on m.platform = 'onlyfans' and ofan.platform = 'onlyfans' and ofan.platform_user_id = m.conversation_ref
    where o.id = ${input.orderId} and o.given_message_ref is not null`);
  const model = await db.execute<Row>(sql`select model_id from pages where id = ${input.pageId}`);
  return {
    owners: result.rows.map((row) => ({ kind: row.kind === "given" ? "given" as const : "payment" as const, fanId: num(row.fan_id), modelId: num(row.model_id) })),
    modelId: num(model.rows[0]?.model_id),
  };
}

/** The pages of a model, by its slug, with their model: what a person's named sale is checked against (evidence.ts). */
export async function listCustomModelPages(
  db: Database,
  modelSlug: string,
): Promise<Array<{ id: number; pageLabel: string; platform: string; modelSlug: string }>> {
  const result = await db.execute<Row>(sql`
    select p.id, p.label, p.platform, m.slug from pages p join models m on m.id = p.model_id where m.slug = ${modelSlug} order by p.id`);
  return result.rows.map((row) => ({ id: Number(row.id), pageLabel: String(row.label), platform: String(row.platform), modelSlug: String(row.slug) }));
}

// ── Findings: a custom with no order (0436; customs facts spec §8) ──────────

export type CustomFindingSourceRow = "sale" | "fan_chat" | "work_chat" | "model_group" | "shift_report";
export type CustomFindingStatusRow = "open" | "recorded" | "linked" | "dismissed";
export type CustomFindingDismissRow = "not_custom" | "sexting" | "unused" | "duplicate" | "test" | "not_asked";

export interface CustomFindingRow {
  id: number;
  source: CustomFindingSourceRow;
  ref: string;
  pageId: number | null;
  pageLabel: string | null;
  platform: string | null;
  fanId: number | null;
  fanRef: string | null;
  fanUsername: string | null;
  fanDisplayName: string | null;
  amountMills: number | null;
  quote: string | null;
  happenedAt: Date;
  status: CustomFindingStatusRow;
  orderId: number | null;
  dismissReason: CustomFindingDismissRow | null;
  resolvedAt: Date | null;
  /** The agent key that resolved it (the reader's «не кастом»), and its name; null — a person, the system, or open. */
  resolvedByAgentKeyId: number | null;
  resolvedByAgent: string | null;
  createdAt: Date;
}

const FINDING_SELECT = sql`
  select c.id, c.source, c.ref, c.page_id, p.label as page_label, p.platform, c.fan_id, f.platform_user_id as fan_ref,
    f.username as fan_username, f.display_name as fan_display_name, c.amount_mills, c.quote, c.happened_at, c.status, c.order_id,
    c.dismiss_reason, c.resolved_at, c.resolved_by_agent_key_id, ak.name as resolved_by_agent, c.created_at
  from custom_findings c
  left join pages p on p.id = c.page_id
  left join fans f on f.id = c.fan_id
  left join agent_keys ak on ak.id = c.resolved_by_agent_key_id`;

function findingOf(row: Row): CustomFindingRow {
  return {
    id: Number(row.id),
    source: row.source as CustomFindingSourceRow,
    ref: String(row.ref),
    pageId: num(row.page_id),
    pageLabel: (row.page_label as string | null) ?? null,
    platform: (row.platform as string | null) ?? null,
    fanId: num(row.fan_id),
    fanRef: (row.fan_ref as string | null) ?? null,
    fanUsername: (row.fan_username as string | null) ?? null,
    fanDisplayName: (row.fan_display_name as string | null) ?? null,
    amountMills: num(row.amount_mills),
    quote: (row.quote as string | null) ?? null,
    happenedAt: date(row.happened_at)!,
    status: row.status as CustomFindingStatusRow,
    orderId: num(row.order_id),
    dismissReason: (row.dismiss_reason as CustomFindingDismissRow | null) ?? null,
    resolvedAt: date(row.resolved_at),
    resolvedByAgentKeyId: num(row.resolved_by_agent_key_id),
    resolvedByAgent: (row.resolved_by_agent as string | null) ?? null,
    createdAt: date(row.created_at)!,
  };
}

/** One finding; `lock` — its row lock for the rest of the transaction. */
export async function findCustomFinding(db: Database, id: number, options: { lock?: boolean } = {}): Promise<CustomFindingRow | null> {
  if (options.lock === true) {
    const locked = await db.execute(sql`select id from custom_findings where id = ${id} for update`);
    if (locked.rows.length === 0) return null;
  }
  const result = await db.execute<Row>(sql`${FINDING_SELECT} where c.id = ${id}`);
  return result.rows[0] ? findingOf(result.rows[0]) : null;
}

/**
 * A finding, once by `(source, ref)`: a new one is open, or — `dismissed` — kept as «не кастом» at once. Answers its id
 * and whether it is new; one there already stays as it is, whatever its status.
 */
export async function insertCustomFinding(
  db: Database,
  input: {
    source: CustomFindingSourceRow; ref: string; pageId: number | null; fanId: number | null; amountMills: number | null; quote: string | null;
    happenedAt: Date; dismissed?: { reason: CustomFindingDismissRow; agentKeyId: number | null; userId: number | null }; at: Date;
  },
): Promise<{ id: number; created: boolean }> {
  const at = input.at.toISOString();
  const dismissed = input.dismissed;
  const inserted = await db.execute<{ id: unknown }>(sql`
    insert into custom_findings (source, ref, page_id, fan_id, amount_mills, quote, happened_at, status, dismiss_reason,
      resolved_by_user_id, resolved_by_agent_key_id, resolved_at, created_at)
    values (${input.source}, ${input.ref}, ${input.pageId}, ${input.fanId}, ${input.amountMills}, ${input.quote},
      ${input.happenedAt.toISOString()}::timestamptz, ${dismissed === undefined ? "open" : "dismissed"}, ${dismissed?.reason ?? null},
      ${dismissed?.userId ?? null}, ${dismissed?.agentKeyId ?? null}, ${dismissed === undefined ? null : at}::timestamptz, ${at}::timestamptz)
    on conflict (source, ref) do nothing
    returning id`);
  if (inserted.rows[0]) return { id: Number(inserted.rows[0].id), created: true };
  const existing = await db.execute<{ id: unknown }>(sql`select id from custom_findings where source = ${input.source} and ref = ${input.ref}`);
  return { id: Number(existing.rows[0]!.id), created: false };
}

/** Findings of `realm` (one of no known page is the live agency's) and of `pageIds` ("all" — every page, and no page). */
function findingScope(input: { realm: CustomOrderRealmRow; pageIds: "all" | readonly number[] }): SQL {
  const realm = input.realm === "test" ? testPageSql(sql`c.page_id`) : livePageSql(sql`c.page_id`);
  if (input.pageIds === "all") return realm;
  return input.pageIds.length === 0 ? sql`false` : sql`${realm} and c.page_id = any(${ids(input.pageIds)})`;
}

/** The board's open findings of `realm` and `pageIds` (the ones the viewer resolves), with their fans, the newest first. */
export async function listBoardCustomFindings(
  db: Database,
  input: { realm: CustomOrderRealmRow; pageIds: "all" | readonly number[]; limit: number },
): Promise<CustomFindingRow[]> {
  const result = await db.execute<Row>(sql`${FINDING_SELECT}
    where c.status = 'open' and ${findingScope(input)}
    order by c.happened_at desc, c.id desc
    limit ${input.limit}`);
  return result.rows.map(findingOf);
}

/**
 * The findings an agent dismissed («не кастом» by the reader) since `since`, of `realm`, the newest first: a person sees
 * them in «Отклонено агентом» and may bring one back.
 */
export async function listAgentDismissedCustomFindings(
  db: Database,
  input: { realm: CustomOrderRealmRow; pageIds: "all" | readonly number[]; since: Date; limit: number },
): Promise<CustomFindingRow[]> {
  const result = await db.execute<Row>(sql`${FINDING_SELECT}
    where c.status = 'dismissed' and c.resolved_by_agent_key_id is not null and c.resolved_at >= ${input.since.toISOString()}::timestamptz
      and ${findingScope(input)}
    order by c.resolved_at desc, c.id desc
    limit ${input.limit}`);
  return result.rows.map(findingOf);
}

/** A finding an agent dismissed, open again by a person's word. False — it is not such a finding (any more). */
export async function reopenCustomFinding(db: Database, input: { id: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update custom_findings
    set status = 'open', order_id = null, dismiss_reason = null, resolved_by_user_id = null, resolved_by_agent_key_id = null, resolved_at = null
    where id = ${input.id} and status = 'dismissed' and resolved_by_agent_key_id is not null`);
  return (result.rowCount ?? 0) > 0;
}

/** An open finding resolved: recorded as an order, linked to one, or dismissed. False — it was not open any more. */
export async function resolveCustomFinding(
  db: Database,
  input: { id: number; status: "recorded" | "linked" | "dismissed"; orderId: number | null; dismissReason: CustomFindingDismissRow | null; userId: number; at: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update custom_findings
    set status = ${input.status}, order_id = ${input.orderId}, dismiss_reason = ${input.dismissReason},
      resolved_by_user_id = ${input.userId}, resolved_at = ${input.at.toISOString()}::timestamptz
    where id = ${input.id} and status = 'open'`);
  return (result.rowCount ?? 0) > 0;
}

export interface CustomLookalikeRow {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  fanId: number | null;
  fanRef: string | null;
  fanUsername: string | null;
  fanDisplayName: string | null;
  kind: "tier" | "tip_note";
  detail: string | null;
  grossMills: number;
  at: Date;
  /** Who led the chat, by the one sale rule (sale_homes): the shares' people, the biggest first. */
  ledByUserIds: number[];
}

/**
 * Sales between `from` and `to` that look like a custom and have no order: a new subscription to a tier that
 * includes a custom (a benefit or the name with «free» and «custom»), or a tip whose note speaks of a custom. Not
 * a sale an order holds, not one marked «не кастом», not one of a fan whose order on the page was recorded from
 * seven days before it to a day after. `alsoIds` — sales looked at whatever their day (the ones a matter still
 * waits about): the window only limits which new sales are found.
 */
export async function listCustomLookalikeSales(
  db: Database,
  input: { from: Date; to: Date; limit: number; alsoIds?: readonly number[] },
): Promise<CustomLookalikeRow[]> {
  const from = input.from.toISOString();
  const to = input.to.toISOString();
  const looked = sql`((t.occurred_at >= ${from}::timestamptz and t.occurred_at < ${to}::timestamptz) or t.id = any(${ids(input.alsoIds ?? [])}))`;
  const result = await db.execute<Row>(sql`
    with custom_tiers as (
      select t.page_id, t.tier_ref, t.name from page_subscription_tiers t
      where exists (select 1 from jsonb_array_elements_text(t.subscription_benefits) b where b ~* '\\mfree\\M' and b ~* 'custom')
         or (coalesce(t.name, '') ~* '\\mfree\\M' and coalesce(t.name, '') ~* 'custom')
    ),
    sales as (
      select t.id, t.platform_account_id as page_id, t.fan_id, t.gross_amount_mills, t.occurred_at, 'tier'::text as kind, ct.name as detail
      from transactions t
      join lateral (
        select ps.subscription_tier_id from page_subscriptions ps
        where ps.platform_account_id = t.platform_account_id and ps.fan_id = t.fan_id
          and ps.source_created_at between t.occurred_at - interval '2 hours' and t.occurred_at + interval '2 hours'
        order by ps.source_created_at desc limit 1) ps on true
      join custom_tiers ct on ct.page_id = t.platform_account_id and ct.tier_ref = ps.subscription_tier_id
      where t.canonical_type = 'subscription' and t.is_active and t.gross_amount_mills > 0 and ${looked}
      union all
      select t.id, t.platform_account_id, t.fan_id, t.gross_amount_mills, t.occurred_at, 'tip_note', tc.tip_message_text
      from transactions t
      join transaction_tip_contexts tc on tc.account_id = t.platform_account_id and tc.platform_tip_id = t.correlation_id
      where t.canonical_type = 'tip' and t.is_active and t.gross_amount_mills > 0 and ${looked}
        and tc.tip_message_text ~* '(custom|кастом)'
    )
    select s.id, s.page_id, p.label as page_label, p.platform, s.fan_id, f.platform_user_id as fan_ref, f.username as fan_username,
      f.display_name as fan_display_name, s.kind, s.detail, s.gross_amount_mills, s.occurred_at, sh.shares
    from sales s
    join pages p on p.id = s.page_id
    left join fans f on f.id = s.fan_id
    left join sale_homes sh on sh.transaction_id = s.id and sh.home in ('shift', 'visit')
    where not exists (select 1 from custom_order_payments cp where cp.transaction_id = s.id)
      and not exists (select 1 from custom_sale_dismissals d where d.transaction_id = s.id)
      and not exists (
        select 1 from custom_orders o
        where o.page_id = s.page_id and o.fan_id = s.fan_id and o.state <> 'cancelled'
          and o.created_at between s.occurred_at - interval '7 days' and s.occurred_at + interval '24 hours')
    order by s.occurred_at desc
    limit ${input.limit}`);
  return result.rows.map((row) => {
    const shares = Array.isArray(row.shares) ? (row.shares as Array<{ userId?: unknown; percent?: unknown }>) : [];
    const ledBy = [...shares]
      .filter((share) => typeof share.userId === "number" || typeof share.userId === "string")
      .sort((left, right) => Number(right.percent ?? 0) - Number(left.percent ?? 0))
      .map((share) => Number(share.userId));
    return {
      transactionId: Number(row.id),
      pageId: Number(row.page_id),
      pageLabel: String(row.page_label),
      platform: String(row.platform),
      fanId: num(row.fan_id),
      fanRef: (row.fan_ref as string | null) ?? null,
      fanUsername: (row.fan_username as string | null) ?? null,
      fanDisplayName: (row.fan_display_name as string | null) ?? null,
      kind: row.kind === "tier" ? "tier" : "tip_note",
      detail: (row.detail as string | null) ?? null,
      grossMills: Number(row.gross_amount_mills ?? 0),
      at: date(row.occurred_at)!,
      ledByUserIds: [...new Set(ledBy)],
    };
  });
}

/** «Не кастом»; false — it was marked already. */
export async function dismissCustomSale(db: Database, input: { transactionId: number; userId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    insert into custom_sale_dismissals (transaction_id, user_id) values (${input.transactionId}, ${input.userId})
    on conflict (transaction_id) do nothing`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * What became of a sale that looked like a custom with no order: `recorded` — an order holds it now, or the fan's
 * order on the page was recorded beside it; `dismissed` — «не кастом»; `gone` — the sale is no more (refunded,
 * erased); `waits` — none of these: it still has neither an order nor a word.
 */
export type CustomSaleFate = "recorded" | "dismissed" | "gone" | "waits";

export async function listCustomSaleFates(db: Database, transactionIds: readonly number[]): Promise<Map<number, CustomSaleFate>> {
  const fates = new Map<number, CustomSaleFate>();
  if (transactionIds.length === 0) return fates;
  const result = await db.execute<Row>(sql`
    select asked.id,
      t.id is not null and t.is_active and t.gross_amount_mills > 0 as live,
      exists (select 1 from custom_sale_dismissals d where d.transaction_id = asked.id) as dismissed,
      exists (select 1 from custom_order_payments cp where cp.transaction_id = asked.id)
        or (t.id is not null and exists (
          select 1 from custom_orders o
          where o.page_id = t.platform_account_id and o.fan_id = t.fan_id and o.state <> 'cancelled'
            and o.created_at between t.occurred_at - interval '7 days' and t.occurred_at + interval '24 hours')) as recorded
    from unnest(${ids(transactionIds)}) as asked(id)
    left join transactions t on t.id = asked.id`);
  for (const row of result.rows) {
    fates.set(Number(row.id), row.recorded === true ? "recorded" : row.dismissed === true ? "dismissed" : row.live === true ? "waits" : "gone");
  }
  return fates;
}

/** The live logins of the people who hold a narrow right (person_rights), the lowest id first. */
export async function listUsersWithPersonRight(
  db: Database,
  right: string,
): Promise<Array<{ userId: number; username: string; role: string; displayName: string }>> {
  const result = await db.execute<Row>(sql`
    select u.id, u.username, u.role, p.display_name from person_rights r
    join people p on p.id = r.person_id
    join person_logins pl on pl.person_id = r.person_id
    join users u on u.id = pl.user_id
    where r."right" = ${right} and u.deleted_at is null and u.disabled_at is null
    order by u.id`);
  return result.rows.map((row) => ({ userId: Number(row.id), username: String(row.username), role: String(row.role), displayName: String(row.display_name) }));
}

/**
 * The people on a shift now, by page label (shifts, 0379: a going shift, seen in the last half hour), each page's in
 * one order — who has been on it longest first, then the lower login — so «чей ход» names the same person on every
 * read. Of the page's realm only (0414): a test login on a live page's list, or a live one on a test page's, never.
 */
export async function listOnShiftUsersByPage(db: Database, now: Date): Promise<Map<string, number[]>> {
  const result = await db.execute<{ user_id: unknown; page_label: string }>(sql`
    select s.user_id, e->>'pageLabel' as page_label
    from shifts s cross join lateral jsonb_array_elements(s.pages) e
    join pages p on p.label = e->>'pageLabel'
    where s.state = 'going' and s.ended_at > ${now.toISOString()}::timestamptz - interval '30 minutes'
      and e->>'pageLabel' is not null
      and (${testPageSql(sql`p.id`)}) = (${testUserSql(sql`s.user_id`)})
    group by s.user_id, e->>'pageLabel'
    order by e->>'pageLabel', min(s.started_at), s.user_id`);
  const byPage = new Map<string, number[]>();
  for (const row of result.rows) {
    const list = byPage.get(row.page_label) ?? [];
    list.push(Number(row.user_id));
    byPage.set(row.page_label, list);
  }
  return byPage;
}

/** A fan of the page by what a person gave: the platform's number or a username (case-insensitive); only one on the page. */
export async function findPageFanByInput(
  db: Database,
  input: { pageId: number; platform: string; platformUserId: string | null; username: string | null },
): Promise<{ fanId: number; platformUserId: string } | null> {
  const match = input.platformUserId !== null
    ? sql`f.platform_user_id = ${input.platformUserId}`
    : input.username !== null ? sql`lower(f.username) = lower(${input.username})` : sql`false`;
  const result = await db.execute<Row>(sql`
    select f.id, f.platform_user_id from fans f
    where f.platform = ${input.platform} and ${match}
      and (exists (select 1 from page_fans pf where pf.platform_account_id = ${input.pageId} and pf.fan_id = f.id)
        or exists (select 1 from page_dm_threads th where th.platform_account_id = ${input.pageId} and th.fan_id = f.id))
    limit 2`);
  if (result.rows.length !== 1) return null;
  return { fanId: Number(result.rows[0]!.id), platformUserId: String(result.rows[0]!.platform_user_id) };
}

/**
 * Whether the order's history has this step taken by this message already (`custom_order.refused` by `tg:…`): the
 * daily routine repeats every message it sees, and a step by a message already taken is nothing new.
 */
export async function hasCustomOrderStepByRef(db: Database, input: { orderId: number; event: string; ref: string }): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 from object_events
    where object_type = 'custom_order' and object_id = ${String(input.orderId)} and event = ${input.event} and changes ->> 'ref' = ${input.ref}
    limit 1`);
  return result.rows.length > 0;
}

/** When a person last moved the order's state by their own hand (the board, the extension); null — never. */
export async function findCustomOrderLastHandMove(db: Database, orderId: number): Promise<Date | null> {
  const result = await db.execute<Row>(sql`
    select max(created_at) as at from object_events
    where object_type = 'custom_order' and object_id = ${String(orderId)} and actor_user_id is not null
      and event = any(${texts(["at_model", "partly", "shot", "revision", "refused", "given", "closed", "cancelled"].map((step) => `custom_order.${step}`))})`);
  return date(result.rows[0]?.at);
}

/** One step of an order's history (object_events, 0382). */
export async function insertCustomOrderEvent(
  db: Database,
  input: {
    orderId: number;
    event: string;
    door: "extension" | "workboard" | "telegram" | "api" | "system" | "contentops";
    userId?: number | null;
    agentKeyId?: number | null;
    onBehalfOfUserId?: number | null;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  await db.execute(sql`
    insert into object_events (object_type, object_id, event, actor_user_id, actor_agent_key_id, on_behalf_of_user_id, door, changes, created_at)
    values ('custom_order', ${String(input.orderId)}, ${input.event}, ${input.userId ?? null}, ${input.agentKeyId ?? null},
      ${input.onBehalfOfUserId ?? null}, ${input.door}, ${JSON.stringify(input.changes)}::jsonb, ${input.at.toISOString()}::timestamptz)`);
}

/** The names of the actors of an order's history: a person's registry name (else the login), an agent key's name. */
export async function listCustomOrderActorNames(
  db: Database,
  input: { userIds: readonly number[]; agentKeyIds: readonly number[] },
): Promise<{ users: Map<number, string>; agentKeys: Map<number, string> }> {
  const [users, keys] = await Promise.all([
    input.userIds.length === 0 ? { rows: [] as Row[] } : db.execute<Row>(sql`
      select u.id, coalesce(p.display_name, u.username) as username from users u
      left join person_logins pl on pl.user_id = u.id left join people p on p.id = pl.person_id
      where u.id = any(${ids(input.userIds)})`),
    input.agentKeyIds.length === 0 ? { rows: [] as Row[] } : db.execute<Row>(sql`select id, name from agent_keys where id = any(${ids(input.agentKeyIds)})`),
  ]);
  return {
    users: new Map(users.rows.map((row) => [Number(row.id), String(row.username)])),
    agentKeys: new Map(keys.rows.map((row) => [Number(row.id), String(row.name)])),
  };
}
