import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// A question to whoever decides (0418, products plan §4.6): raw SQL, the table is the migration's alone. The service
// (apps/runtime/src/services/team-questions.ts) is its one writer and decides who may read and write what.

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const nullableNum = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown) => (value === null || value === undefined ? null : date(value));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

export interface TeamQuestionRow {
  id: number;
  askerUserId: number;
  pageId: number;
  pageLabel: string;
  modelId: number | null;
  fanRef: string | null;
  fanName: string | null;
  kind: string;
  text: string;
  deciderUserId: number | null;
  door: "workboard" | "extension";
  askedAt: Date;
  state: "open" | "answered" | "withdrawn";
  answer: "yes" | "no" | null;
  answerText: string | null;
  answeredByUserId: number | null;
  answeredAt: Date | null;
  seenAt: Date | null;
  withdrawnAt: Date | null;
  /** A swap's details (0422); null — any other kind. */
  swap: TeamQuestionSwap | null;
}

/** A swap's details as the question keeps them (0422): the day, the pages, the hours (Moscow minutes), who and who for. */
export interface TeamQuestionSwap {
  date: string;
  pageIds: number[];
  startMinute: number;
  endMinute: number;
  absentPersonId: number;
  coverPersonId: number;
}

function swapOf(value: unknown): TeamQuestionSwap | null {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (raw === null || typeof raw !== "object") return null;
  const swap = raw as Record<string, unknown>;
  return {
    date: String(swap.date),
    pageIds: Array.isArray(swap.pageIds) ? swap.pageIds.map(Number) : [],
    startMinute: Number(swap.startMinute),
    endMinute: Number(swap.endMinute),
    absentPersonId: Number(swap.absentPersonId),
    coverPersonId: Number(swap.coverPersonId),
  };
}

const SELECT = sql`select q.id, q.asker_user_id, q.page_id, p.label as page_label, q.model_id, q.fan_platform_user_id, q.fan_name, q.kind, q.text,
  q.decider_user_id, q.door, q.asked_at, q.state, q.answer, q.answer_text, q.answered_by_user_id, q.answered_at, q.seen_at, q.withdrawn_at, q.swap
  from team_questions q join pages p on p.id = q.page_id`;

function questionOf(row: Row): TeamQuestionRow {
  return {
    id: num(row.id),
    askerUserId: num(row.asker_user_id),
    pageId: num(row.page_id),
    pageLabel: String(row.page_label),
    modelId: nullableNum(row.model_id),
    fanRef: text(row.fan_platform_user_id),
    fanName: text(row.fan_name),
    kind: String(row.kind),
    text: String(row.text),
    deciderUserId: nullableNum(row.decider_user_id),
    door: row.door === "extension" ? "extension" : "workboard",
    askedAt: date(row.asked_at),
    state: row.state as TeamQuestionRow["state"],
    answer: row.answer === "yes" || row.answer === "no" ? row.answer : null,
    answerText: text(row.answer_text),
    answeredByUserId: nullableNum(row.answered_by_user_id),
    answeredAt: nullableDate(row.answered_at),
    seenAt: nullableDate(row.seen_at),
    withdrawnAt: nullableDate(row.withdrawn_at),
    swap: swapOf(row.swap),
  };
}

export async function insertTeamQuestion(
  db: Database,
  input: {
    askerUserId: number; pageId: number; modelId: number | null; fanRef: string | null; fanName: string | null;
    kind: string; text: string; deciderUserId: number | null; door: "workboard" | "extension"; at: Date;
    swap?: TeamQuestionSwap | null;
  },
): Promise<number> {
  const result = await db.execute<Row>(sql`
    insert into team_questions (asker_user_id, page_id, model_id, fan_platform_user_id, fan_name, kind, text, decider_user_id, door, asked_at, swap)
    values (${input.askerUserId}, ${input.pageId}, ${input.modelId}, ${input.fanRef}, ${input.fanName}, ${input.kind}, ${input.text},
      ${input.deciderUserId}, ${input.door}, ${input.at.toISOString()}::timestamptz,
      ${input.swap ? JSON.stringify(input.swap) : null}::jsonb)
    returning id`);
  return num(result.rows[0]!.id);
}

export async function findTeamQuestion(db: Database, id: number): Promise<TeamQuestionRow | null> {
  const result = await db.execute<Row>(sql`${SELECT} where q.id = ${id}`);
  return result.rows[0] === undefined ? null : questionOf(result.rows[0]);
}

/**
 * The questions a reader sees: asked by any of `askerUserIds` since `since`, those `deciderUserIds` decide (open, or
 * answered since `since`), and — `everyOpen` (the owner) — every open one; of `pageIds` only when given. Newest first.
 */
export async function listTeamQuestions(
  db: Database,
  input: {
    askerUserIds: readonly number[]; deciderUserIds: readonly number[]; ownerDecides: boolean; since: Date; pageIds?: readonly number[];
    /** The models whose questions the reader may decide now (the service asks the rule again, row by row). */
    modelIds?: readonly number[];
    /** The person who covers a swap: they are named in it. */
    coverPersonId?: number | null;
  },
): Promise<TeamQuestionRow[]> {
  const since = input.since.toISOString();
  const pages = input.pageIds === undefined ? sql`true` : sql`q.page_id = any(${ids(input.pageIds)})`;
  // The owner decides whatever the rule gives him now: every open question (and the recent answers) of his realm.
  const owner = input.ownerDecides ? sql`or (q.state = 'open' or q.answered_at >= ${since}::timestamptz)` : sql``;
  const models = input.modelIds !== undefined && input.modelIds.length > 0
    ? sql`or (q.model_id = any(${ids(input.modelIds)}) and (q.state = 'open' or q.answered_at >= ${since}::timestamptz))` : sql``;
  const cover = input.coverPersonId !== undefined && input.coverPersonId !== null
    ? sql`or (q.swap is not null and (q.swap->>'coverPersonId')::bigint = ${input.coverPersonId} and q.asked_at >= ${since}::timestamptz)` : sql``;
  const result = await db.execute<Row>(sql`${SELECT}
    where ${pages} and (
      (q.asker_user_id = any(${ids(input.askerUserIds)}) and q.asked_at >= ${since}::timestamptz)
      or (q.decider_user_id = any(${ids(input.deciderUserIds)}) and (q.state = 'open' or q.answered_at >= ${since}::timestamptz))
      ${owner}
      ${models}
      ${cover}
    )
    order by q.asked_at desc, q.id desc
    limit 200`);
  return result.rows.map(questionOf);
}

/** Answers an open question; false — it is not open any more (answered or withdrawn meanwhile). */
/** The swap questions still open (asked, not answered or withdrawn): the tick closes those whose hours have ended. */
export async function listOpenSwapQuestions(db: Database): Promise<TeamQuestionRow[]> {
  const result = await db.execute<Row>(sql`${SELECT} where q.state = 'open' and q.kind = 'swap' and q.swap is not null order by q.id`);
  return result.rows.map(questionOf);
}

/** A question nobody decided in time: answered «Нельзя» by nobody (no person answered it), with the words why. */
export async function lapseTeamQuestion(db: Database, input: { id: number; text: string; at: Date }): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update team_questions set state = 'answered', answer = 'no', answer_text = ${input.text}, answered_by_user_id = null,
      answered_at = ${input.at.toISOString()}::timestamptz
    where id = ${input.id} and state = 'open' returning id`);
  return result.rows.length > 0;
}

export async function answerTeamQuestion(
  db: Database,
  input: { id: number; answer: "yes" | "no"; text: string | null; byUserId: number; at: Date },
): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update team_questions set state = 'answered', answer = ${input.answer}, answer_text = ${input.text},
      answered_by_user_id = ${input.byUserId}, answered_at = ${input.at.toISOString()}::timestamptz
    where id = ${input.id} and state = 'open' returning id`);
  return result.rows.length > 0;
}

/** The asker withdraws an open question; false — it is not open. */
export async function withdrawTeamQuestion(db: Database, input: { id: number; at: Date }): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update team_questions set state = 'withdrawn', withdrawn_at = ${input.at.toISOString()}::timestamptz
    where id = ${input.id} and state = 'open' returning id`);
  return result.rows.length > 0;
}

/** The asker read the answer (once). */
export async function markTeamQuestionSeen(db: Database, input: { id: number; at: Date }): Promise<void> {
  await db.execute(sql`update team_questions set seen_at = coalesce(seen_at, ${input.at.toISOString()}::timestamptz) where id = ${input.id} and state = 'answered'`);
}

/**
 * The approved swaps of days `from`..`to` (Moscow) whose lines are not taken back: «График» and its «Подмена». The day
 * lines themselves are the registry's (`listPersonDayLineRows`); this names the question they came from.
 */
export async function listApprovedSwaps(db: Database, input: { from: string; to: string }): Promise<TeamQuestionRow[]> {
  const result = await db.execute<Row>(sql`${SELECT}
    where q.kind = 'swap' and q.answer = 'yes' and q.swap is not null
      and (q.swap->>'date') between ${input.from} and ${input.to}
      and exists (select 1 from person_schedule_slots s where s.question_id = q.id and s.revoked_at is null)
    order by q.swap->>'date', q.id`);
  return result.rows.map(questionOf);
}

/** Of these questions, the ones whose swap lines stand (written, not taken back). */
export async function listStandingSwapQuestionIds(db: Database, questionIds: readonly number[]): Promise<Set<number>> {
  if (questionIds.length === 0) return new Set();
  const result = await db.execute<Row>(sql`select distinct question_id from person_schedule_slots
    where question_id = any(${ids(questionIds)}) and revoked_at is null`);
  return new Set(result.rows.map((row) => num(row.question_id)));
}

/** Hours of a swap's day (Moscow minutes): `endMinute` at or before `startMinute` runs into the next day. */
export interface SwapHours {
  date: string;
  startMinute: number;
  endMinute: number;
}

/**
 * A person's swaps of some days on any of the pages, for «no swap stands twice over the same hours»: the hours of their
 * standing `off` lines (approved, not taken back) and of the open swap questions where they are the absent person. The
 * caller asks the day before, the day and the day after (a swap's hours may run past midnight) and compares real hours.
 */
export async function listPersonDaySwaps(db: Database, input: { personId: number; days: readonly string[]; pageIds: readonly number[] }): Promise<{ off: SwapHours[]; asked: SwapHours[] }> {
  if (input.pageIds.length === 0 || input.days.length === 0) return { off: [], asked: [] };
  const days = sql`${sql.param([...input.days])}::text[]`;
  const off = await db.execute<Row>(sql`select to_char(valid_from, 'YYYY-MM-DD') as day, start_minute, end_minute from person_schedule_slots
    where person_id = ${input.personId} and kind = 'off' and revoked_at is null and to_char(valid_from, 'YYYY-MM-DD') = any(${days})
      and page_id = any(${ids(input.pageIds)})`);
  const asked = await db.execute<Row>(sql`select swap from team_questions
    where kind = 'swap' and state = 'open' and swap is not null and swap->>'date' = any(${days})
      and (swap->>'absentPersonId')::bigint = ${input.personId}`);
  const pages = new Set(input.pageIds);
  return {
    off: off.rows.map((row) => ({ date: String(row.day), startMinute: num(row.start_minute), endMinute: num(row.end_minute) })),
    asked: asked.rows.flatMap((row) => {
      const swap = swapOf(row.swap);
      return swap !== null && swap.pageIds.some((id) => pages.has(id)) ? [{ date: swap.date, startMinute: swap.startMinute, endMinute: swap.endMinute }] : [];
    }),
  };
}

/** Holds the persons' swap days until the caller's transaction ends: two «Можно» at once are checked one after the other. */
export async function lockPersonSwaps(db: Database, personIds: readonly number[]): Promise<void> {
  for (const id of [...new Set(personIds)].sort((a, b) => a - b)) {
    await db.execute(sql`select pg_advisory_xact_lock(422, ${id}::int)`);
  }
}
