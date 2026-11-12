import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The shift report as an object of Hub (0400; ecosystem plan 2026-11-12,
// package F): one report per shift row, the person's draft edits saved as
// made, the immutable submitted versions, and «мимо площадки». Raw SQL: the
// tables are the migration's alone. Nothing here writes the old
// `shift_reports` / `shift_report_*` tables (0311, 0318). A version is never
// changed (the database refuses it); a draft's mark is replaced by
// the person's own edit (an empty one stays an empty row); an off-platform line is withdrawn. Nothing is deleted.

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const nullableNum = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown) => (value === null || value === undefined ? null : date(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
  return [];
}

// ── The shift ────────────────────────────────────────────────────────────────

export interface HandinShift {
  id: number;
  userId: number;
  state: "going" | "closed" | "dropped" | "merged";
  startedAt: Date;
  endedAt: Date;
  workedMinutes: number;
  reportDate: string;
  pages: Array<{ pageLabel: string; activeMinutes: number; messages: number; salesFrom: string | null }>;
  mergedInto: number | null;
}

const SHIFT_SELECT = sql`select id, user_id, state, started_at, ended_at, worked_minutes, to_char(report_date, 'YYYY-MM-DD') as report_date,
  pages, merged_into from shifts`;

function shiftOf(row: Row): HandinShift {
  return {
    id: num(row.id),
    userId: num(row.user_id),
    state: row.state as HandinShift["state"],
    startedAt: date(row.started_at),
    endedAt: date(row.ended_at),
    workedMinutes: num(row.worked_minutes),
    reportDate: String(row.report_date),
    pages: jsonArray<HandinShift["pages"][number]>(row.pages),
    mergedInto: nullableNum(row.merged_into),
  };
}

/** A shift row by id; a merged one resolves to the shift it joined. Null — none. */
export async function findHandinShift(db: Database, shiftId: number): Promise<HandinShift | null> {
  let found = await db.execute<Row>(sql`${SHIFT_SELECT} where id = ${shiftId}`);
  let shift = found.rows[0] === undefined ? null : shiftOf(found.rows[0]);
  for (let hops = 0; shift !== null && shift.mergedInto !== null && hops < 10; hops += 1) {
    found = await db.execute<Row>(sql`${SHIFT_SELECT} where id = ${shift.mergedInto}`);
    shift = found.rows[0] === undefined ? null : shiftOf(found.rows[0]);
  }
  return shift;
}

/** The living shift rows (going, closed) of the logins that began in [from, to), oldest first. */
export async function listHandinShifts(db: Database, input: { userIds: readonly number[]; from: Date; to: Date }): Promise<HandinShift[]> {
  if (input.userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`${SHIFT_SELECT}
    where user_id = any(${ids(input.userIds)}) and state in ('going', 'closed')
      and started_at >= ${input.from.toISOString()}::timestamptz and started_at < ${input.to.toISOString()}::timestamptz
    order by started_at, id`);
  return result.rows.map(shiftOf);
}

/** The person's latest living shift that began before `before`: the one an agent's /smena means. Null — none. */
export async function findLatestHandinShift(db: Database, input: { userIds: readonly number[]; before: Date }): Promise<HandinShift | null> {
  if (input.userIds.length === 0) return null;
  const result = await db.execute<Row>(sql`${SHIFT_SELECT}
    where user_id = any(${ids(input.userIds)}) and state in ('going', 'closed') and started_at < ${input.before.toISOString()}::timestamptz
    order by started_at desc, id desc limit 1`);
  return result.rows[0] === undefined ? null : shiftOf(result.rows[0]);
}

// ── The report ───────────────────────────────────────────────────────────────

export type HandinState = "open" | "submitted";

export interface HandinRow {
  id: number;
  shiftId: number;
  userId: number;
  personId: number | null;
  reportDate: string;
  state: HandinState;
  comment: string;
  currentVersion: number | null;
  submittedAt: Date | null;
  draftUpdatedAt: Date | null;
}

const HANDIN_COLUMNS = sql`h.id, h.shift_id, h.user_id, h.person_id, to_char(h.report_date, 'YYYY-MM-DD') as report_date, h.state, h.comment,
  h.current_version, h.submitted_at, h.draft_updated_at`;

function handinOf(row: Row): HandinRow {
  return {
    id: num(row.id),
    shiftId: num(row.shift_id),
    userId: num(row.user_id),
    personId: nullableNum(row.person_id),
    reportDate: String(row.report_date),
    state: row.state as HandinState,
    comment: String(row.comment ?? ""),
    currentVersion: nullableNum(row.current_version),
    submittedAt: nullableDate(row.submitted_at),
    draftUpdatedAt: nullableDate(row.draft_updated_at),
  };
}

/** The report of a shift; `lock` takes it for a write (the order: shift_handins → its children). */
export async function findHandinByShift(db: Database, shiftId: number, options: { lock?: boolean } = {}): Promise<HandinRow | null> {
  const result = await db.execute<Row>(sql`
    select ${HANDIN_COLUMNS} from shift_handins h where h.shift_id = ${shiftId} ${options.lock ? sql`for update` : sql``}`);
  return result.rows[0] === undefined ? null : handinOf(result.rows[0]);
}

/** The report of a shift, made the first time anyone writes to it (two doors at once make one row). */
export async function ensureHandin(
  db: Database,
  input: { shiftId: number; userId: number; personId: number | null; reportDate: string },
): Promise<HandinRow> {
  await db.execute(sql`
    insert into shift_handins (shift_id, user_id, person_id, report_date)
    values (${input.shiftId}, ${input.userId}, ${input.personId}, ${input.reportDate}::date)
    on conflict (shift_id) do nothing`);
  const found = await findHandinByShift(db, input.shiftId, { lock: true });
  if (found === null) throw new Error(`shift_handins: the report of shift ${input.shiftId} is missing after its insert`);
  return found;
}

/** The reports of the shifts named, by shift id. */
export async function listHandinsOfShifts(db: Database, shiftIds: readonly number[]): Promise<Map<number, HandinRow>> {
  if (shiftIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`select ${HANDIN_COLUMNS} from shift_handins h where h.shift_id = any(${ids(shiftIds)})`);
  return new Map(result.rows.map((row) => {
    const handin = handinOf(row);
    return [handin.shiftId, handin];
  }));
}

export async function setHandinComment(db: Database, input: { handinId: number; comment: string; at: Date }): Promise<void> {
  await db.execute(sql`
    update shift_handins set comment = ${input.comment}, draft_updated_at = ${input.at.toISOString()}::timestamptz,
      updated_at = clock_timestamp()
    where id = ${input.handinId}`);
}

async function touchDraft(db: Database, handinId: number, at: Date) {
  await db.execute(sql`
    update shift_handins set draft_updated_at = ${at.toISOString()}::timestamptz, updated_at = clock_timestamp() where id = ${handinId}`);
}

// ── The draft's marks ────────────────────────────────────────────────────────

export type HandinStatement = "mine" | "not_mine" | "share";

export interface HandinMarkRow {
  transactionId: number;
  statement: HandinStatement | null;
  shareWithUserId: number | null;
  note: string | null;
  updatedAt: Date;
}

export async function listHandinMarks(db: Database, handinId: number): Promise<HandinMarkRow[]> {
  const result = await db.execute<Row>(sql`
    select transaction_id, statement, share_with_user_id, note, updated_at
    from shift_handin_marks where handin_id = ${handinId} order by transaction_id`);
  return result.rows.map((row) => ({
    transactionId: num(row.transaction_id),
    statement: (row.statement ?? null) as HandinStatement | null,
    shareWithUserId: nullableNum(row.share_with_user_id),
    note: text(row.note),
    updatedAt: date(row.updated_at),
  }));
}

/**
 * What the person says of one sale: the statement and the note together. Neither — the line is back to the rule's
 * word (the row stays, empty: nothing here deletes; the record is the submitted version).
 */
export async function setHandinMark(
  db: Database,
  input: {
    handinId: number;
    transactionId: number;
    statement: HandinStatement | null;
    shareWithUserId: number | null;
    note: string | null;
    byUserId: number | null;
    byAgentKeyId: number | null;
    at: Date;
  },
): Promise<void> {
  {
    await db.execute(sql`
      insert into shift_handin_marks (handin_id, transaction_id, statement, share_with_user_id, note, updated_at, updated_by_user_id, updated_by_agent_key_id)
      values (${input.handinId}, ${input.transactionId}, ${input.statement}, ${input.shareWithUserId}, ${input.note},
        ${input.at.toISOString()}::timestamptz, ${input.byUserId}, ${input.byAgentKeyId})
      on conflict (handin_id, transaction_id) do update set
        statement = excluded.statement, share_with_user_id = excluded.share_with_user_id, note = excluded.note,
        updated_at = excluded.updated_at, updated_by_user_id = excluded.updated_by_user_id,
        updated_by_agent_key_id = excluded.updated_by_agent_key_id`);
  }
  await touchDraft(db, input.handinId, input.at);
}

// ── «Мимо площадки» ──────────────────────────────────────────────────────────

export type OffPlatformState = "pending" | "confirmed" | "rejected" | "withdrawn";

export interface OffPlatformRow {
  id: number;
  handinId: number;
  userId: number;
  amountMills: number;
  fromWhom: string;
  whatFor: string;
  state: OffPlatformState;
  createdAt: Date;
  /** The page a confirmed amount counts on (0404); null — not decided, or decided before pages were named. */
  pageId: number | null;
  decidedAt: Date | null;
  decidedNote: string | null;
}

function offPlatformOf(row: Row): OffPlatformRow {
  return {
    id: num(row.id),
    handinId: num(row.handin_id),
    userId: num(row.user_id),
    amountMills: num(row.amount_mills),
    fromWhom: String(row.from_whom),
    whatFor: String(row.what_for),
    state: row.state as OffPlatformState,
    createdAt: date(row.created_at),
    pageId: nullableNum(row.page_id),
    decidedAt: nullableDate(row.decided_at),
    decidedNote: text(row.decided_note),
  };
}

const OFF_PLATFORM_COLUMNS = sql`id, handin_id, user_id, amount_mills, from_whom, what_for, state, created_at, page_id, decided_at, decided_note`;

/** The report's off-platform lines, oldest first, the withdrawn ones left out. */
export async function listOffPlatform(db: Database, handinId: number): Promise<OffPlatformRow[]> {
  const result = await db.execute<Row>(sql`
    select ${OFF_PLATFORM_COLUMNS}
    from off_platform_sales where handin_id = ${handinId} and state <> 'withdrawn' order by id`);
  return result.rows.map(offPlatformOf);
}

export async function insertOffPlatform(
  db: Database,
  input: { handinId: number; userId: number; amountMills: number; fromWhom: string; whatFor: string; byUserId: number | null; byAgentKeyId: number | null; at: Date },
): Promise<OffPlatformRow> {
  const result = await db.execute<Row>(sql`
    insert into off_platform_sales (handin_id, user_id, amount_mills, from_whom, what_for, created_at, created_by_user_id, created_by_agent_key_id)
    values (${input.handinId}, ${input.userId}, ${input.amountMills}, ${input.fromWhom}, ${input.whatFor}, ${input.at.toISOString()}::timestamptz,
      ${input.byUserId}, ${input.byAgentKeyId})
    returning ${OFF_PLATFORM_COLUMNS}`);
  await touchDraft(db, input.handinId, input.at);
  return offPlatformOf(result.rows[0]!);
}

/** Withdraws a pending line of the report; false — none such (another report's, decided, already withdrawn). */
export async function withdrawOffPlatform(db: Database, input: { handinId: number; id: number; at: Date }): Promise<boolean> {
  const result = await db.execute(sql`
    update off_platform_sales set state = 'withdrawn'
    where id = ${input.id} and handin_id = ${input.handinId} and state = 'pending'`);
  if ((result.rowCount ?? 0) === 0) return false;
  await touchDraft(db, input.handinId, input.at);
  return true;
}

// ── Versions ─────────────────────────────────────────────────────────────────

export type HandinDoor = "extension" | "workboard" | "telegram";

/** One line of a submitted version, as stored (no fan's name: the fan is the transaction's). */
export interface HandinVersionLine {
  /** Hub's `transactions.id`; null — an off-platform line (`offPlatformId`). */
  transactionId: number | null;
  offPlatformId: number | null;
  /** mine — the person's by the rule (or the person's «долёт»); near — on the shift's pages, not the person's by the rule. */
  group: "mine" | "near";
  pageLabel: string | null;
  kind: string;
  occurredAt: string | null;
  netMills: number;
  /** The rule's home, why, the person's share by it, whose it is when not the person's, the bought PPV's sender. */
  rule: { home: string; reason: string; shareMills: number; toUserId: number | null; senderUserId: number | null };
  /** Another report of the person held it when this was submitted: it counted 0 here. */
  alreadyIn: { shiftId: number; reportDate: string } | null;
  statement: HandinStatement | null;
  shareWithUserId: number | null;
  note: string | null;
  amountMills: number;
  /** Outside the shift's window, added to it: a sale of the last 7 days no report of the person held («долёт»). */
  added: boolean;
  /**
   * «Моё» on a sale the rule or another person's report gives to someone else: it counts nothing (`amountMills` 0) until
   * the other side or the owner settles it, and `claimedMills` says what it claims (review R2b-2).
   */
  disputed: boolean;
  /** What a disputed line claims (the sale's net); absent — not disputed. */
  claimedMills?: number;
  /** A claim on it settled (0404): the other side agreed, or the owner decided; the amount is what that gives. Absent — not settled. */
  settled?: "agreed" | "owner";
}

export interface HandinVersionPage {
  pageLabel: string;
  amountMills: number;
}

export interface HandinVersionOffPlatform {
  id: number;
  amountMills: number;
  fromWhom: string;
  whatFor: string;
  state: OffPlatformState;
  /** A confirmed amount's page: it counts in that page's sum (0404). Absent — none. */
  pageLabel?: string | null;
}

/**
 * Why the system made a version on someone's decision (0404): a claim settled — agreed by the other side or decided by
 * the owner — or the owner's word on «мимо площадки». Null — the person handed it in.
 */
export type HandinVersionMadeFor =
  | { kind: "claim"; claimId: number; transactionId: number; outcome: "agreed" | "first" | "second" | "half" | "nobody" }
  | { kind: "off_platform"; offPlatformId: number; decision: "confirmed" | "rejected" }
  /** A decision about the sale recorded «со слов» through the agent's door (review R2b-3). */
  | { kind: "decision"; decisionId: number; transactionId: number; outcome: "said" };

export interface HandinVersionRow {
  id: number;
  handinId: number;
  version: number;
  submittedAt: Date;
  door: HandinDoor;
  actorUserId: number | null;
  agentKeyId: number | null;
  telegramMessageRef: string | null;
  telegramSenderId: number | null;
  totalMills: number;
  pages: HandinVersionPage[];
  lines: HandinVersionLine[];
  offPlatform: HandinVersionOffPlatform[];
  comment: string;
  dayPaid: boolean | null;
  ruleVersion: string;
  /** Made by the system on a decision; null — handed in by the person. */
  madeFor: HandinVersionMadeFor | null;
  /** The shift's report date when this version was made (0407); null — a version older than the column. */
  reportDate: string | null;
}

const VERSION_COLUMNS = sql`v.id, v.handin_id, v.version, v.submitted_at, v.door, v.actor_user_id, v.agent_key_id, v.telegram_message_ref,
  v.telegram_sender_id, v.total_mills, v.pages, v.lines, v.off_platform, v.comment, v.day_paid, v.rule_version, v.made_for,
  to_char(v.report_date, 'YYYY-MM-DD') as version_report_date`;

function versionOf(row: Row): HandinVersionRow {
  return {
    id: num(row.id),
    handinId: num(row.handin_id),
    version: num(row.version),
    submittedAt: date(row.submitted_at),
    door: row.door as HandinDoor,
    actorUserId: nullableNum(row.actor_user_id),
    agentKeyId: nullableNum(row.agent_key_id),
    telegramMessageRef: text(row.telegram_message_ref),
    telegramSenderId: nullableNum(row.telegram_sender_id),
    totalMills: num(row.total_mills),
    pages: jsonArray<HandinVersionPage>(row.pages),
    lines: jsonArray<HandinVersionLine>(row.lines),
    offPlatform: jsonArray<HandinVersionOffPlatform>(row.off_platform),
    comment: String(row.comment ?? ""),
    dayPaid: row.day_paid === null || row.day_paid === undefined ? null : Boolean(row.day_paid),
    ruleVersion: String(row.rule_version),
    madeFor: madeForOf(row.made_for),
    reportDate: text(row.version_report_date),
  };
}

function madeForOf(value: unknown): HandinVersionMadeFor | null {
  if (value === null || value === undefined) return null;
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return typeof parsed === "object" && parsed !== null && "kind" in parsed ? (parsed as HandinVersionMadeFor) : null;
}

/**
 * A new version of the report, the next number after its current one; the report becomes `submitted` with it. Run in
 * the caller's transaction after `findHandinByShift(…, { lock: true })`: two submissions never take one number.
 */
export async function insertHandinVersion(
  db: Database,
  input: {
    handin: HandinRow;
    door: HandinDoor;
    actorUserId: number | null;
    agentKeyId: number | null;
    telegramMessageRef: string | null;
    telegramSenderId: number | null;
    totalMills: number;
    pages: readonly HandinVersionPage[];
    lines: readonly HandinVersionLine[];
    offPlatform: readonly HandinVersionOffPlatform[];
    comment: string;
    dayPaid: boolean | null;
    ruleVersion: string;
    /** Made by the system on a decision (0404); absent — the person handed it in. */
    madeFor?: HandinVersionMadeFor | null;
    /** The shift's report date now (`shifts.report_date`): the version's, and the report's from now on. */
    reportDate: string;
    at: Date;
  },
): Promise<HandinVersionRow> {
  const version = (input.handin.currentVersion ?? 0) + 1;
  const at = input.at.toISOString();
  const madeFor = input.madeFor == null ? null : JSON.stringify(input.madeFor);
  const result = await db.execute<Row>(sql`
    insert into shift_handin_versions (handin_id, version, submitted_at, door, actor_user_id, agent_key_id, telegram_message_ref,
      telegram_sender_id, total_mills, pages, lines, off_platform, comment, day_paid, rule_version, made_for, report_date)
    values (${input.handin.id}, ${version}, ${at}::timestamptz, ${input.door}, ${input.actorUserId}, ${input.agentKeyId},
      ${input.telegramMessageRef}, ${input.telegramSenderId}, ${input.totalMills}, ${JSON.stringify(input.pages)}::jsonb,
      ${JSON.stringify(input.lines)}::jsonb, ${JSON.stringify(input.offPlatform)}::jsonb, ${input.comment}, ${input.dayPaid},
      ${input.ruleVersion}, ${madeFor}::jsonb, ${input.reportDate}::date)
    returning id, handin_id, version, submitted_at, door, actor_user_id, agent_key_id, telegram_message_ref,
      telegram_sender_id, total_mills, pages, lines, off_platform, comment, day_paid, rule_version, made_for,
      to_char(report_date, 'YYYY-MM-DD') as version_report_date`);
  // The report's date is its newest version's: the one place every reader takes it from once it is handed in.
  await db.execute(sql`
    update shift_handins set state = 'submitted', current_version = ${version}, submitted_at = ${at}::timestamptz,
      report_date = ${input.reportDate}::date, updated_at = clock_timestamp()
    where id = ${input.handin.id}`);
  return versionOf(result.rows[0]!);
}

/** Every version of the report, oldest first. */
export async function listHandinVersions(db: Database, handinId: number): Promise<HandinVersionRow[]> {
  const result = await db.execute<Row>(sql`select ${VERSION_COLUMNS} from shift_handin_versions v where v.handin_id = ${handinId} order by v.version`);
  return result.rows.map(versionOf);
}

/** The newest version of each report named, by report id. */
export async function listCurrentHandinVersions(db: Database, handinIds: readonly number[]): Promise<Map<number, HandinVersionRow>> {
  if (handinIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select ${VERSION_COLUMNS} from shift_handin_versions v join shift_handins h on h.id = v.handin_id and h.current_version = v.version
    where v.handin_id = any(${ids(handinIds)})`);
  return new Map(result.rows.map((row) => {
    const version = versionOf(row);
    return [version.handinId, version];
  }));
}

/**
 * The sales a person's reports hold now: every sale line of the newest version of each submitted report of the
 * person's logins whose report date is `since` or later, by transaction id — which report holds it.
 */
export async function listReportedSales(
  db: Database,
  input: { userIds: readonly number[]; since: string },
): Promise<Map<number, { handinId: number; shiftId: number; reportDate: string }>> {
  if (input.userIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select (line ->> 'transactionId')::bigint as transaction_id, h.id as handin_id, h.shift_id, to_char(h.report_date, 'YYYY-MM-DD') as report_date
    from shift_handins h
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    cross join lateral jsonb_array_elements(v.lines) as line
    where h.user_id = any(${ids(input.userIds)}) and h.state = 'submitted' and h.report_date >= ${input.since}::date
      and line ->> 'transactionId' is not null
    order by h.submitted_at`);
  const out = new Map<number, { handinId: number; shiftId: number; reportDate: string }>();
  for (const row of result.rows) {
    out.set(num(row.transaction_id), { handinId: num(row.handin_id), shiftId: num(row.shift_id), reportDate: String(row.report_date) });
  }
  return out;
}

/** The ledger's feed: versions made after the cursor (`afterId`), oldest first, settled for `settleSeconds` at least. */
/**
 * The ledger's feed order (0405, review R2-b): every version committed and not placed yet gets its place, after every
 * place given before, in id order, one read at a time (an advisory lock). A version whose transaction commits later is
 * invisible now and is placed by a later read, after every place given now: a cursor of places never passes a version
 * the feed has not served. Returns how many were placed.
 */
export async function placeHandinVersionsInFeed(db: Database): Promise<number> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('shift_handin_feed', 0))`);
    const placed = await tx.execute(sql`
      insert into shift_handin_feed (seq, version_id)
      select (select coalesce(max(seq), 0) from shift_handin_feed) + row_number() over (order by v.id), v.id
      from shift_handin_versions v
      where not exists (select 1 from shift_handin_feed f where f.version_id = v.id)
      order by v.id`);
    return Number((placed as { rowCount?: number | null }).rowCount ?? 0);
  });
}

/** The versions placed after a place of the feed, in the feed's order, those with a line off the pages left out. */
export async function listHandinVersionsAfter(
  db: Database,
  input: { afterSeq: number; limit: number; pageIds: readonly number[] },
): Promise<Array<HandinVersionRow & { seq: number; shiftId: number; userId: number; personCode: string | null; reportDate: string }>> {
  const result = await db.execute<Row>(sql`
    select ${VERSION_COLUMNS}, f.seq, h.shift_id, h.user_id, p.code as person_code,
      to_char(coalesce(v.report_date, h.report_date), 'YYYY-MM-DD') as report_date
    from shift_handin_feed f
    join shift_handin_versions v on v.id = f.version_id
    join shift_handins h on h.id = v.handin_id
    left join people p on p.id = h.person_id
    where f.seq > ${input.afterSeq}
      and not exists (
        select 1 from jsonb_array_elements(v.lines) as line
        join pages pg on pg.label = line ->> 'pageLabel'
        where not (pg.id = any(${ids(input.pageIds)}))
      )
    order by f.seq
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    ...versionOf(row),
    seq: num(row.seq),
    shiftId: num(row.shift_id),
    userId: num(row.user_id),
    personCode: text(row.person_code),
    reportDate: String(row.report_date),
  }));
}

// ── Who the report is of ─────────────────────────────────────────────────────

export interface HandinPerson {
  personId: number;
  code: string;
  displayName: string;
  kind: string;
  role: string;
  state: string;
  reportTag: string | null;
  telegramUserId: number | null;
  /** When the switch «сдаёт смену в системе» was turned on; null — off. */
  submitsShiftSince: Date | null;
  /** The person has pay terms (any model): a person whose shifts are paid. */
  hasPayTerms: boolean;
  /** Every login of the person. */
  userIds: number[];
}

/** The person of a login with the switch and what the checks need; null — the login belongs to no person. */
export async function findHandinPersonOfUser(db: Database, userId: number): Promise<HandinPerson | null> {
  const found = await listHandinPeopleOfUsers(db, [userId]);
  return found.get(userId) ?? null;
}

/** The person of each login named, by login. */
export async function listHandinPeopleOfUsers(db: Database, userIds: readonly number[]): Promise<Map<number, HandinPerson>> {
  if (userIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select l.user_id, p.id as person_id, p.code, p.display_name, p.kind, p.role, p.state, p.report_tag, p.telegram_user_id,
      (select r.granted_at from person_rights r where r.person_id = p.id and r."right" = 'submits_shift') as submits_since,
      exists (select 1 from person_pay_terms t where t.person_id = p.id) as has_pay_terms,
      (select array_agg(o.user_id order by o.user_id) from person_logins o where o.person_id = p.id) as user_ids
    from person_logins l join people p on p.id = l.person_id
    where l.user_id = any(${ids(userIds)})`);
  const out = new Map<number, HandinPerson>();
  for (const row of result.rows) {
    out.set(num(row.user_id), {
      personId: num(row.person_id),
      code: String(row.code),
      displayName: String(row.display_name),
      kind: String(row.kind),
      role: String(row.role),
      state: String(row.state),
      reportTag: text(row.report_tag),
      telegramUserId: nullableNum(row.telegram_user_id),
      submitsShiftSince: nullableDate(row.submits_since),
      hasPayTerms: Boolean(row.has_pay_terms),
      userIds: jsonArray<unknown>(row.user_ids).map(Number),
    });
  }
  return out;
}

/** A person by code or Telegram id, with their logins: who an agent writes for. */
export async function findHandinPersonBy(
  db: Database,
  input: { code?: string; telegramUserId?: number },
): Promise<{ personId: number; userIds: number[] } | null> {
  const where = input.code !== undefined ? sql`p.code = ${input.code}` : sql`p.telegram_user_id = ${input.telegramUserId ?? -1}`;
  const result = await db.execute<Row>(sql`
    select p.id, (select array_agg(o.user_id order by o.user_id) from person_logins o where o.person_id = p.id) as user_ids
    from people p where ${where} limit 1`);
  const row = result.rows[0];
  if (row === undefined) return null;
  return { personId: num(row.id), userIds: jsonArray<unknown>(row.user_ids).map(Number) };
}

/** Display names of logins: the person's name when the login has one, else the login. */
export async function listHandinNames(db: Database, userIds: readonly number[]): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select u.id, coalesce(p.display_name, u.username) as name
    from users u left join person_logins l on l.user_id = u.id left join people p on p.id = l.person_id
    where u.id = any(${ids([...new Set(userIds)])})`);
  return new Map(result.rows.map((row) => [num(row.id), String(row.name)]));
}

/**
 * The people a «делим с…» may name: the living chatters and team leads who may open any of the pages, the person's own
 * logins left out, by name.
 */
export async function listHandinColleagues(
  db: Database,
  input: { pageIds: readonly number[]; exceptUserIds: readonly number[] },
): Promise<Array<{ userId: number; name: string }>> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select distinct u.id, coalesce(p.display_name, u.username) as name
    from user_page_assignments a
    join users u on u.id = a.user_id
    left join person_logins l on l.user_id = u.id
    left join people p on p.id = l.person_id
    where a.platform_account_id = any(${ids(input.pageIds)})
      and u.deleted_at is null and u.disabled_at is null and u.role in ('chatter', 'team_lead')
      and not (u.id = any(${ids(input.exceptUserIds)}))
      and (p.id is null or (p.kind = 'human' and p.state <> 'left'))
    order by name`);
  return result.rows.map((row) => ({ userId: num(row.id), name: String(row.name) }));
}

/** The names of agent keys (a version handed in «со слов»). */
export async function listHandinAgentKeyNames(db: Database, keyIds: readonly number[]): Promise<Map<number, string>> {
  if (keyIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`select id, name from agent_keys where id = any(${ids([...new Set(keyIds)])})`);
  return new Map(result.rows.map((row) => [num(row.id), String(row.name)]));
}

// ── The fans of sales (names are read live: a version keeps none) ───────────

export interface HandinSaleFan {
  fanRef: string | null;
  name: string | null;
  username: string | null;
}

export async function listHandinSaleFans(db: Database, transactionIds: readonly number[]): Promise<Map<number, HandinSaleFan>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select t.id, f.platform_user_id as fan_ref, coalesce(f.display_name, f.username) as name, f.username
    from transactions t left join fans f on f.id = t.fan_id
    where t.id = any(${ids([...new Set(transactionIds)])})`);
  return new Map(result.rows.map((row) => [num(row.id), { fanRef: text(row.fan_ref), name: text(row.name), username: text(row.username) }]));
}

/** The canonical kind of each sale (message_purchase, tip, …): a stored line keeps the rule's kind word. */
export async function listHandinSaleKinds(db: Database, transactionIds: readonly number[]): Promise<Map<number, string>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select id, canonical_type::text as kind from transactions where id = any(${ids([...new Set(transactionIds)])})`);
  return new Map(result.rows.map((row) => [num(row.id), String(row.kind)]));
}

// ── The facts a line's «почему» shows (the same facts the rule reads, exposed) ──

/** Who last wrote to each sale's fan on its page before it, within `days`, and when; a sale with none is left out. */
export async function listHandinLastWrites(
  db: Database,
  input: { sales: ReadonlyArray<{ transactionId: number; pageId: number; fanRef: string; at: Date }>; days: number },
): Promise<Map<number, { userId: number; at: Date }>> {
  if (input.sales.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select s.id as transaction_id, w.user_id, w.observed_at
    from unnest(
      ${sql.param(input.sales.map((sale) => String(sale.transactionId)))}::bigint[],
      ${sql.param(input.sales.map((sale) => String(sale.pageId)))}::bigint[],
      ${sql.param(input.sales.map((sale) => sale.fanRef))}::text[],
      ${sql.param(input.sales.map((sale) => sale.at.toISOString()))}::timestamptz[]
    ) as s(id, page_id, fan_ref, at)
    join lateral (
      select a.user_id, a.observed_at from client_send_attributions a
      where a.page_id = s.page_id and a.fan_ref = s.fan_ref
        and a.observed_at <= s.at and a.observed_at > s.at - make_interval(days => ${input.days})
      order by a.observed_at desc limit 1
    ) w on true`);
  return new Map(result.rows.map((row) => [num(row.transaction_id), { userId: num(row.user_id), at: date(row.observed_at) }]));
}

/**
 * A subscription that renews: the same fan's charge of the same price on the same page 27 to 32 days before, within
 * half an hour of the same time of day (as Gengar's report reads an auto-renewal of a tier). By sale: the charge before.
 */
export async function listHandinRenewals(db: Database, transactionIds: readonly number[]): Promise<Map<number, Date>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select t.id, prev.occurred_at
    from transactions t
    join lateral (
      select p.occurred_at from transactions p
      where p.platform_account_id = t.platform_account_id and p.fan_id = t.fan_id and p.id <> t.id
        and p.canonical_type = 'subscription' and p.is_active and p.gross_amount_mills = t.gross_amount_mills
        and p.occurred_at >= t.occurred_at - interval '32 days 1 hour' and p.occurred_at <= t.occurred_at - interval '27 days'
        and least(
          mod(extract(epoch from (t.occurred_at - p.occurred_at))::numeric, 86400),
          86400 - mod(extract(epoch from (t.occurred_at - p.occurred_at))::numeric, 86400)
        ) <= 1800
      order by p.occurred_at desc limit 1
    ) prev on true
    where t.id = any(${ids([...new Set(transactionIds)])}) and t.canonical_type = 'subscription' and t.fan_id is not null`);
  return new Map(result.rows.map((row) => [num(row.id), date(row.occurred_at)]));
}

/** The sales that count in the newest version of another person's report, by sale: whose, which shift and date. */
export async function listHandinOtherReports(
  db: Database,
  input: { transactionIds: readonly number[]; exceptUserIds: readonly number[] },
): Promise<Map<number, Array<{ userId: number; shiftId: number; reportDate: string }>>> {
  if (input.transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select (line ->> 'transactionId')::bigint as transaction_id, h.user_id, h.shift_id, to_char(h.report_date, 'YYYY-MM-DD') as report_date
    from shift_handins h
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    cross join lateral jsonb_array_elements(v.lines) as line
    where h.state = 'submitted' and not (h.user_id = any(${ids(input.exceptUserIds)}))
      and (line ->> 'transactionId')::bigint = any(${ids(input.transactionIds)})
      and (coalesce((line ->> 'amountMills')::bigint, 0) > 0 or coalesce((line ->> 'claimedMills')::bigint, 0) > 0)`);
  const out = new Map<number, Array<{ userId: number; shiftId: number; reportDate: string }>>();
  for (const row of result.rows) {
    const list = out.get(num(row.transaction_id)) ?? [];
    list.push({ userId: num(row.user_id), shiftId: num(row.shift_id), reportDate: String(row.report_date) });
    out.set(num(row.transaction_id), list);
  }
  return out;
}

// ── Sales a person adds by hand («Добавить → продажу») ───────────────────────

export interface HandinSaleRow {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  kind: string;
  occurredAt: Date;
  netMills: number;
  fan: { fanRef: string | null; name: string | null; username: string | null };
  /** Its home as `sale_homes` keeps it; null — not computed yet. */
  home: { home: string; reason: string; pot: string | null; shares: Array<{ userId: number; workRef: string | null; shiftId: number | null; mills: number }> } | null;
}

const SALE_SELECT = sql`
  select t.id, t.platform_account_id as page_id, p.label, p.platform, t.canonical_type::text as kind, t.occurred_at,
    t.creator_net_amount_mills as net, f.platform_user_id as fan_ref, coalesce(f.display_name, f.username) as fan_name, f.username as fan_username,
    h.home, h.reason, h.pot, h.shares
  from transactions t
  join pages p on p.id = t.platform_account_id
  left join fans f on f.id = t.fan_id
  left join sale_homes h on h.transaction_id = t.id`;

function saleOf(row: Row): HandinSaleRow {
  return {
    transactionId: num(row.id),
    pageId: num(row.page_id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    kind: String(row.kind),
    occurredAt: date(row.occurred_at),
    netMills: num(row.net),
    fan: { fanRef: text(row.fan_ref), name: text(row.fan_name), username: text(row.fan_username) },
    home: row.home === null || row.home === undefined ? null : {
      home: String(row.home), reason: String(row.reason), pot: text(row.pot), shares: jsonArray<{ userId: number; workRef: string | null; shiftId: number | null; mills: number }>(row.shares),
    },
  };
}

/** The sales named, with their homes: the lines a person added by hand. Money a fan paid only (no refund or reversal). */
export async function listHandinSalesByIds(db: Database, transactionIds: readonly number[]): Promise<HandinSaleRow[]> {
  if (transactionIds.length === 0) return [];
  const result = await db.execute<Row>(sql`${SALE_SELECT}
    where t.id = any(${ids([...new Set(transactionIds)])}) and t.is_active and t.gross_amount_mills > 0
      and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
    order by t.occurred_at, t.id`);
  return result.rows.map(saleOf);
}

/** The sales of the pages in [from, to), the newest first, at most `limit`: what a person may add by hand. */
export async function listHandinSalesOnPages(db: Database, input: { pageIds: readonly number[]; from: Date; to: Date; limit: number }): Promise<HandinSaleRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<Row>(sql`${SALE_SELECT}
    where t.platform_account_id = any(${ids(input.pageIds)}) and t.is_active and t.gross_amount_mills > 0
      and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
      and t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at < ${input.to.toISOString()}::timestamptz
    order by t.occurred_at desc, t.id desc
    limit ${input.limit}`);
  return result.rows.map(saleOf);
}

/** The pages any of the logins may open (`user_page_assignments`). */
export async function listHandinAccessiblePageIds(db: Database, userIds: readonly number[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select distinct platform_account_id from user_page_assignments where user_id = any(${ids(userIds)})`);
  return result.rows.map((row) => num(row.platform_account_id));
}

// ── The history of the report ────────────────────────────────────────────────

/** One event of the report's history (object_events, 0382): who, on whose behalf, through which door. */
export async function insertHandinEvent(
  db: Database,
  input: {
    handinId: number;
    event: string;
    door: HandinDoor | "api" | "system";
    actorUserId: number | null;
    agentKeyId: number | null;
    onBehalfOfUserId: number | null;
    changes: Record<string, unknown>;
    at: Date;
  },
): Promise<void> {
  await db.execute(sql`
    insert into object_events (object_type, object_id, event, actor_user_id, actor_agent_key_id, on_behalf_of_user_id, door, changes, created_at)
    values ('shift_report', ${String(input.handinId)}, ${input.event}, ${input.agentKeyId === null ? input.actorUserId : null}, ${input.agentKeyId},
      ${input.onBehalfOfUserId}, ${input.door}, ${JSON.stringify(input.changes)}::jsonb, ${input.at.toISOString()}::timestamptz)`);
}

// ── The check «смена не сдана» ───────────────────────────────────────────────

export interface MissingHandinCandidate {
  shiftId: number;
  userId: number;
  startedAt: Date;
  endedAt: Date;
  reportDate: string;
  pageLabels: string[];
  personId: number;
  personName: string;
  submitsShiftSince: Date;
}

/**
 * Closed shifts that ended in [endedAfter, endedBefore) of people the check is for — a human, not the owner, with the
 * switch on since before the shift began and with pay terms — whose report is not submitted.
 */
export async function listMissingHandins(db: Database, input: { endedAfter: Date; endedBefore: Date }): Promise<MissingHandinCandidate[]> {
  const result = await db.execute<Row>(sql`
    select s.id as shift_id, s.user_id, s.started_at, s.ended_at, to_char(s.report_date, 'YYYY-MM-DD') as report_date,
      (select array_agg(page ->> 'pageLabel' order by page ->> 'pageLabel') from jsonb_array_elements(s.pages) as page) as page_labels,
      p.id as person_id, p.display_name, r.granted_at
    from shifts s
    join person_logins l on l.user_id = s.user_id
    join people p on p.id = l.person_id
    join person_rights r on r.person_id = p.id and r."right" = 'submits_shift'
    left join shift_handins h on h.shift_id = s.id
    where s.state = 'closed'
      and s.ended_at >= ${input.endedAfter.toISOString()}::timestamptz and s.ended_at < ${input.endedBefore.toISOString()}::timestamptz
      and p.kind = 'human' and p.role <> 'owner' and p.state <> 'left'
      and exists (select 1 from person_pay_terms t where t.person_id = p.id)
      and s.started_at >= r.granted_at
      and (h.id is null or h.state <> 'submitted')
    order by s.ended_at, s.id`);
  return result.rows.map((row) => ({
    shiftId: num(row.shift_id),
    userId: num(row.user_id),
    startedAt: date(row.started_at),
    endedAt: date(row.ended_at),
    reportDate: String(row.report_date),
    pageLabels: jsonArray<unknown>(row.page_labels).map(String),
    personId: num(row.person_id),
    personName: String(row.display_name),
    submitsShiftSince: date(row.granted_at),
  }));
}
