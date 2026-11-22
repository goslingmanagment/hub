import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { ppvBoughtSql, seenMessageSql } from "./shift-sql.ts";

// Заказ кастома, what the checks pass reads and writes by itself (customs facts spec §6, §7, behind the switch
// `customsFacts`): the order's finished files and the messages that carried them to the fan, the sent-and-not-opened
// mark, the system's default deadline. Raw SQL over the tables of 0399/0436 and the media plane (0130, 0136, 0148).
// Every change of an order is the service's with its history event (services/custom-orders/deliveries.ts).

type Row = Record<string, unknown>;
const date = (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value)));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const texts = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;

/** A finished file of an order: a vault file of a page of its model. */
export interface CustomOrderFileRow {
  orderId: number;
  pageId: number;
  mediaRef: string;
  /**
   * Its name, lower-cased: the same file copied to another page of the model (to resell it) keeps it, so the copies of
   * one file share it (`deliveryVerdictOf`: one of them reaching the fan delivers the file).
   */
  name: string;
  /** When it first appeared (the platform's time of the upload or of the album, else when the hub saw it). */
  appearedAt: Date;
}

/**
 * The finished files of these orders: the vault files on pages of each order's model whose name carries the order's
 * code (`…_K-<id>_…`: the album member's `custom_filename` in the creator's vault, the raw file's `filename`) and that
 * first appeared after the order's last revision request — a file of before it is the version sent back. Reads only the
 * pages of the orders' models (the vault rows by their page index); an order of no known page has none. The one rule of
 * «the order has its files»: the exact «given» and the agent's door (evidence.ts) read it alike.
 */
export async function listCustomOrderNamedFiles(db: Database, orderIds: readonly number[]): Promise<CustomOrderFileRow[]> {
  if (orderIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    with o as (
      select co.id as order_id, p.model_id,
        (select max(coalesce(mm.posted_at, mm.added_at)) from custom_order_messages mm where mm.order_id = co.id and mm.kind = 'revision') as revised_at
      from custom_orders co join pages p on p.id = co.page_id
      where co.id = any(${ids(orderIds)}) and p.model_id is not null
    ),
    model_pages as (select distinct o.model_id, mp.id as page_id from o join pages mp on mp.model_id = o.model_id),
    named as (
      select mp.model_id, vm.page_id, vm.media_ref, (regexp_match(vm.custom_filename, '_K-([0-9]{1,15})_'))[1] as code,
        lower(vm.custom_filename) as name, coalesce(vm.created_at_platform, vm.first_observed_at) as at
      from model_pages mp join creator_vault_album_members vm on vm.page_id = mp.page_id
      where vm.vault_kind = 'creator' and vm.custom_filename ~ '_K-[0-9]{1,15}_'
      union all
      select mp.model_id, r.page_id, r.media_ref, (regexp_match(r.filename, '_K-([0-9]{1,15})_'))[1],
        lower(r.filename), coalesce(r.created_at_platform, r.first_observed_at)
      from model_pages mp join creator_raw_media r on r.page_id = mp.page_id
      where r.filename ~ '_K-[0-9]{1,15}_'
    )
    select o.order_id, n.page_id, n.media_ref, min(n.name) as name, min(n.at) as appeared_at
    from named n join o on o.model_id = n.model_id and n.code::bigint = o.order_id
    group by o.order_id, o.revised_at, n.page_id, n.media_ref
    having o.revised_at is null or min(n.at) > o.revised_at
    order by o.order_id, n.page_id, n.media_ref`);
  return result.rows.map((row) => ({
    orderId: Number(row.order_id), pageId: Number(row.page_id), mediaRef: String(row.media_ref), name: String(row.name), appearedAt: date(row.appeared_at)!,
  }));
}

/**
 * From when a page's message counts as delivering each of these orders (customs facts spec §6, §10): the later of its last
 * revision request (the files the fan had are sent back) and a person's last «не отдан» (they took the delivery off, so a
 * message of before it — the same file sent twice — never gives it again). Absent — neither: since the order was recorded.
 */
export async function listCustomOrderEvidenceFloors(db: Database, orderIds: readonly number[]): Promise<Map<number, Date>> {
  if (orderIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select x.id, greatest(
        (select max(coalesce(mm.posted_at, mm.added_at)) from custom_order_messages mm where mm.order_id = x.id and mm.kind = 'revision'),
        (select max(e.created_at) from object_events e
          where e.object_type = 'custom_order' and e.object_id = x.id::text and e.event = 'custom_order.ungiven' and e.door not in ('system', 'api'))
      ) as floor
    from unnest(${ids(orderIds)}) as x(id)`);
  const out = new Map<number, Date>();
  for (const row of result.rows) {
    const floor = date(row.floor);
    if (floor !== null) out.set(Number(row.id), floor);
  }
  return out;
}

/** A page's message that carried a file of an order to one of the order's fan's accounts, by one of its offers. */
export interface CustomFileSendRow {
  pageId: number;
  mediaRef: string;
  messageRef: string;
  at: Date;
  /** The offer that carried the file has a price (on Fansly the offer's own; a message priced as a whole: the message's). */
  priced: boolean;
  /** That offer bought by the fan (its purchase, or the platform's mark of it); a free one — false. */
  bought: boolean;
  /**
   * The purchases of that offer by the fan (Hub's ids), the earliest first: only the offer that carried the file — a
   * message of several priced offers is several purchases, and the others are not this order's money.
   */
  purchaseIds: number[];
}

/**
 * The purchases (Hub's ids, the earliest first) of the page's message `ma` by the fan of its chat `th` whose correlation
 * is one of `refs` (an offer's or a bundle's ref): active, positive message purchases made after it and not through a
 * later message of the page that carried the same offer before the purchase (the one rule's, `ppvBoughtSql`).
 */
function purchasesOfSql(refs: SQL): SQL {
  return sql`array(
    select t.id from transactions t
    where t.platform_account_id = ma.account_id and t.fan_id = th.fan_id and t.canonical_type = 'message_purchase' and t.is_active
      and t.gross_amount_mills > 0 and t.occurred_at >= ma.occurred_at and t.correlation_id in (${refs})
      and not exists (
        select 1 from message_archive later
        join message_media_offers lo on lo.page_id = later.account_id and lo.message_ref = later.message_ref
        where later.account_id = ma.account_id and later.conversation_ref = ma.conversation_ref and later.is_sent_by_me
          and later.occurred_at > ma.occurred_at and later.occurred_at <= t.occurred_at
          and (lo.media_offer_ref = t.correlation_id or lo.bundle_ref = t.correlation_id))
    order by t.occurred_at, t.id)`;
}

/** How many of the message `ma`'s offers carry a price. */
const pricedOffersOf = sql`(select count(*) from message_media_offers po
  where po.page_id = ma.account_id and po.message_ref = ma.message_ref and coalesce(po.price_mills, 0) > 0)`;

/**
 * The messages that carried these files to the fan (any of `fanIds`, the accounts of one person), sent after `since`,
 * each by the offer that carried the file. The path (verified on production): the vault file's `media_ref` → its offers
 * in `creator_media` (`media_offer_ref`, `bundle_refs`: a send makes a new offer, never the vault's id) →
 * `message_media_offers` → the page's message. Priced, bought and paid are that offer's on Fansly (a message may carry
 * the custom free and another clip priced, or two priced offers of which the fan buys one): never the whole message's.
 * The recipient is the message's conversation (`page_dm_threads`), never `message_media_offers.fan_platform_user_id`
 * (on Fansly it holds the page's own id). A message deleted before anyone could see it carried nothing. Every lookup is
 * by an index from the few files; `message_archive` is read only by its unique key.
 */
export async function listCustomFileSends(
  db: Database,
  input: { files: ReadonlyArray<{ pageId: number; mediaRef: string }>; fanIds: readonly number[]; since: Date; unseenSeconds: number },
): Promise<CustomFileSendRow[]> {
  if (input.files.length === 0 || input.fanIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    with files as (
      select * from unnest(${ids(input.files.map((file) => file.pageId))}, ${texts(input.files.map((file) => file.mediaRef))}) as f(page_id, media_ref)
    ),
    offers as (
      select f.page_id, f.media_ref, cm.media_offer_ref, cm.bundle_refs
      from files f join creator_media cm on cm.page_id = f.page_id and cm.media_ref = f.media_ref
    ),
    carried as (
      select o.page_id, o.media_ref, mo.message_ref, mo.media_offer_ref as offer_ref, mo.price_mills as offer_price, mo.purchase_state
      from offers o join message_media_offers mo on mo.page_id = o.page_id and mo.media_offer_ref = o.media_offer_ref
      union
      select o.page_id, o.media_ref, mo.message_ref, mo.bundle_ref, mo.price_mills, mo.purchase_state
      from offers o cross join lateral unnest(o.bundle_refs) as b(bundle_ref)
      join message_media_offers mo on mo.page_id = o.page_id and mo.bundle_ref = b.bundle_ref
    )
    select c.page_id, c.media_ref, c.message_ref, ma.occurred_at, x.priced, x.bought, paid.ids as purchase_ids
    from carried c
    join pages p on p.id = c.page_id
    join message_archive ma on ma.account_id = c.page_id and ma.platform = p.platform and ma.message_ref = c.message_ref
    join page_dm_threads th on th.platform_account_id = ma.account_id and th.platform_conversation_id = ma.conversation_ref
    cross join lateral (select ${purchasesOfSql(sql`c.offer_ref`)} as ids) paid
    cross join lateral (
      select
        case when p.platform = 'fansly'
          then coalesce(c.offer_price, 0) > 0 or (coalesce(ma.price_mills, 0) > 0 and ${pricedOffersOf} = 0)
          else coalesce(ma.price_mills, 0) > 0 or ${pricedOffersOf} > 0 end as priced,
        case when p.platform = 'fansly'
          then c.purchase_state = 'purchased' or cardinality(paid.ids) > 0
            -- A purchase the platform records for the message as a whole tells the offer only when it is the one priced.
            or (${pricedOffersOf} <= 1 and exists (select 1 from media_orders mor where mor.page_id = ma.account_id and mor.message_ref = ma.message_ref))
          else ${ppvBoughtSql({ pageId: "ma.account_id", platform: "ma.platform", ref: "ma.message_ref", conv: "ma.conversation_ref", at: "ma.occurred_at" })} end as bought
    ) x
    where ma.is_sent_by_me and ma.occurred_at > ${input.since.toISOString()}::timestamptz
      and th.fan_id = any(${ids(input.fanIds)})
      and ${seenMessageSql("ma", input.unseenSeconds)}
    order by ma.occurred_at, c.message_ref`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    mediaRef: String(row.media_ref),
    messageRef: String(row.message_ref),
    at: date(row.occurred_at)!,
    priced: row.priced === true,
    bought: row.priced === true && row.bought === true,
    purchaseIds: ((row.purchase_ids as unknown[] | null) ?? []).map(Number),
  }));
}

/**
 * The purchases (Hub's ids) of a page's message named as an order's delivery (the agent's «отдан», the backfill), by the
 * fan of its chat (any of `fanIds`): the purchase of its one priced offer — that is the order's money by construction.
 * A message of several priced offers answers none (which one was the custom is not known: the reader names the sale).
 */
export async function listCustomMessagePurchases(
  db: Database,
  input: { pageIds: readonly number[]; messageRef: string; fanIds: readonly number[] },
): Promise<number[]> {
  if (input.pageIds.length === 0 || input.fanIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select ${purchasesOfSql(sql`select x.ref from message_media_offers lo cross join lateral (values (lo.media_offer_ref), (lo.bundle_ref)) as x(ref)
      where lo.page_id = ma.account_id and lo.message_ref = ma.message_ref and x.ref is not null`)} as ids
    from message_archive ma
    join page_dm_threads th on th.platform_account_id = ma.account_id and th.platform_conversation_id = ma.conversation_ref
    where ma.account_id = any(${ids(input.pageIds)}) and ma.message_ref = ${input.messageRef} and ma.deleted_at is null
      and th.fan_id = any(${ids(input.fanIds)}) and ${pricedOffersOf} = 1
    order by ma.occurred_at desc
    limit 1`);
  return ((result.rows[0]?.ids as unknown[] | undefined) ?? []).map(Number);
}

/** What a person took off an order (0436, `custom_order_rejections`): the sales and the delivering messages, by kind. */
export async function listCustomOrderRejectedRefs(db: Database, orderId: number): Promise<{ payment: Set<string>; given: Set<string> }> {
  const result = await db.execute<Row>(sql`select kind, ref from custom_order_rejections where order_id = ${orderId}`);
  const out = { payment: new Set<string>(), given: new Set<string>() };
  for (const row of result.rows) (row.kind === "payment" ? out.payment : out.given).add(String(row.ref));
  return out;
}

/**
 * The order's «отправлен, фан не открыл» (0436): every file was sent and a priced one is not bought yet — the last
 * message that carried one and its time; null clears it. Answers whether it changed.
 */
export async function setCustomOrderSent(db: Database, orderId: number, sent: { messageRef: string; at: Date } | null, now: Date): Promise<boolean> {
  const at = sent === null ? null : sent.at.toISOString();
  const ref = sent === null ? null : sent.messageRef;
  const result = await db.execute(sql`
    update custom_orders set sent_at = ${at}::timestamptz, sent_message_ref = ${ref}, updated_at = ${now.toISOString()}::timestamptz
    where id = ${orderId} and (sent_at is distinct from ${at}::timestamptz or sent_message_ref is distinct from ${ref})`);
  return (result.rowCount ?? 0) > 0;
}

/** Given: what only an order still waiting for its fan holds goes — the sent mark and the fan's «where is it» (0436). */
export async function clearCustomOrderWaitMarks(db: Database, orderId: number, now: Date): Promise<void> {
  await db.execute(sql`
    update custom_orders set sent_at = null, sent_message_ref = null, fan_asked_at = null, fan_asked_ref = null,
      updated_at = ${now.toISOString()}::timestamptz
    where id = ${orderId} and (sent_at is not null or fan_asked_at is not null)`);
}

/**
 * The system's deadline of an order that has none (customs facts spec C2): the day given, marked «примерно»
 * (`deadline_default`), and never one of the person's fields. Only while the order still has no deadline and no person
 * set it (a person who took the deadline off meant it: `person_fields` holds `deadlineOn`); answers whether it was set.
 */
export async function setCustomOrderDefaultDeadline(db: Database, orderId: number, deadlineOn: string, now: Date): Promise<boolean> {
  const result = await db.execute(sql`
    update custom_orders set deadline_on = ${deadlineOn}::date, deadline_default = true, updated_at = ${now.toISOString()}::timestamptz
    where id = ${orderId} and deadline_on is null and not ('deadlineOn' = any(coalesce(person_fields, '{}'::text[])))`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The page's first message to the fan (any of `fanIds`, the accounts of one person) in his chat on the page after
 * `after`: the page answered his «where is it» (customs facts spec §7). Null — it did not. By the chat's index.
 */
export async function findCustomPageReplyAfter(
  db: Database,
  input: { pageId: number; fanIds: readonly number[]; after: Date },
): Promise<{ messageRef: string; at: Date } | null> {
  if (input.fanIds.length === 0) return null;
  const result = await db.execute<Row>(sql`
    with chats as (
      select th.platform_conversation_id as conv from page_dm_threads th
      where th.platform_account_id = ${input.pageId} and th.fan_id = any(${ids(input.fanIds)})
      union
      -- An OnlyFans chat is named by the fan's own id.
      select f.platform_user_id from fans f join pages p on p.id = ${input.pageId}
      where p.platform = 'onlyfans' and f.platform = 'onlyfans' and f.id = any(${ids(input.fanIds)})
    )
    select m.message_ref, m.occurred_at
    from chats c join message_archive m on m.account_id = ${input.pageId} and m.conversation_ref = c.conv
    where m.is_sent_by_me and m.deleted_at is null and m.occurred_at > ${input.after.toISOString()}::timestamptz
    order by m.occurred_at, m.message_ref
    limit 1`);
  const row = result.rows[0];
  return row ? { messageRef: String(row.message_ref), at: date(row.occurred_at)! } : null;
}
