import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Сообщения людям (0403, package S): the server's sender's rows, and the reads
// of the facts that fire its kinds. What a row says and when it may send are
// the service's (apps/runtime/src/services/people-messages/): this file reads
// and writes rows. Raw SQL: the table is the migration's alone.

export type PeopleMessageStateRow = "held" | "sending" | "sent" | "failed" | "unknown";
export type PeopleMessageHeldReasonRow = "kind_off" | "no_token" | "no_telegram" | "no_chat" | "cap" | "before_on";

export interface PeopleMessageRow {
  id: number;
  kind: string;
  idempotencyKey: string;
  recipient: "person" | "chat";
  recipientUserId: number | null;
  telegramChatId: string | null;
  telegramTopicId: number | null;
  toWords: string;
  objectType: string | null;
  objectId: string | null;
  about: string;
  text: string;
  eventAt: Date;
  state: PeopleMessageStateRow;
  heldReason: PeopleMessageHeldReasonRow | null;
  createdAt: Date;
  attemptedAt: Date | null;
  settledAt: Date | null;
  telegramMessageId: number | null;
  error: string | null;
}

export type NewPeopleMessageRow = Omit<PeopleMessageRow, "id" | "createdAt" | "settledAt" | "telegramMessageId" | "error">
  & { createdAt: Date };

type Row = Record<string, unknown>;
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const date = (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value : new Date(String(value)));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const texts = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;

const COLUMNS = sql`id, kind, idempotency_key, recipient, recipient_user_id, telegram_chat_id, telegram_topic_id, to_words,
  object_type, object_id, about, text, event_at, state, held_reason, created_at, attempted_at, settled_at, telegram_message_id, error`;

function messageOf(row: Row): PeopleMessageRow {
  return {
    id: Number(row.id),
    kind: String(row.kind),
    idempotencyKey: String(row.idempotency_key),
    recipient: row.recipient === "chat" ? "chat" : "person",
    recipientUserId: num(row.recipient_user_id),
    telegramChatId: text(row.telegram_chat_id),
    telegramTopicId: num(row.telegram_topic_id),
    toWords: String(row.to_words),
    objectType: text(row.object_type),
    objectId: text(row.object_id),
    about: String(row.about),
    text: String(row.text),
    eventAt: date(row.event_at)!,
    state: String(row.state) as PeopleMessageStateRow,
    heldReason: (text(row.held_reason) as PeopleMessageHeldReasonRow | null),
    createdAt: date(row.created_at)!,
    attemptedAt: date(row.attempted_at),
    settledAt: date(row.settled_at),
    telegramMessageId: num(row.telegram_message_id),
    error: text(row.error),
  };
}

/** The keys of `keys` that already have their message. */
export async function listExistingPeopleMessageKeys(db: Database, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const result = await db.execute<Row>(sql`select idempotency_key from people_messages where idempotency_key = any(${texts(keys)})`);
  return new Set(result.rows.map((row) => String(row.idempotency_key)));
}

/** The objects of `objectIds` (of a kind) that have a message already, whatever its key's tail. */
export async function listPeopleMessageObjectIds(db: Database, input: { kind: string; objectType: string; objectIds: readonly string[] }): Promise<Set<string>> {
  if (input.objectIds.length === 0) return new Set();
  const result = await db.execute<Row>(sql`
    select distinct object_id from people_messages
    where kind = ${input.kind} and object_type = ${input.objectType} and object_id = any(${texts(input.objectIds)})`);
  return new Set(result.rows.map((row) => String(row.object_id)));
}

/**
 * Writes a message once: a second one with the same key writes nothing (null). A row that is not `held` is written
 * already `sending`, with its attempt's time, BEFORE the attempt is made: a crash in between leaves it `sending`,
 * and the sweep calls it `unknown`, never sends it again.
 */
export async function insertPeopleMessage(db: Database, input: NewPeopleMessageRow): Promise<PeopleMessageRow | null> {
  const result = await db.execute<Row>(sql`
    insert into people_messages (kind, idempotency_key, recipient, recipient_user_id, telegram_chat_id, telegram_topic_id, to_words,
      object_type, object_id, about, text, event_at, state, held_reason, created_at, attempted_at)
    values (${input.kind}, ${input.idempotencyKey}, ${input.recipient}, ${input.recipientUserId}, ${input.telegramChatId}, ${input.telegramTopicId},
      ${input.toWords}, ${input.objectType}, ${input.objectId}, ${input.about}, ${input.text}, ${input.eventAt.toISOString()}::timestamptz,
      ${input.state}, ${input.heldReason}, ${input.createdAt.toISOString()}::timestamptz,
      ${input.attemptedAt === null ? null : input.attemptedAt.toISOString()}::timestamptz)
    on conflict (idempotency_key) do nothing
    returning ${COLUMNS}`);
  const row = result.rows[0];
  return row === undefined ? null : messageOf(row);
}

/** The one attempt's outcome, on a row still `sending`; false — it was settled already (the sweep called it unknown). */
export async function settlePeopleMessage(
  db: Database,
  input: { id: number; state: "sent" | "failed" | "unknown"; telegramMessageId: number | null; error: string | null; at: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update people_messages set state = ${input.state}, telegram_message_id = ${input.telegramMessageId}, error = ${input.error},
      settled_at = ${input.at.toISOString()}::timestamptz
    where id = ${input.id} and state = 'sending'`);
  return (result.rowCount ?? 0) > 0;
}

/** An attempt that never settled (the process died under it) is `unknown`: whether it left is not known, it is not repeated. */
export async function markStalePeopleMessagesUnknown(db: Database, input: { attemptedBefore: Date; at: Date }): Promise<number> {
  const result = await db.execute(sql`
    update people_messages set state = 'unknown', settled_at = ${input.at.toISOString()}::timestamptz,
      error = 'the attempt did not settle: whether it left is not known'
    where state = 'sending' and attempted_at < ${input.attemptedBefore.toISOString()}::timestamptz`);
  return result.rowCount ?? 0;
}

/**
 * What counts against a recipient's cap of a kind in a window: the messages that left or would have left (held only
 * because the kind is off or there is no token). A held message the recipient could never get does not count.
 */
export async function countPeopleMessagesForCap(
  db: Database,
  input: { kind: string; recipient: { userId: number } | { chatId: string; topicId: number | null }; from: Date; to: Date },
): Promise<number> {
  const who = "userId" in input.recipient
    ? sql`recipient = 'person' and recipient_user_id = ${input.recipient.userId}`
    : sql`recipient = 'chat' and telegram_chat_id = ${input.recipient.chatId} and telegram_topic_id is not distinct from ${input.recipient.topicId}`;
  const result = await db.execute<Row>(sql`
    select count(*)::int as n from people_messages
    where kind = ${input.kind} and ${who}
      and created_at >= ${input.from.toISOString()}::timestamptz and created_at < ${input.to.toISOString()}::timestamptz
      and (state <> 'held' or held_reason in ('kind_off', 'no_token'))`);
  return Number(result.rows[0]?.n ?? 0);
}

/** Per kind and state, the messages made since `since`. */
export async function countPeopleMessagesByKind(db: Database, since: Date): Promise<Map<string, Map<PeopleMessageStateRow, number>>> {
  const result = await db.execute<Row>(sql`
    select kind, state, count(*)::int as n from people_messages where created_at >= ${since.toISOString()}::timestamptz group by kind, state`);
  const out = new Map<string, Map<PeopleMessageStateRow, number>>();
  for (const row of result.rows) {
    const kind = String(row.kind);
    const states = out.get(kind) ?? new Map<PeopleMessageStateRow, number>();
    states.set(String(row.state) as PeopleMessageStateRow, Number(row.n));
    out.set(kind, states);
  }
  return out;
}

/** The newest held messages of a kind since `since`. */
export async function listHeldPeopleMessages(db: Database, input: { kind: string; since: Date; limit: number }): Promise<PeopleMessageRow[]> {
  const result = await db.execute<Row>(sql`
    select ${COLUMNS} from people_messages
    where kind = ${input.kind} and state = 'held' and created_at >= ${input.since.toISOString()}::timestamptz
    order by created_at desc, id desc limit ${input.limit}`);
  return result.rows.map(messageOf);
}

/** The newest message of a kind, any state (the example of a kind sent by a press). */
export async function findNewestPeopleMessage(db: Database, kind: string): Promise<PeopleMessageRow | null> {
  const result = await db.execute<Row>(sql`select ${COLUMNS} from people_messages where kind = ${kind} order by created_at desc, id desc limit 1`);
  return result.rows[0] === undefined ? null : messageOf(result.rows[0]);
}

// ── The facts that fire the kinds ────────────────────────────────────────────

/** The handed-in reports' newest versions submitted in the window: each the report's current version. */
export async function listCurrentHandinVersionsSubmitted(
  db: Database,
  input: { from: Date; to: Date; limit: number },
): Promise<Array<{ versionId: number; shiftId: number; version: number; userId: number; submittedAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select v.id, h.shift_id, v.version, h.user_id, v.submitted_at
    from shift_handin_versions v
    join shift_handins h on h.id = v.handin_id and h.current_version = v.version
    where v.submitted_at >= ${input.from.toISOString()}::timestamptz and v.submitted_at < ${input.to.toISOString()}::timestamptz
    order by v.id
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    versionId: Number(row.id), shiftId: Number(row.shift_id), version: Number(row.version), userId: Number(row.user_id), submittedAt: date(row.submitted_at)!,
  }));
}

/** The newest handed-in report's current version (the example of the report's copy). */
export async function findNewestCurrentHandinVersion(db: Database): Promise<{ versionId: number; shiftId: number; version: number; submittedAt: Date } | null> {
  const result = await db.execute<Row>(sql`
    select v.id, h.shift_id, v.version, v.submitted_at
    from shift_handin_versions v join shift_handins h on h.id = v.handin_id and h.current_version = v.version
    order by v.submitted_at desc, v.id desc limit 1`);
  const row = result.rows[0];
  return row === undefined ? null : { versionId: Number(row.id), shiftId: Number(row.shift_id), version: Number(row.version), submittedAt: date(row.submitted_at)! };
}

/** The orders the lead moved to «У модели» in the window without naming a Telegram card: the card is not in the group yet. */
export async function listCustomOrdersMovedToModel(db: Database, input: { from: Date; to: Date; limit: number }): Promise<Array<{ orderId: number; at: Date }>> {
  const result = await db.execute<Row>(sql`
    select e.object_id, e.created_at from object_events e
    where e.object_type = 'custom_order' and e.event = 'custom_order.at_model' and (e.changes ->> 'telegramRef') is null
      and e.created_at >= ${input.from.toISOString()}::timestamptz and e.created_at < ${input.to.toISOString()}::timestamptz
    order by e.created_at limit ${input.limit}`);
  return result.rows.map((row) => ({ orderId: Number(row.object_id), at: date(row.created_at)! }));
}

/** The newest order (the example of the card). */
export async function findNewestCustomOrderId(db: Database): Promise<number | null> {
  const result = await db.execute<Row>(sql`select id from custom_orders order by created_at desc, id desc limit 1`);
  return result.rows[0] === undefined ? null : Number(result.rows[0].id);
}

/** The newest matter of a kind, open or closed (the example of a reminder). */
export async function findNewestMatterKeyOfKind(db: Database, kind: string): Promise<string | null> {
  const result = await db.execute<Row>(sql`select key from matters where kind = ${kind} order by opened_at desc, id desc limit 1`);
  return result.rows[0] === undefined ? null : String(result.rows[0].key);
}

// ── To whom ──────────────────────────────────────────────────────────────────

export interface PeopleMessagePerson {
  userId: number;
  personCode: string | null;
  /** The person's registry name, else the login. */
  name: string;
  telegramUserId: number | null;
}

/** The people of logins: their name and Telegram id from the registry (a login nobody's has none). */
export async function listPeopleMessagePersons(db: Database, userIds: readonly number[]): Promise<Map<number, PeopleMessagePerson>> {
  const out = new Map<number, PeopleMessagePerson>();
  if (userIds.length === 0) return out;
  const result = await db.execute<Row>(sql`
    select u.id, p.code, coalesce(p.display_name, u.username) as name, p.telegram_user_id
    from users u left join person_logins pl on pl.user_id = u.id left join people p on p.id = pl.person_id
    where u.id = any(${ids(userIds)})`);
  for (const row of result.rows) {
    out.set(Number(row.id), { userId: Number(row.id), personCode: text(row.code), name: String(row.name), telegramUserId: num(row.telegram_user_id) });
  }
  return out;
}

/** A person by registry code, else by a login's username (the ledger's slug): their first login, name and Telegram id. */
export async function findPeopleMessagePersonByCode(db: Database, code: string): Promise<PeopleMessagePerson | null> {
  const result = await db.execute<Row>(sql`
    select (select min(pl.user_id) from person_logins pl where pl.person_id = p.id) as user_id, p.code, p.display_name, p.telegram_user_id
    from people p where p.code = ${code}
    union all
    select u.id, p.code, coalesce(p.display_name, u.username), p.telegram_user_id
    from users u left join person_logins pl on pl.user_id = u.id left join people p on p.id = pl.person_id
    where u.username = ${code} and not exists (select 1 from people p2 where p2.code = ${code})
    limit 1`);
  const row = result.rows[0];
  if (row === undefined || row.user_id === null) return null;
  return { userId: Number(row.user_id), personCode: text(row.code), name: String(row.display_name), telegramUserId: num(row.telegram_user_id) };
}

/**
 * Why Telegram refused the person's newest send, when it did and nothing went to them after: `never_wrote` (the bot
 * cannot start a conversation) or `blocked`. The transport writes the refusal as the error's prefix.
 */
export async function findPeopleMessageRefusal(db: Database, userId: number): Promise<"never_wrote" | "blocked" | null> {
  const result = await db.execute<Row>(sql`
    select state, error from people_messages
    where recipient = 'person' and recipient_user_id = ${userId} and state in ('sent', 'failed')
    order by id desc limit 1`);
  const row = result.rows[0];
  if (row === undefined || row.state !== "failed") return null;
  const error = text(row.error) ?? "";
  return error.startsWith("never_wrote:") ? "never_wrote" : error.startsWith("blocked:") ? "blocked" : null;
}

/** The models by slug, for the chats' words. */
export async function listPeopleMessageModels(db: Database): Promise<Array<{ slug: string; name: string }>> {
  const result = await db.execute<Row>(sql`select slug, name from models order by sort_order asc, slug asc`);
  return result.rows.map((row) => ({ slug: String(row.slug), name: String(row.name) }));
}
