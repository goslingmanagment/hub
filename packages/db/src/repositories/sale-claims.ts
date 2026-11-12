import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { HandinVersionLine, HandinVersionOffPlatform, HandinVersionPage } from "./shift-handins.ts";

// Заявки и договорённости (0404; ecosystem plan 2026-11-12, package G): the
// statements of handed-in reports that touch another person, their answers,
// the owner's decisions of whose a sale is, and the owner's word on «мимо
// площадки». Raw SQL: the tables are the migration's alone. Nothing here is
// deleted: a claim is withdrawn or decided, a decision superseded.

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const nullableNum = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown) => (value === null || value === undefined ? null : date(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

// ── The reports a claim is read from ─────────────────────────────────────────

/** The newest version of a handed-in report, with whose report it is. */
export interface CurrentReport {
  handinId: number;
  shiftId: number;
  userId: number;
  reportDate: string;
  versionId: number;
  version: number;
  submittedAt: Date;
  lines: HandinVersionLine[];
  pages: HandinVersionPage[];
  offPlatform: HandinVersionOffPlatform[];
}

/** The newest version of every report handed in whose report date is `since` or later. */
export async function listCurrentReportsSince(db: Database, input: { since: string; handinIds?: readonly number[] }): Promise<CurrentReport[]> {
  const only = input.handinIds === undefined ? sql`` : sql`and h.id = any(${ids(input.handinIds)})`;
  const result = await db.execute<Row>(sql`
    select h.id as handin_id, h.shift_id, h.user_id, to_char(h.report_date, 'YYYY-MM-DD') as report_date,
      v.id as version_id, v.version, v.submitted_at, v.lines, v.pages, v.off_platform
    from shift_handins h
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    where h.state = 'submitted' and h.report_date >= ${input.since}::date ${only}
    order by v.submitted_at, v.id`);
  return result.rows.map((row) => ({
    handinId: num(row.handin_id),
    shiftId: num(row.shift_id),
    userId: num(row.user_id),
    reportDate: String(row.report_date),
    versionId: num(row.version_id),
    version: num(row.version),
    submittedAt: date(row.submitted_at),
    lines: jsonOf<HandinVersionLine[]>(row.lines, []),
    pages: jsonOf<HandinVersionPage[]>(row.pages, []),
    offPlatform: jsonOf<HandinVersionOffPlatform[]>(row.off_platform, []),
  }));
}

/** The newest versions of every handed-in report that holds one of the sales (any report date). */
export async function listCurrentReportsOfSales(db: Database, transactionIds: readonly number[]): Promise<CurrentReport[]> {
  if (transactionIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select h.id as handin_id, h.shift_id, h.user_id, to_char(h.report_date, 'YYYY-MM-DD') as report_date,
      v.id as version_id, v.version, v.submitted_at, v.lines, v.pages, v.off_platform
    from shift_handins h
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    where h.state = 'submitted' and exists (
      select 1 from jsonb_array_elements(v.lines) as line where (line ->> 'transactionId')::bigint = any(${ids(transactionIds)})
    )
    order by v.submitted_at, v.id`);
  return result.rows.map((row) => ({
    handinId: num(row.handin_id),
    shiftId: num(row.shift_id),
    userId: num(row.user_id),
    reportDate: String(row.report_date),
    versionId: num(row.version_id),
    version: num(row.version),
    submittedAt: date(row.submitted_at),
    lines: jsonOf<HandinVersionLine[]>(row.lines, []),
    pages: jsonOf<HandinVersionPage[]>(row.pages, []),
    offPlatform: jsonOf<HandinVersionOffPlatform[]>(row.off_platform, []),
  }));
}

// ── Claims ───────────────────────────────────────────────────────────────────

export type SaleClaimKind = "claim" | "double" | "imported";
export type SaleClaimState = "asked" | "agreed" | "owner" | "decided" | "withdrawn";
export type SaleClaimAnswer = "agree" | "disagree";
export type SaleClaimEscalation = "disagree" | "silence" | "no_side" | "double" | "imported";

export interface SaleClaimRow {
  id: number;
  transactionId: number | null;
  pageId: number | null;
  kind: SaleClaimKind;
  claimantUserId: number | null;
  claimantHandinId: number | null;
  claimantVersion: number | null;
  statement: "mine" | "share" | null;
  shareWithUserId: number | null;
  claimantNote: string | null;
  claimedAt: Date;
  sideUserId: number | null;
  sideShiftId: number | null;
  state: SaleClaimState;
  answer: SaleClaimAnswer | null;
  answerNote: string | null;
  answeredAt: Date | null;
  answeredByUserId: number | null;
  answeredByAgentKeyId: number | null;
  answerDoor: string | null;
  answerRef: string | null;
  escalatedAt: Date | null;
  escalatedWhy: SaleClaimEscalation | null;
  decisionId: number | null;
  closedAt: Date | null;
  ledgerQuestionId: number | null;
  question: string | null;
  whoText: string | null;
  ledgerRef: Record<string, unknown> | null;
  needsLink: boolean;
  createdAt: Date;
}

const CLAIM_COLUMNS = sql`c.id, c.transaction_id, c.page_id, c.kind, c.claimant_user_id, c.claimant_handin_id, c.claimant_version, c.statement,
  c.share_with_user_id, c.claimant_note, c.claimed_at, c.side_user_id, c.side_shift_id, c.state, c.answer, c.answer_note, c.answered_at,
  c.answered_by_user_id, c.answered_by_agent_key_id, c.answer_door, c.answer_ref, c.escalated_at, c.escalated_why, c.decision_id,
  c.closed_at, c.ledger_question_id, c.question, c.who_text, c.ledger_ref, c.needs_link, c.created_at`;

function claimOf(row: Row): SaleClaimRow {
  return {
    id: num(row.id),
    transactionId: nullableNum(row.transaction_id),
    pageId: nullableNum(row.page_id),
    kind: row.kind as SaleClaimKind,
    claimantUserId: nullableNum(row.claimant_user_id),
    claimantHandinId: nullableNum(row.claimant_handin_id),
    claimantVersion: nullableNum(row.claimant_version),
    statement: (row.statement ?? null) as SaleClaimRow["statement"],
    shareWithUserId: nullableNum(row.share_with_user_id),
    claimantNote: text(row.claimant_note),
    claimedAt: date(row.claimed_at),
    sideUserId: nullableNum(row.side_user_id),
    sideShiftId: nullableNum(row.side_shift_id),
    state: row.state as SaleClaimState,
    answer: (row.answer ?? null) as SaleClaimAnswer | null,
    answerNote: text(row.answer_note),
    answeredAt: nullableDate(row.answered_at),
    answeredByUserId: nullableNum(row.answered_by_user_id),
    answeredByAgentKeyId: nullableNum(row.answered_by_agent_key_id),
    answerDoor: text(row.answer_door),
    answerRef: text(row.answer_ref),
    escalatedAt: nullableDate(row.escalated_at),
    escalatedWhy: (row.escalated_why ?? null) as SaleClaimEscalation | null,
    decisionId: nullableNum(row.decision_id),
    closedAt: nullableDate(row.closed_at),
    ledgerQuestionId: nullableNum(row.ledger_question_id),
    question: text(row.question),
    whoText: text(row.who_text),
    ledgerRef: jsonOf<Record<string, unknown> | null>(row.ledger_ref, null),
    needsLink: Boolean(row.needs_link),
    createdAt: date(row.created_at),
  };
}

/** Claims by any of: ids, sales, the side, states; the newest first. */
export async function listSaleClaims(
  db: Database,
  input: {
    ids?: readonly number[];
    transactionIds?: readonly number[];
    sideUserIds?: readonly number[];
    involvingUserIds?: readonly number[];
    states?: readonly SaleClaimState[];
    kinds?: readonly SaleClaimKind[];
    limit?: number;
  },
): Promise<SaleClaimRow[]> {
  const where = [sql`true`];
  if (input.ids !== undefined) where.push(sql`c.id = any(${ids(input.ids)})`);
  if (input.transactionIds !== undefined) where.push(sql`c.transaction_id = any(${ids(input.transactionIds)})`);
  if (input.sideUserIds !== undefined) where.push(sql`c.side_user_id = any(${ids(input.sideUserIds)})`);
  if (input.involvingUserIds !== undefined) {
    where.push(sql`(c.side_user_id = any(${ids(input.involvingUserIds)}) or c.claimant_user_id = any(${ids(input.involvingUserIds)}))`);
  }
  if (input.states !== undefined) where.push(sql`c.state = any(${sql.param([...input.states])}::text[])`);
  if (input.kinds !== undefined) where.push(sql`c.kind = any(${sql.param([...input.kinds])}::text[])`);
  const result = await db.execute<Row>(sql`
    select ${CLAIM_COLUMNS} from sale_claims c where ${sql.join(where, sql` and `)}
    order by c.id desc limit ${input.limit ?? 5000}`);
  return result.rows.map(claimOf);
}

/** A claim, `lock` for a write. */
export async function findSaleClaim(db: Database, id: number, options: { lock?: boolean } = {}): Promise<SaleClaimRow | null> {
  const result = await db.execute<Row>(sql`select ${CLAIM_COLUMNS} from sale_claims c where c.id = ${id} ${options.lock ? sql`for update` : sql``}`);
  return result.rows[0] === undefined ? null : claimOf(result.rows[0]);
}

export interface SaleClaimInsert {
  transactionId: number | null;
  pageId: number | null;
  kind: SaleClaimKind;
  claimantUserId: number | null;
  claimantHandinId: number | null;
  claimantVersion: number | null;
  statement: "mine" | "share" | null;
  shareWithUserId: number | null;
  claimantNote: string | null;
  claimedAt: Date;
  sideUserId: number | null;
  sideShiftId: number | null;
  state: SaleClaimState;
  escalatedAt?: Date | null;
  escalatedWhy?: SaleClaimEscalation | null;
  ledgerQuestionId?: number | null;
  question?: string | null;
  whoText?: string | null;
  ledgerRef?: Record<string, unknown> | null;
  decisionId?: number | null;
  closedAt?: Date | null;
  answer?: SaleClaimAnswer | null;
  answerNote?: string | null;
  answeredAt?: Date | null;
}

/** A new claim; a claim of the same report, sale and side already there — null (nothing written). */
export async function insertSaleClaim(db: Database, input: SaleClaimInsert, at: Date): Promise<SaleClaimRow | null> {
  const result = await db.execute<Row>(sql`
    insert into sale_claims (transaction_id, page_id, kind, claimant_user_id, claimant_handin_id, claimant_version, statement,
      share_with_user_id, claimant_note, claimed_at, side_user_id, side_shift_id, state, escalated_at, escalated_why, ledger_question_id,
      question, who_text, ledger_ref, needs_link, decision_id, closed_at, answer, answer_note, answered_at, created_at, updated_at)
    values (${input.transactionId}, ${input.pageId}, ${input.kind}, ${input.claimantUserId}, ${input.claimantHandinId}, ${input.claimantVersion},
      ${input.statement}, ${input.shareWithUserId}, ${input.claimantNote}, ${input.claimedAt.toISOString()}::timestamptz, ${input.sideUserId},
      ${input.sideShiftId}, ${input.state}, ${input.escalatedAt?.toISOString() ?? null}::timestamptz, ${input.escalatedWhy ?? null},
      ${input.ledgerQuestionId ?? null}, ${input.question ?? null}, ${input.whoText ?? null},
      ${input.ledgerRef == null ? null : JSON.stringify(input.ledgerRef)}::jsonb, ${input.transactionId === null}, ${input.decisionId ?? null},
      ${input.closedAt?.toISOString() ?? null}::timestamptz, ${input.answer ?? null}, ${input.answerNote ?? null},
      ${input.answeredAt?.toISOString() ?? null}::timestamptz, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz)
    on conflict do nothing
    returning id`);
  const id = result.rows[0]?.id;
  return id === undefined ? null : findSaleClaim(db, num(id));
}

/** Changes a claim: the fields given, and when. */
export async function updateSaleClaim(
  db: Database,
  id: number,
  patch: Partial<Pick<SaleClaimRow,
    "state" | "answer" | "answerNote" | "answeredAt" | "answeredByUserId" | "answeredByAgentKeyId" | "answerDoor" | "answerRef"
    | "escalatedAt" | "escalatedWhy" | "decisionId" | "closedAt" | "claimantVersion" | "claimantNote" | "sideShiftId" | "transactionId" | "pageId">>,
  at: Date,
): Promise<void> {
  const sets = [sql`updated_at = ${at.toISOString()}::timestamptz`];
  const put = (column: string, value: unknown, cast = "") => sets.push(sql`${sql.raw(column)} = ${value}${sql.raw(cast)}`);
  const iso = (value: Date | null | undefined) => (value == null ? null : value.toISOString());
  if (patch.state !== undefined) put("state", patch.state);
  if (patch.answer !== undefined) put("answer", patch.answer);
  if (patch.answerNote !== undefined) put("answer_note", patch.answerNote);
  if (patch.answeredAt !== undefined) put("answered_at", iso(patch.answeredAt), "::timestamptz");
  if (patch.answeredByUserId !== undefined) put("answered_by_user_id", patch.answeredByUserId);
  if (patch.answeredByAgentKeyId !== undefined) put("answered_by_agent_key_id", patch.answeredByAgentKeyId);
  if (patch.answerDoor !== undefined) put("answer_door", patch.answerDoor);
  if (patch.answerRef !== undefined) put("answer_ref", patch.answerRef);
  if (patch.escalatedAt !== undefined) put("escalated_at", iso(patch.escalatedAt), "::timestamptz");
  if (patch.escalatedWhy !== undefined) put("escalated_why", patch.escalatedWhy);
  if (patch.decisionId !== undefined) put("decision_id", patch.decisionId);
  if (patch.closedAt !== undefined) put("closed_at", iso(patch.closedAt), "::timestamptz");
  if (patch.claimantVersion !== undefined) put("claimant_version", patch.claimantVersion);
  if (patch.claimantNote !== undefined) put("claimant_note", patch.claimantNote);
  if (patch.sideShiftId !== undefined) put("side_shift_id", patch.sideShiftId);
  if (patch.transactionId !== undefined) {
    put("transaction_id", patch.transactionId);
    put("needs_link", patch.transactionId === null);
  }
  if (patch.pageId !== undefined) put("page_id", patch.pageId);
  await db.execute(sql`update sale_claims set ${sql.join(sets, sql`, `)} where id = ${id}`);
}

// ── The owner's decisions ────────────────────────────────────────────────────

export type SaleDecisionKind = "split" | "nobody" | "pot";
export type SaleDecisionOutcome = "first" | "second" | "half" | "nobody" | "imported";

export interface SaleDecisionRow {
  id: number;
  transactionId: number | null;
  pageId: number | null;
  kind: SaleDecisionKind;
  shares: Array<{ userId: number; percent: number }>;
  pot: string | null;
  outcome: SaleDecisionOutcome;
  ruleHome: string | null;
  note: string | null;
  decidedByUserId: number | null;
  decidedAt: Date;
  saidBy: string | null;
  source: "dispute" | "ledger";
  ledgerDecisionId: number | null;
  ledgerRef: Record<string, unknown> | null;
  needsLink: boolean;
  state: "active" | "superseded";
}

const DECISION_COLUMNS = sql`d.id, d.transaction_id, d.page_id, d.kind, d.shares, d.pot, d.outcome, d.rule_home, d.note, d.decided_by_user_id,
  d.decided_at, d.said_by, d.source, d.ledger_decision_id, d.ledger_ref, d.needs_link, d.state`;

function decisionOf(row: Row): SaleDecisionRow {
  return {
    id: num(row.id),
    transactionId: nullableNum(row.transaction_id),
    pageId: nullableNum(row.page_id),
    kind: row.kind as SaleDecisionKind,
    shares: jsonOf<Array<{ userId: number; percent: number }>>(row.shares, []).map((share) => ({ userId: Number(share.userId), percent: Number(share.percent) })),
    pot: text(row.pot),
    outcome: row.outcome as SaleDecisionOutcome,
    ruleHome: text(row.rule_home),
    note: text(row.note),
    decidedByUserId: nullableNum(row.decided_by_user_id),
    decidedAt: date(row.decided_at),
    saidBy: text(row.said_by),
    source: row.source as SaleDecisionRow["source"],
    ledgerDecisionId: nullableNum(row.ledger_decision_id),
    ledgerRef: jsonOf<Record<string, unknown> | null>(row.ledger_ref, null),
    needsLink: Boolean(row.needs_link),
    state: row.state as SaleDecisionRow["state"],
  };
}

/** The active decisions of the sales named, by sale. */
export async function listActiveSaleDecisions(db: Database, transactionIds: readonly number[]): Promise<Map<number, SaleDecisionRow>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select ${DECISION_COLUMNS} from sale_owner_decisions d
    where d.state = 'active' and d.transaction_id = any(${ids([...new Set(transactionIds)])})`);
  return new Map(result.rows.map((row) => {
    const decision = decisionOf(row);
    return [decision.transactionId!, decision];
  }));
}

/** Decisions by id, sale or source; the newest first. */
export async function listSaleDecisions(
  db: Database,
  input: { ids?: readonly number[]; transactionIds?: readonly number[]; needsLink?: boolean; activeOnly?: boolean; userIds?: readonly number[]; limit?: number },
): Promise<SaleDecisionRow[]> {
  const where = [sql`true`];
  if (input.ids !== undefined) where.push(sql`d.id = any(${ids(input.ids)})`);
  if (input.transactionIds !== undefined) where.push(sql`d.transaction_id = any(${ids(input.transactionIds)})`);
  if (input.needsLink !== undefined) where.push(sql`d.needs_link = ${input.needsLink}`);
  if (input.activeOnly === true) where.push(sql`d.state = 'active'`);
  if (input.userIds !== undefined) {
    where.push(sql`exists (select 1 from jsonb_array_elements(d.shares) as s where (s ->> 'userId')::bigint = any(${ids(input.userIds)}))`);
  }
  const result = await db.execute<Row>(sql`
    select ${DECISION_COLUMNS} from sale_owner_decisions d where ${sql.join(where, sql` and `)}
    order by d.id desc limit ${input.limit ?? 5000}`);
  return result.rows.map(decisionOf);
}

export interface SaleDecisionInsert {
  transactionId: number | null;
  pageId: number | null;
  kind: SaleDecisionKind;
  shares: ReadonlyArray<{ userId: number; percent: number }>;
  pot: string | null;
  outcome: SaleDecisionOutcome;
  ruleHome: string | null;
  note: string | null;
  decidedByUserId: number | null;
  decidedAt: Date;
  saidBy: string | null;
  source: "dispute" | "ledger";
  ledgerDecisionId: number | null;
  ledgerRef: Record<string, unknown> | null;
}

/**
 * The owner's decision of a sale: the active one before it, if any, is superseded (never changed otherwise). An
 * imported one already imported (by the ledger's id) — null, nothing written. Run in the caller's transaction.
 */
export async function insertSaleDecision(db: Database, input: SaleDecisionInsert, at: Date): Promise<SaleDecisionRow | null> {
  if (input.ledgerDecisionId !== null) {
    const known = await db.execute<Row>(sql`select id from sale_owner_decisions where ledger_decision_id = ${input.ledgerDecisionId}`);
    if (known.rows.length > 0) return null;
  }
  if (input.transactionId !== null) {
    await db.execute(sql`
      update sale_owner_decisions set state = 'superseded', superseded_at = ${at.toISOString()}::timestamptz
      where transaction_id = ${input.transactionId} and state = 'active'`);
  }
  const result = await db.execute<Row>(sql`
    insert into sale_owner_decisions (transaction_id, page_id, kind, shares, pot, outcome, rule_home, note, decided_by_user_id, decided_at,
      said_by, source, ledger_decision_id, ledger_ref, needs_link, created_at)
    values (${input.transactionId}, ${input.pageId}, ${input.kind}, ${JSON.stringify(input.shares)}::jsonb, ${input.pot}, ${input.outcome},
      ${input.ruleHome}, ${input.note}, ${input.decidedByUserId}, ${input.decidedAt.toISOString()}::timestamptz, ${input.saidBy}, ${input.source},
      ${input.ledgerDecisionId}, ${input.ledgerRef == null ? null : JSON.stringify(input.ledgerRef)}::jsonb, ${input.transactionId === null},
      ${at.toISOString()}::timestamptz)
    returning id`);
  const found = await listSaleDecisions(db, { ids: [num(result.rows[0]!.id)] });
  return found[0] ?? null;
}

/**
 * Links an imported decision the ledger's text did not tie to a sale: it takes the sale and becomes the sale's active
 * decision (one before it superseded). False — not one waiting for a link.
 */
export async function linkSaleDecision(db: Database, input: { id: number; transactionId: number; pageId: number; at: Date }): Promise<boolean> {
  await db.execute(sql`
    update sale_owner_decisions set state = 'superseded', superseded_at = ${input.at.toISOString()}::timestamptz
    where transaction_id = ${input.transactionId} and state = 'active' and id <> ${input.id}`);
  const result = await db.execute(sql`
    update sale_owner_decisions set transaction_id = ${input.transactionId}, page_id = ${input.pageId}, needs_link = false
    where id = ${input.id} and needs_link and state = 'active'`);
  return (result.rowCount ?? 0) > 0;
}

// ── «Мимо площадки»: the owner's word ────────────────────────────────────────

export interface PendingOffPlatformRow {
  id: number;
  handinId: number;
  shiftId: number;
  userId: number;
  reportDate: string;
  amountMills: number;
  fromWhom: string;
  whatFor: string;
  createdAt: Date;
  /** The report's pages in its newest version, in order. */
  pages: string[];
}

/** «Мимо площадки» lines waiting for the owner in handed-in reports, oldest first. */
export async function listPendingOffPlatform(db: Database, input: { handinIds?: readonly number[] } = {}): Promise<PendingOffPlatformRow[]> {
  const only = input.handinIds === undefined ? sql`` : sql`and h.id = any(${ids(input.handinIds)})`;
  const result = await db.execute<Row>(sql`
    select o.id, o.handin_id, h.shift_id, o.user_id, to_char(h.report_date, 'YYYY-MM-DD') as report_date, o.amount_mills, o.from_whom,
      o.what_for, o.created_at,
      (select coalesce(jsonb_agg(p ->> 'pageLabel'), '[]'::jsonb) from jsonb_array_elements(v.pages) as p) as pages
    from off_platform_sales o
    join shift_handins h on h.id = o.handin_id and h.state = 'submitted'
    join shift_handin_versions v on v.handin_id = h.id and v.version = h.current_version
    where o.state = 'pending' ${only}
    order by o.created_at, o.id`);
  return result.rows.map((row) => ({
    id: num(row.id),
    handinId: num(row.handin_id),
    shiftId: num(row.shift_id),
    userId: num(row.user_id),
    reportDate: String(row.report_date),
    amountMills: num(row.amount_mills),
    fromWhom: String(row.from_whom),
    whatFor: String(row.what_for),
    createdAt: date(row.created_at),
    pages: jsonOf<unknown[]>(row.pages, []).map(String),
  }));
}

/** The owner's word on a pending line: confirmed (on a page) or rejected. False — not pending (decided, withdrawn, none). */
export async function decideOffPlatform(
  db: Database,
  input: { id: number; state: "confirmed" | "rejected"; pageId: number | null; note: string | null; byUserId: number; at: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update off_platform_sales set state = ${input.state}, page_id = ${input.pageId}, decided_note = ${input.note},
      decided_at = ${input.at.toISOString()}::timestamptz, decided_by_user_id = ${input.byUserId}
    where id = ${input.id} and state = 'pending'`);
  return (result.rowCount ?? 0) > 0;
}

/** An off-platform line with its report. */
export async function findOffPlatformWithReport(
  db: Database,
  id: number,
): Promise<{ id: number; handinId: number; shiftId: number; userId: number; state: string; amountMills: number } | null> {
  const result = await db.execute<Row>(sql`
    select o.id, o.handin_id, h.shift_id, o.user_id, o.state, o.amount_mills
    from off_platform_sales o join shift_handins h on h.id = o.handin_id where o.id = ${id}`);
  const row = result.rows[0];
  return row === undefined ? null : {
    id: num(row.id), handinId: num(row.handin_id), shiftId: num(row.shift_id), userId: num(row.user_id), state: String(row.state), amountMills: num(row.amount_mills),
  };
}

// ── Days whose shifts are all handed in ──────────────────────────────────────

/**
 * The Moscow report days in [from, to] where every closed shift of a person with the switch «сдаёт смену в системе» on
 * since before it began is handed in, and at least one such shift exists.
 */
export async function listDaysHandedIn(db: Database, input: { from: string; to: string }): Promise<string[]> {
  const result = await db.execute<Row>(sql`
    select to_char(s.report_date, 'YYYY-MM-DD') as day
    from shifts s
    join person_logins l on l.user_id = s.user_id
    join people p on p.id = l.person_id and p.kind = 'human'
    join person_rights r on r.person_id = p.id and r."right" = 'submits_shift' and s.started_at >= r.granted_at
    left join shift_handins h on h.shift_id = s.id
    where s.state = 'closed' and s.report_date between ${input.from}::date and ${input.to}::date
    group by s.report_date
    having bool_and(h.state is not distinct from 'submitted')
    order by s.report_date`);
  return result.rows.map((row) => String(row.day));
}

/** The sales of the Moscow days whose home is nobody's or the owner's to decide, as `sale_homes` keeps them. */
export async function listUnownedSales(db: Database, input: { days: readonly string[] }): Promise<Array<{ transactionId: number; pageId: number; occurredAt: Date; netMills: number; home: string; reason: string; day: string }>> {
  if (input.days.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select h.transaction_id, h.page_id, h.occurred_at, h.net_mills, h.home, h.reason,
      to_char(h.occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day
    from sale_homes h
    where h.home in ('nobody', 'decide')
      and to_char(h.occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') = any(${sql.param([...input.days])}::text[])
    order by h.occurred_at, h.transaction_id`);
  return result.rows.map((row) => ({
    transactionId: num(row.transaction_id),
    pageId: num(row.page_id),
    occurredAt: date(row.occurred_at),
    netMills: num(row.net_mills),
    home: String(row.home),
    reason: String(row.reason),
    day: String(row.day),
  }));
}

// ── Matching a ledger record to a sale (the one-off import) ──────────────────

export interface SaleCandidate {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  platform: string;
  occurredAt: Date;
  netMills: number;
  kind: string;
  fanRef: string | null;
  fanName: string | null;
  fanUsername: string | null;
}

/**
 * The sales of a page in [from, to] (at most `limit`, the nearest to `around` first), of the fan when named — the fan as
 * the ledger writes it: a login, the platform's id, or the OnlyFans `u<id>`.
 */
export async function listSaleCandidates(
  db: Database,
  input: { pageLabel: string; fan: string | null; from: Date; to: Date; around: Date; netMills?: number | null; limit: number },
): Promise<SaleCandidate[]> {
  const fan = input.fan === null || input.fan.trim() === "" ? null : input.fan.trim();
  const byFan = fan === null ? sql`` : sql`and (lower(f.username) = lower(${fan}) or f.platform_user_id = ${fan} or 'u' || f.platform_user_id = ${fan})`;
  const byNet = input.netMills == null ? sql`` : sql`and t.creator_net_amount_mills = ${input.netMills}`;
  const result = await db.execute<Row>(sql`
    select t.id, t.platform_account_id as page_id, p.label, p.platform, t.occurred_at, t.creator_net_amount_mills as net, t.canonical_type::text as kind,
      f.platform_user_id as fan_ref, coalesce(f.display_name, f.username) as fan_name, f.username as fan_username
    from transactions t
    join pages p on p.id = t.platform_account_id
    left join fans f on f.id = t.fan_id
    where p.label = ${input.pageLabel} and t.is_active and t.gross_amount_mills > 0
      and t.canonical_type in ('subscription', 'tip', 'message_purchase', 'post_purchase', 'stream_tip')
      and t.occurred_at >= ${input.from.toISOString()}::timestamptz and t.occurred_at <= ${input.to.toISOString()}::timestamptz
      ${byFan} ${byNet}
    order by abs(extract(epoch from (t.occurred_at - ${input.around.toISOString()}::timestamptz))), t.id
    limit ${input.limit}`);
  return result.rows.map((row) => ({
    transactionId: num(row.id),
    pageId: num(row.page_id),
    pageLabel: String(row.label),
    platform: String(row.platform),
    occurredAt: date(row.occurred_at),
    netMills: num(row.net),
    kind: String(row.kind),
    fanRef: text(row.fan_ref),
    fanName: text(row.fan_name),
    fanUsername: text(row.fan_username),
  }));
}

/** The people's logins by code: who a ledger slug is in Hub. */
export async function listLoginsByPersonCode(db: Database, codes: readonly string[]): Promise<Map<string, number[]>> {
  if (codes.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select p.code, array_agg(l.user_id order by l.user_id) as user_ids
    from people p join person_logins l on l.person_id = p.id
    where p.code = any(${sql.param([...new Set(codes)])}::text[])
    group by p.code`);
  return new Map(result.rows.map((row) => [String(row.code), jsonOf<unknown[]>(row.user_ids, []).map(Number)]));
}
