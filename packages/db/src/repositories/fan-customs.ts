import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Customs in the fan's record (Chat Memory week 4, 0310,
// docs/plans/2026-10-24-chat-memory/week-4.md §1): what was ordered, its
// payment and its delivery, and Hub's suggestions for both. A chatter writes
// and confirms; Hub sets nothing by itself.

export type FanCustomState = "ordered" | "paid" | "delivered" | "cancelled";

export interface FanCustomRow {
  id: number;
  pageId: number;
  pageLabel: string;
  fanId: number;
  conversationRef: string | null;
  description: string;
  priceMills: number | null;
  state: FanCustomState;
  paymentTransactionId: number | null;
  paymentMills: number | null;
  paidAt: Date | null;
  deliveredMessageRef: string | null;
  deliveredAt: Date | null;
  createdBy: string;
  createdAt: Date;
}

type CustomDbRow = {
  id: string | number; page_id: string | number; page_label: string; fan_id: string | number; conversation_ref: string | null;
  description: string; price_mills: string | number | null; state: FanCustomState; payment_transaction_id: string | number | null;
  payment_mills: string | number | null; paid_at: Date | string | null; delivered_message_ref: string | null;
  delivered_at: Date | string | null; created_by: string; created_at: Date | string;
};

const num = (value: string | number | null) => (value === null ? null : Number(value));
const date = (value: Date | string | null) => (value === null ? null : new Date(value));

const customOf = (row: CustomDbRow): FanCustomRow => ({
  id: Number(row.id),
  pageId: Number(row.page_id),
  pageLabel: row.page_label,
  fanId: Number(row.fan_id),
  conversationRef: row.conversation_ref,
  description: row.description,
  priceMills: num(row.price_mills),
  state: row.state,
  paymentTransactionId: num(row.payment_transaction_id),
  paymentMills: num(row.payment_mills),
  paidAt: date(row.paid_at),
  deliveredMessageRef: row.delivered_message_ref,
  deliveredAt: date(row.delivered_at),
  createdBy: row.created_by,
  createdAt: new Date(row.created_at),
});

const customColumns = sql`c.id, c.page_id, p.label as page_label, c.fan_id, c.conversation_ref, c.description, c.price_mills,
  c.state, c.payment_transaction_id, t.gross_amount_mills as payment_mills, c.paid_at, c.delivered_message_ref, c.delivered_at,
  u.username as created_by, c.created_at`;
const customJoins = sql`join pages p on p.id = c.page_id
  join users u on u.id = c.created_by_user_id
  left join transactions t on t.id = c.payment_transaction_id`;

/** The customs of the person's accounts that are open or ended within `recentDays`, the open first, the newest first. */
export async function listPersonCustoms(db: Database, input: { fanIds: readonly number[]; now: Date; recentDays: number }): Promise<FanCustomRow[]> {
  if (input.fanIds.length === 0) return [];
  const result = await db.execute<CustomDbRow>(sql`
    select ${customColumns}
    from fan_customs c ${customJoins}
    where c.fan_id = any(${sql.param(input.fanIds.map(String))}::bigint[])
      and (c.state in ('ordered', 'paid')
        or coalesce(c.changed_at, c.created_at) > ${input.now.toISOString()}::timestamptz - make_interval(days => ${input.recentDays}))
    order by (c.state in ('ordered', 'paid')) desc, c.created_at desc`);
  return result.rows.map(customOf);
}

/** The page's open customs (ordered or paid), the oldest payment first: what waits to be delivered. */
export async function listPageOpenCustoms(db: Database, input: { pageIds: "all" | readonly number[]; limit: number }): Promise<Array<FanCustomRow & { fanRef: string }>> {
  if (input.pageIds !== "all" && input.pageIds.length === 0) return [];
  const pageFilter = input.pageIds === "all" ? sql`true` : sql`c.page_id = any(${sql.param(input.pageIds.map(String))}::bigint[])`;
  const result = await db.execute<CustomDbRow & { fan_ref: string }>(sql`
    select ${customColumns}, f.platform_user_id as fan_ref
    from fan_customs c ${customJoins}
    join fans f on f.id = c.fan_id
    where c.state in ('ordered', 'paid') and ${pageFilter}
    order by c.paid_at asc nulls last, c.created_at asc
    limit ${input.limit}`);
  return result.rows.map((row) => ({ ...customOf(row), fanRef: row.fan_ref }));
}

export async function findFanCustom(db: Database, customId: number): Promise<FanCustomRow | null> {
  const result = await db.execute<CustomDbRow>(sql`select ${customColumns} from fan_customs c ${customJoins} where c.id = ${customId}`);
  return result.rows[0] ? customOf(result.rows[0]) : null;
}

export interface CustomPaymentSuggestion {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  amountMills: number;
  at: Date;
  /** The fan's note with the tip, when the platform gave one. */
  note: string | null;
}

/** The fan's tips on the page in the last `days` that no custom took yet, the newest first. */
export async function listCustomPaymentSuggestions(
  db: Database,
  input: { pageId: number; fanIds: readonly number[]; now: Date; days: number; limit: number },
): Promise<CustomPaymentSuggestion[]> {
  if (input.fanIds.length === 0) return [];
  const result = await db.execute<{
    id: string | number; page_id: string | number; label: string; gross_amount_mills: string | number; occurred_at: Date | string; note: string | null;
  }>(sql`
    select t.id, t.platform_account_id as page_id, p.label, t.gross_amount_mills, t.occurred_at,
      coalesce(
        (select tc.tip_message_text from transaction_tip_contexts tc
          where tc.account_id = t.platform_account_id and tc.platform_tip_id = t.correlation_id limit 1),
        (select ma.tip_text_plain from message_archive ma
          where ma.account_id = t.platform_account_id and ma.is_tip and ma.tip_text_plain is not null
            and ma.fan_native_id = f.platform_user_id and ma.occurred_at between t.occurred_at - interval '5 minutes' and t.occurred_at + interval '5 minutes'
          limit 1)
      ) as note
    from transactions t
    join pages p on p.id = t.platform_account_id
    join fans f on f.id = t.fan_id
    where t.platform_account_id = ${input.pageId}
      and t.fan_id = any(${sql.param(input.fanIds.map(String))}::bigint[])
      and t.canonical_type = 'tip' and t.is_active and t.gross_amount_mills > 0
      and t.occurred_at > ${input.now.toISOString()}::timestamptz - make_interval(days => ${input.days})
      and not exists (select 1 from fan_customs c where c.payment_transaction_id = t.id)
    order by t.occurred_at desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    transactionId: Number(row.id),
    pageId: Number(row.page_id),
    pageLabel: row.label,
    amountMills: Number(row.gross_amount_mills),
    at: new Date(row.occurred_at),
    note: row.note,
  }));
}

export interface CustomDeliverySuggestion {
  messageRef: string;
  at: Date;
  mediaCount: number;
  priceMills: number | null;
}

/** Messages with media the page sent in the custom's chat since its payment (or creation), the newest first. */
export async function listCustomDeliverySuggestions(
  db: Database,
  input: { pageId: number; conversationRef: string; since: Date; limit: number },
): Promise<CustomDeliverySuggestion[]> {
  const result = await db.execute<{ message_ref: string; occurred_at: Date | string; media: number; price_mills: string | number | null }>(sql`
    select m.message_ref, m.occurred_at, jsonb_array_length(m.media_metadata) as media, m.price_mills
    from message_archive m
    where m.account_id = ${input.pageId} and m.conversation_ref = ${input.conversationRef}
      and m.is_sent_by_me and m.deleted_at is null and coalesce(m.message_type, 1) <> 2
      and jsonb_array_length(m.media_metadata) > 0
      and m.occurred_at >= ${input.since.toISOString()}::timestamptz
    order by m.occurred_at desc
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    messageRef: row.message_ref,
    at: new Date(row.occurred_at),
    mediaCount: Number(row.media),
    priceMills: num(row.price_mills),
  }));
}

export async function insertFanCustom(
  db: Database,
  input: {
    pageId: number; fanId: number; conversationRef: string | null; description: string; priceMills: number | null;
    paymentTransactionId: number | null; paidAt: Date | null; userId: number;
  },
): Promise<number> {
  const result = await db.execute<{ id: string | number }>(sql`
    insert into fan_customs (page_id, fan_id, conversation_ref, description, price_mills, state, payment_transaction_id, paid_at, created_by_user_id)
    values (${input.pageId}, ${input.fanId}, ${input.conversationRef}, ${input.description}, ${input.priceMills},
      ${input.paymentTransactionId === null ? "ordered" : "paid"}, ${input.paymentTransactionId},
      ${input.paidAt === null ? null : input.paidAt.toISOString()}::timestamptz, ${input.userId})
    returning id`);
  return Number(result.rows[0]!.id);
}

export type FanCustomChange =
  | { action: "paid"; paymentTransactionId: number; paidAt: Date }
  | { action: "delivered"; messageRef: string; deliveredAt: Date }
  | { action: "cancel" }
  | { action: "edit"; description: string; priceMills: number | null };

/** A chatter's change of a custom; a delivered or cancelled one is final. Answers whether it changed. */
export async function changeFanCustom(db: Database, input: { customId: number; userId: number; change: FanCustomChange }): Promise<boolean> {
  const by = sql`changed_by_user_id = ${input.userId}, changed_at = now()`;
  const open = sql`id = ${input.customId} and state in ('ordered', 'paid')`;
  const change = input.change;
  const result = change.action === "paid"
    ? await db.execute(sql`update fan_customs set state = 'paid', payment_transaction_id = ${change.paymentTransactionId},
        paid_at = ${change.paidAt.toISOString()}::timestamptz, ${by} where ${open}`)
    : change.action === "delivered"
      ? await db.execute(sql`update fan_customs set state = 'delivered', delivered_message_ref = ${change.messageRef},
          delivered_at = ${change.deliveredAt.toISOString()}::timestamptz, ${by} where ${open}`)
      : change.action === "cancel"
        ? await db.execute(sql`update fan_customs set state = 'cancelled', ${by} where ${open}`)
        : await db.execute(sql`update fan_customs set description = ${change.description}, price_mills = ${change.priceMills}, ${by} where ${open}`);
  return (result.rowCount ?? 0) > 0;
}

/** The fan's chat on the page: the thread with the newest message (on Fansly the group). */
export async function findFanConversationRef(db: Database, pageId: number, fanId: number): Promise<string | null> {
  const result = await db.execute<{ conversation: string }>(sql`
    select platform_conversation_id as conversation from page_dm_threads
    where platform_account_id = ${pageId} and fan_id = ${fanId}
    order by last_message_at desc nulls last limit 1`);
  return result.rows[0]?.conversation ?? null;
}
