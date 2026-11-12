import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

// Заказ кастома (0399; ecosystem plan 2026-11-12, package I): the order, its
// payments (sales of the fan, one sale pays at most one order), its Telegram
// cards, «не кастом» marks, and what the checks and the hints read. Raw SQL:
// the tables are defined by their migration alone. Every change of an order
// leaves an object event (object_events, 0382) in the same transaction — the
// service writes both.

export type CustomOrderStateRow =
  | "recorded" | "paid" | "at_model" | "partly" | "shot" | "revision" | "refused" | "given" | "closed" | "cancelled";
export type CustomOrderOriginRow = "extension" | "agent" | "workboard" | "import";

export interface CustomOrderRow {
  id: number;
  pageId: number | null;
  pageLabel: string | null;
  platform: string | null;
  modelName: string | null;
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
  partsDone: Array<"video" | "photos">;
  personFields: string[];
  version: number;
  openRevisions: number;
  createdAt: Date;
  updatedAt: Date;
  paidGrossMills: number;
  paidNetMills: number;
  payments: number;
  firstPaidAt: Date | null;
  telegramRefs: string[];
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
    personFields: (row.person_fields as string[] | null) ?? [],
    version: Number(row.version ?? 1),
    openRevisions: Number(row.open_revisions ?? 0),
    createdAt: date(row.created_at)!,
    updatedAt: date(row.updated_at)!,
    paidGrossMills: Number(row.paid_gross ?? 0),
    paidNetMills: Number(row.paid_net ?? 0),
    payments: Number(row.payments ?? 0),
    firstPaidAt: date(row.first_paid_at),
    telegramRefs: ((row.telegram_refs as string[] | null) ?? []).filter((ref) => typeof ref === "string"),
  };
}

const ORDER_SELECT = sql`
  select o.id, o.page_id, p.label as page_label, p.platform, m.name as model_name,
    o.fan_id, f.platform_user_id as fan_ref, f.username as fan_username, f.display_name as fan_display_name,
    o.buyer, o.fan_erased_at,
    coalesce(o.conversation_ref, case when p.platform = 'onlyfans' then f.platform_user_id else (
      select th.platform_conversation_id from page_dm_threads th
      where th.platform_account_id = o.page_id and th.fan_id = o.fan_id
      order by th.last_message_at desc nulls last limit 1) end) as conversation_ref,
    o.card, o.deadline_on::text as deadline_on, o.state, o.state_at, o.state_note, o.state_ref,
    o.given_message_ref, o.given_at, o.accepted_by_user_id, u.username as accepted_by, ap.display_name as accepted_by_name, o.origin, o.contentops_ref,
    o.source_text, o.parts_done, o.person_fields, o.version,
    (select count(*) from custom_order_messages mm where mm.order_id = o.id and mm.kind = 'revision' and mm.done_at is null) as open_revisions,
    o.created_at, o.updated_at,
    coalesce(pay.gross, 0) as paid_gross, coalesce(pay.net, 0) as paid_net, coalesce(pay.n, 0) as payments, pay.first_at as first_paid_at,
    coalesce(cards.refs, '{}'::text[]) as telegram_refs
  from custom_orders o
  left join pages p on p.id = o.page_id
  left join models m on m.id = p.model_id
  left join fans f on f.id = o.fan_id
  left join users u on u.id = o.accepted_by_user_id
  left join person_logins apl on apl.user_id = o.accepted_by_user_id
  left join people ap on ap.id = apl.person_id
  left join lateral (
    select sum(t.gross_amount_mills) as gross, sum(t.creator_net_amount_mills) as net, count(cp.transaction_id) as n,
      min(t.occurred_at) as first_at
    from custom_order_payments cp left join transactions t on t.id = cp.transaction_id
    where cp.order_id = o.id) pay on true
  left join lateral (
    select array_agg(c.telegram_ref order by c.added_at, c.telegram_ref) as refs
    from custom_order_cards c where c.order_id = o.id) cards on true`;

export const CUSTOM_ORDER_ENDED_STATES: readonly CustomOrderStateRow[] = ["given", "closed", "cancelled"];

/**
 * The orders a board shows: open ones, and the given and closed since `doneSince`, of `pageIds` (all — every
 * page), with or without the orders of no known page; the oldest step first.
 */
export async function listCustomOrders(
  db: Database,
  input: { pageIds: "all" | readonly number[]; unknownPage: boolean; doneSince: Date; limit: number },
): Promise<CustomOrderRow[]> {
  const pages = input.pageIds === "all" ? sql`o.page_id is not null` : input.pageIds.length === 0 ? sql`false` : sql`o.page_id = any(${ids(input.pageIds)})`;
  const scope = input.unknownPage ? sql`(${pages} or o.page_id is null)` : pages;
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where ${scope}
      and (o.state not in ('given', 'closed', 'cancelled')
        or (o.state in ('given', 'closed') and coalesce(o.given_at, o.state_at) >= ${input.doneSince.toISOString()}::timestamptz))
    order by o.state_at asc, o.id asc
    limit ${input.limit}`);
  return result.rows.map(orderOf);
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
 * «Кастомы оплачены, не отданы» counts once the owner's setting points it at the orders. The oldest payment first.
 */
export async function listCustomOrdersAwaitingGiving(db: Database, input: { pageIds: "all" | readonly number[]; limit: number }): Promise<CustomOrderRow[]> {
  const pages = input.pageIds === "all" ? sql`true` : input.pageIds.length === 0 ? sql`false` : sql`o.page_id = any(${ids(input.pageIds)})`;
  const result = await db.execute<Row>(sql`${ORDER_SELECT}
    where ${pages} and o.state in ('paid', 'at_model', 'partly', 'shot', 'revision')
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

/** Orders by agent filters: open or every state, of `pageIds` and of no known page. */
export async function listAgentCustomOrders(
  db: Database,
  input: { pageIds: readonly number[]; open: boolean; orderId?: number | null; telegramRef?: string | null; limit: number },
): Promise<CustomOrderRow[]> {
  const parts: SQL[] = [sql`(o.page_id is null or o.page_id = any(${ids(input.pageIds)}))`];
  if (input.open) parts.push(sql`o.state not in ('given', 'closed', 'cancelled')`);
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
  at: Date;
}

export async function insertCustomOrder(db: Database, input: NewCustomOrderRow): Promise<number> {
  const at = input.at.toISOString();
  const result = await db.execute<{ id: unknown }>(sql`
    insert into custom_orders (page_id, fan_id, buyer, conversation_ref, card, deadline_on, state, state_at, accepted_by_user_id,
      origin, contentops_ref, source_text, created_at, updated_at)
    values (${input.pageId}, ${input.fanId}, ${input.buyer}, ${input.conversationRef}, ${JSON.stringify(input.card)}::jsonb,
      ${input.deadlineOn}::date, ${input.state}, ${at}::timestamptz, ${input.acceptedByUserId}, ${input.origin},
      ${input.contentopsRef}, ${input.sourceText}, ${at}::timestamptz, ${at}::timestamptz)
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
  personFields?: readonly string[];
}

/** The order's fields (not its state). */
export async function updateCustomOrderFields(db: Database, orderId: number, patch: CustomOrderFieldsPatch, at: Date): Promise<void> {
  const sets: SQL[] = [sql`updated_at = ${at.toISOString()}::timestamptz`];
  if (patch.card !== undefined) sets.push(sql`card = ${JSON.stringify(patch.card)}::jsonb`);
  if (patch.deadlineOn !== undefined) sets.push(sql`deadline_on = ${patch.deadlineOn}::date`);
  if (patch.pageId !== undefined) sets.push(sql`page_id = ${patch.pageId}`);
  if (patch.fanId !== undefined) sets.push(sql`fan_id = ${patch.fanId}`);
  if (patch.buyer !== undefined) sets.push(sql`buyer = ${patch.buyer}`);
  if (patch.conversationRef !== undefined) sets.push(sql`conversation_ref = ${patch.conversationRef}`);
  if (patch.sourceText !== undefined) sets.push(sql`source_text = ${patch.sourceText}`);
  if (patch.partsDone !== undefined) sets.push(sql`parts_done = ${texts(patch.partsDone)}`);
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
    given?: { messageRef: string; at: Date };
    at: Date;
  },
): Promise<boolean> {
  const at = input.at.toISOString();
  const given = input.given === undefined ? sql`` : sql`, given_message_ref = ${input.given.messageRef}, given_at = ${input.given.at.toISOString()}::timestamptz`;
  const result = await db.execute(sql`
    update custom_orders set state = ${input.to}, state_at = ${at}::timestamptz, state_note = ${input.note ?? null},
      state_ref = ${input.ref ?? null}, updated_at = ${at}::timestamptz ${given}
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
  /** The sender's own id of the event (0999: ContentOps' delivery or retraction); null — a Telegram message. */
  eventRef: string | null;
  ordinal: number;
  kind: CustomOrderMessageKindRow;
  part: "video" | "photos" | null;
  /** A delivery: that part whole; null — not said (recorded before 0999). */
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

/** A revision request fixed; false — none open by that message (or event ref) and ordinal. */
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

/** Every open revision request of the order fixed (a whole new version came, or «снят»): how many. */
export async function closeCustomOrderRevisions(db: Database, input: { orderId: number; at: Date }): Promise<number> {
  const result = await db.execute(sql`
    update custom_order_messages set done_at = ${input.at.toISOString()}::timestamptz
    where order_id = ${input.orderId} and kind = 'revision' and done_at is null`);
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

/** The order's deliveries not taken back: how many, and the parts one of them made whole (`complete` not false). */
export async function listCustomOrderLiveDeliveries(db: Database, orderId: number): Promise<{ count: number; wholeParts: Array<"video" | "photos"> }> {
  const result = await db.execute<Row>(sql`
    select count(*)::int as n,
      coalesce(array_agg(distinct part) filter (where part is not null and complete is not false), '{}'::text[]) as parts
    from custom_order_messages where order_id = ${orderId} and kind = 'delivery' and retracted_at is null`);
  const row = result.rows[0];
  return {
    count: Number(row?.n ?? 0),
    wholeParts: ((row?.parts as string[] | null) ?? []).filter((part): part is "video" | "photos" => part === "video" || part === "photos"),
  };
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

/** The fan's sales on the page in the last `days` that no order holds, of `kinds`, the newest first: «Это оплата?». */
export async function listCustomPaymentCandidates(
  db: Database,
  input: { pageId: number; fanIds: readonly number[]; kinds: readonly string[]; now: Date; days: number; limit: number },
): Promise<CustomOrderSaleRow[]> {
  if (input.fanIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select t.id, t.canonical_type::text as canonical_type, t.gross_amount_mills, t.creator_net_amount_mills, t.occurred_at, ${NOTE_OF} as note
    from transactions t
    join fans f on f.id = t.fan_id
    where t.platform_account_id = ${input.pageId} and t.fan_id = any(${ids(input.fanIds)})
      and t.canonical_type::text = any(${texts(input.kinds)}) and t.is_active and t.gross_amount_mills > 0
      and t.occurred_at > ${input.now.toISOString()}::timestamptz - make_interval(days => ${input.days})
      and not exists (select 1 from custom_order_payments cp where cp.transaction_id = t.id)
    order by t.occurred_at desc
    limit ${input.limit}`);
  return result.rows.map(saleOf);
}

/** One sale with its page and fan, for a record from it. */
export async function findCustomSale(db: Database, transactionId: number): Promise<{ transactionId: number; pageId: number; fanId: number | null; at: Date } | null> {
  const result = await db.execute<Row>(sql`
    select id, platform_account_id, fan_id, occurred_at from transactions where id = ${transactionId}`);
  const row = result.rows[0];
  return row ? { transactionId: Number(row.id), pageId: Number(row.platform_account_id), fanId: num(row.fan_id), at: date(row.occurred_at)! } : null;
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
 * seven days before it to a day after.
 */
export async function listCustomLookalikeSales(db: Database, input: { from: Date; to: Date; limit: number }): Promise<CustomLookalikeRow[]> {
  const from = input.from.toISOString();
  const to = input.to.toISOString();
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
      where t.canonical_type = 'subscription' and t.is_active and t.gross_amount_mills > 0
        and t.occurred_at >= ${from}::timestamptz and t.occurred_at < ${to}::timestamptz
      union all
      select t.id, t.platform_account_id, t.fan_id, t.gross_amount_mills, t.occurred_at, 'tip_note', tc.tip_message_text
      from transactions t
      join transaction_tip_contexts tc on tc.account_id = t.platform_account_id and tc.platform_tip_id = t.correlation_id
      where t.canonical_type = 'tip' and t.is_active and t.gross_amount_mills > 0
        and t.occurred_at >= ${from}::timestamptz and t.occurred_at < ${to}::timestamptz
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

/** The people on a shift now, by page label (shifts, 0379: a going shift, seen in the last half hour). */
export async function listOnShiftUsersByPage(db: Database, now: Date): Promise<Map<string, number[]>> {
  const result = await db.execute<{ user_id: unknown; page_label: string }>(sql`
    select distinct s.user_id, e->>'pageLabel' as page_label
    from shifts s cross join lateral jsonb_array_elements(s.pages) e
    where s.state = 'going' and s.ended_at > ${now.toISOString()}::timestamptz - interval '30 minutes'
      and e->>'pageLabel' is not null`);
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

/** One step of an order's history (object_events, 0382). */
export async function insertCustomOrderEvent(
  db: Database,
  input: {
    orderId: number;
    event: string;
    door: "extension" | "workboard" | "telegram" | "api" | "system";
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
