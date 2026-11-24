import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { liveUserSql, testUserSql } from "./realm.ts";
import { modelCommentsOf, type HandinDoor, type HandinPhase, type HandinVersionLine, type HandinVersionOffPlatform, type HandinVersionPage } from "./shift-handins.ts";

// The «Отчёт» board (0412; products plan 2026-11-13, package R): a report's phase, the candidates «Сдать смену»
// records, Gengar's proposals on them, and «нет в Hub» sightings. Raw SQL: the tables are the migration's alone. A
// candidate's content is never changed (the database refuses it): only its check, its supersession and its
// confirmation move. Nothing here deletes.

type Row = Record<string, unknown>;

const num = (value: unknown) => Number(value);
const nullableNum = (value: unknown) => (value === null || value === undefined ? null : Number(value));
const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));
const nullableDate = (value: unknown) => (value === null || value === undefined ? null : date(value));
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const iso = (value: Date | null | undefined) => (value == null ? null : value.toISOString());

function jsonArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (typeof value === "string") {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  }
  return [];
}

// ── The phase ────────────────────────────────────────────────────────────────

/** Moves a report to a phase. `from` — only while it is in one of these (a writer never moves a phase it did not read). */
export async function setHandinPhase(
  db: Database,
  input: { handinId: number; phase: HandinPhase; at: Date; from?: readonly HandinPhase[] },
): Promise<boolean> {
  const only = input.from === undefined ? sql`` : sql` and phase = any(${sql.param([...input.from])}::text[])`;
  const result = await db.execute(sql`
    update shift_handins set phase = ${input.phase}, phase_at = ${input.at.toISOString()}::timestamptz, updated_at = clock_timestamp()
    where id = ${input.handinId}${only}`);
  return (result.rowCount ?? 0) > 0;
}

/** Reports in `checking` (the timer's and the check's work), oldest first. */
export async function listCheckingHandins(db: Database, input: { limit: number }): Promise<Array<{ handinId: number; shiftId: number; phaseAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select id, shift_id, phase_at from shift_handins where phase = 'checking' order by phase_at nulls first, id limit ${input.limit}`);
  return result.rows.map((row) => ({ handinId: num(row.id), shiftId: num(row.shift_id), phaseAt: nullableDate(row.phase_at) ?? new Date(0) }));
}

/** Reports waiting for the person's «Подтверждаю» (their matter), oldest first. */
export async function listConfirmHandins(db: Database): Promise<Array<{ handinId: number; shiftId: number; userId: number; phaseAt: Date }>> {
  const result = await db.execute<Row>(sql`
    select id, shift_id, user_id, phase_at from shift_handins where phase = 'confirm' order by phase_at nulls first, id`);
  return result.rows.map((row) => ({ handinId: num(row.id), shiftId: num(row.shift_id), userId: num(row.user_id), phaseAt: nullableDate(row.phase_at) ?? new Date(0) }));
}

// ── Candidates ───────────────────────────────────────────────────────────────

/** Hub's check of one page of a candidate. */
export interface CandidateHubPage {
  pageLabel: string;
  state: "running" | "matched" | "found" | "unchecked" | "statement";
  foundCount: number;
  foundMills: number;
  at: string | null;
}

export interface CandidateRow {
  id: number;
  handinId: number;
  number: number;
  madeAt: Date;
  door: HandinDoor;
  actorUserId: number | null;
  agentKeyId: number | null;
  telegramMessageRef: string | null;
  telegramSenderId: number | null;
  cutoffAt: Date;
  totalMills: number;
  pages: HandinVersionPage[];
  lines: HandinVersionLine[];
  offPlatform: HandinVersionOffPlatform[];
  comment: string;
  /** Each model's own comment, as the draft had it (0432). */
  modelComments: Record<string, string>;
  ruleVersion: string;
  hubCheck: CandidateHubPage[];
  hubCheckedAt: Date | null;
  gengarAnsweredAt: Date | null;
  gengarClean: boolean | null;
  supersededAt: Date | null;
  supersededBy: number | null;
  confirmedVersion: number | null;
  confirmedAt: Date | null;
  /**
   * The person's signature at «Сдать смену» (0433): the total and count they saw, equal to the candidate's then. Null —
   * not signed (an agent's «со слов», a re-made candidate, a board that differed), or cleared because the check changed it.
   */
  signed: { totalMills: number; count: number; at: Date } | null;
  /** Expected reviewer agent person recorded at hand-in (0440); null — no review expected. */
  expectedReviewerPersonId: number | null;
}

const CANDIDATE_COLUMNS = sql`c.id, c.handin_id, c.number, c.made_at, c.door, c.actor_user_id, c.agent_key_id, c.telegram_message_ref,
  c.telegram_sender_id, c.cutoff_at, c.total_mills, c.pages, c.lines, c.off_platform, c.comment, c.model_comments, c.rule_version, c.hub_check,
  c.hub_checked_at, c.gengar_answered_at, c.gengar_clean, c.superseded_at, c.superseded_by, c.confirmed_version, c.confirmed_at,
  c.signed_total_mills, c.signed_count, c.signed_at, c.expected_reviewer_person_id`;

function candidateOf(row: Row): CandidateRow {
  return {
    id: num(row.id),
    handinId: num(row.handin_id),
    number: num(row.number),
    madeAt: date(row.made_at),
    door: row.door as HandinDoor,
    actorUserId: nullableNum(row.actor_user_id),
    agentKeyId: nullableNum(row.agent_key_id),
    telegramMessageRef: text(row.telegram_message_ref),
    telegramSenderId: nullableNum(row.telegram_sender_id),
    cutoffAt: date(row.cutoff_at),
    totalMills: num(row.total_mills),
    pages: jsonArray<HandinVersionPage>(row.pages),
    lines: jsonArray<HandinVersionLine>(row.lines),
    offPlatform: jsonArray<HandinVersionOffPlatform>(row.off_platform),
    comment: String(row.comment ?? ""),
    modelComments: modelCommentsOf(row.model_comments),
    ruleVersion: String(row.rule_version),
    hubCheck: jsonArray<CandidateHubPage>(row.hub_check),
    hubCheckedAt: nullableDate(row.hub_checked_at),
    gengarAnsweredAt: nullableDate(row.gengar_answered_at),
    gengarClean: row.gengar_clean === null || row.gengar_clean === undefined ? null : Boolean(row.gengar_clean),
    supersededAt: nullableDate(row.superseded_at),
    supersededBy: nullableNum(row.superseded_by),
    confirmedVersion: nullableNum(row.confirmed_version),
    confirmedAt: nullableDate(row.confirmed_at),
    signed: row.signed_at === null || row.signed_at === undefined
      ? null
      : { totalMills: num(row.signed_total_mills), count: num(row.signed_count), at: date(row.signed_at) },
    expectedReviewerPersonId: nullableNum(row.expected_reviewer_person_id),
  };
}

/**
 * A new candidate of the report, the next number; every earlier one not confirmed and not superseded yet is superseded
 * by it. `signed` — the person's signature at «Сдать смену» (only their own door, only what equals the candidate). Run
 * in the caller's transaction after the report's lock.
 */
export async function insertHandinCandidate(
  db: Database,
  input: {
    handinId: number;
    door: HandinDoor;
    actorUserId: number | null;
    agentKeyId: number | null;
    telegramMessageRef: string | null;
    telegramSenderId: number | null;
    cutoffAt: Date;
    totalMills: number;
    pages: readonly HandinVersionPage[];
    lines: readonly HandinVersionLine[];
    offPlatform: readonly HandinVersionOffPlatform[];
    comment: string;
    modelComments: Readonly<Record<string, string>>;
    ruleVersion: string;
    hubCheck: readonly CandidateHubPage[];
    signed?: { totalMills: number; count: number } | null;
    expectedReviewerPersonId: number | null;
    at: Date;
  },
): Promise<CandidateRow> {
  const at = input.at.toISOString();
  const signed = input.signed ?? null;
  const result = await db.execute<Row>(sql`
    insert into shift_handin_candidates (handin_id, number, made_at, door, actor_user_id, agent_key_id, telegram_message_ref, telegram_sender_id,
      cutoff_at, total_mills, pages, lines, off_platform, comment, model_comments, rule_version, hub_check, signed_total_mills, signed_count, signed_at,
      expected_reviewer_person_id)
    values (${input.handinId},
      (select coalesce(max(number), 0) + 1 from shift_handin_candidates where handin_id = ${input.handinId}),
      ${at}::timestamptz, ${input.door}, ${input.actorUserId}, ${input.agentKeyId}, ${input.telegramMessageRef}, ${input.telegramSenderId},
      ${input.cutoffAt.toISOString()}::timestamptz, ${input.totalMills}, ${JSON.stringify(input.pages)}::jsonb, ${JSON.stringify(input.lines)}::jsonb,
      ${JSON.stringify(input.offPlatform)}::jsonb, ${input.comment}, ${JSON.stringify(input.modelComments)}::jsonb, ${input.ruleVersion},
      ${JSON.stringify(input.hubCheck)}::jsonb, ${signed?.totalMills ?? null}, ${signed?.count ?? null}, ${signed === null ? null : at}::timestamptz,
      ${input.expectedReviewerPersonId})
    returning ${sql.raw(CANDIDATE_COLUMNS_RAW)}`);
  const made = candidateOf(result.rows[0]!);
  await db.execute(sql`
    update shift_handin_candidates set superseded_at = ${at}::timestamptz, superseded_by = ${made.id}
    where handin_id = ${input.handinId} and id <> ${made.id} and superseded_at is null and confirmed_at is null`);
  return made;
}

const CANDIDATE_COLUMNS_RAW = `id, handin_id, number, made_at, door, actor_user_id, agent_key_id, telegram_message_ref,
  telegram_sender_id, cutoff_at, total_mills, pages, lines, off_platform, comment, model_comments, rule_version, hub_check,
  hub_checked_at, gengar_answered_at, gengar_clean, superseded_at, superseded_by, confirmed_version, confirmed_at,
  signed_total_mills, signed_count, signed_at, expected_reviewer_person_id`;

/** Every candidate of a report, oldest first. */
export async function listHandinCandidates(db: Database, handinId: number): Promise<CandidateRow[]> {
  const result = await db.execute<Row>(sql`select ${CANDIDATE_COLUMNS} from shift_handin_candidates c where c.handin_id = ${handinId} order by c.number`);
  return result.rows.map(candidateOf);
}

/** The newest candidate of each report named, by report id (one query for a window of reports). */
export async function listLatestHandinCandidates(db: Database, handinIds: readonly number[]): Promise<Map<number, CandidateRow>> {
  if (handinIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select distinct on (c.handin_id) ${CANDIDATE_COLUMNS} from shift_handin_candidates c
    where c.handin_id = any(${ids(handinIds)}) order by c.handin_id, c.number desc`);
  return new Map(result.rows.map((row) => {
    const candidate = candidateOf(row);
    return [candidate.handinId, candidate];
  }));
}

export async function findHandinCandidate(db: Database, id: number, options: { lock?: boolean } = {}): Promise<CandidateRow | null> {
  const result = await db.execute<Row>(sql`
    select ${CANDIDATE_COLUMNS} from shift_handin_candidates c where c.id = ${id} ${options.lock ? sql`for update` : sql``}`);
  return result.rows[0] === undefined ? null : candidateOf(result.rows[0]);
}

/**
 * Candidates awaiting check by `reviewerPersonId`: not superseded, unanswered, assigned to this reviewer in the key's
 * realm with every shift page inside `pageIds`, made since `since`; filtered BEFORE `limit`, oldest first.
 */
export async function listCandidatesAwaitingCheck(
  db: Database,
  input: { reviewerPersonId: number; pageIds: readonly number[]; realm: "live" | "test"; since: Date; limit: number },
): Promise<Array<CandidateRow & { shiftId: number; userId: number }>> {
  const uniquePages = [...new Set(input.pageIds)];
  if (uniquePages.length === 0) return [];
  const realm = input.realm === "test" ? testUserSql(sql`s.user_id`) : liveUserSql(sql`s.user_id`);
  const result = await db.execute<Row>(sql`
    select ${CANDIDATE_COLUMNS}, h.shift_id, h.user_id
    from shift_handin_candidates c
    join shift_handins h on h.id = c.handin_id
    join shifts s on s.id = h.shift_id
    where c.superseded_at is null
      and c.gengar_answered_at is null
      and c.expected_reviewer_person_id = ${input.reviewerPersonId}
      and c.made_at >= ${input.since.toISOString()}::timestamptz
      and s.state <> 'dropped'
      and ${realm}
      and not exists (
        select 1
        from jsonb_array_elements(s.pages) as sp(item)
        left join pages pg on pg.label = sp.item ->> 'pageLabel'
        where pg.id is null or not (pg.id = any(${ids(uniquePages)}))
      )
    order by c.made_at, c.id
    limit ${input.limit}`);
  return result.rows.map((row) => ({ ...candidateOf(row), shiftId: num(row.shift_id), userId: num(row.user_id) }));
}

/** Hub's check of a candidate's pages (the reconciliation's result); `done` — every page has its answer. */
export async function setCandidateHubCheck(db: Database, input: { candidateId: number; pages: readonly CandidateHubPage[]; done: boolean; at: Date }): Promise<void> {
  await db.execute(sql`
    update shift_handin_candidates set hub_check = ${JSON.stringify(input.pages)}::jsonb,
      hub_checked_at = ${input.done ? input.at.toISOString() : null}::timestamptz
    where id = ${input.candidateId}`);
}

/** Gengar answered: clean («замечаний нет») or with proposals. Once only: false — already answered. */
export async function setCandidateGengarAnswer(db: Database, input: { candidateId: number; clean: boolean; at: Date }): Promise<boolean> {
  const result = await db.execute(sql`
    update shift_handin_candidates set gengar_answered_at = ${input.at.toISOString()}::timestamptz, gengar_clean = ${input.clean}
    where id = ${input.candidateId} and gengar_answered_at is null`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * The person's signature is not applied (the check changed the report, or the confirmation refused): cleared, so the
 * person confirms by hand and nothing tries it again. A confirmed candidate keeps its signature (what counted it).
 * False — it was not signed (any more), or it is confirmed.
 */
export async function clearCandidateSignature(db: Database, input: { candidateId: number }): Promise<boolean> {
  const result = await db.execute(sql`
    update shift_handin_candidates set signed_total_mills = null, signed_count = null, signed_at = null
    where id = ${input.candidateId} and signed_at is not null and confirmed_at is null`);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Reports in «Подтвердите» whose open candidate (not superseded, not confirmed) the person signed at «Сдать смену»: the
 * server applies the signature or clears it (shift-report-board.ts `applyHandInSignature`). Oldest first.
 */
export async function listSignedConfirmHandins(db: Database, input: { limit: number }): Promise<Array<{ handinId: number; shiftId: number }>> {
  const result = await db.execute<Row>(sql`
    select h.id, h.shift_id from shift_handins h
    join shift_handin_candidates c on c.handin_id = h.id
    where h.phase = 'confirm' and c.signed_at is not null and c.superseded_at is null and c.confirmed_at is null
    order by h.phase_at nulls first, h.id limit ${input.limit}`);
  return result.rows.map((row) => ({ handinId: num(row.id), shiftId: num(row.shift_id) }));
}

/** Whether the report has an event of this name since the moment (`object_events`, by the object's index). */
export async function hasHandinEventSince(db: Database, input: { handinId: number; event: string; since: Date }): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    select 1 from object_events
    where object_type = 'shift_report' and object_id = ${String(input.handinId)} and event = ${input.event}
      and created_at >= ${input.since.toISOString()}::timestamptz
    limit 1`);
  return result.rows.length > 0;
}

/** «Подтверждаю» made `version` from the candidate. */
export async function setCandidateConfirmed(db: Database, input: { candidateId: number; version: number; at: Date }): Promise<void> {
  await db.execute(sql`
    update shift_handin_candidates set confirmed_version = ${input.version}, confirmed_at = ${input.at.toISOString()}::timestamptz
    where id = ${input.candidateId} and confirmed_at is null`);
}

// ── Proposals ────────────────────────────────────────────────────────────────

export type ProposalWord = "mine" | "not_mine" | "share" | "give" | "pot" | "rule";
export type ProposalState = "proposed" | "declined" | "accepted" | "late";

export interface ProposalRow {
  id: number;
  candidateId: number;
  handinId: number;
  transactionId: number;
  kind: "owner_change" | "note";
  fromWord: ProposalWord | null;
  fromUserId: number | null;
  toWord: ProposalWord | null;
  toUserId: number | null;
  note: string | null;
  deltaMills: number;
  why: string;
  messageRefs: string[];
  state: ProposalState;
  afterCounted: boolean;
  agentKeyId: number;
  createdAt: Date;
  answeredAt: Date | null;
  answeredByUserId: number | null;
}

function proposalOf(row: Row): ProposalRow {
  return {
    id: num(row.id),
    candidateId: num(row.candidate_id),
    handinId: num(row.handin_id),
    transactionId: num(row.transaction_id),
    kind: row.kind as ProposalRow["kind"],
    fromWord: (row.from_word ?? null) as ProposalWord | null,
    fromUserId: nullableNum(row.from_user_id),
    toWord: (row.to_word ?? null) as ProposalWord | null,
    toUserId: nullableNum(row.to_user_id),
    note: text(row.note),
    deltaMills: num(row.delta_mills),
    why: String(row.why),
    messageRefs: jsonArray<unknown>(row.message_refs).map(String),
    state: row.state as ProposalState,
    afterCounted: Boolean(row.after_counted),
    agentKeyId: num(row.agent_key_id),
    createdAt: date(row.created_at),
    answeredAt: nullableDate(row.answered_at),
    answeredByUserId: nullableNum(row.answered_by_user_id),
  };
}

export async function insertHandinProposal(
  db: Database,
  input: Omit<ProposalRow, "id" | "createdAt" | "answeredAt" | "answeredByUserId">,
  at: Date,
): Promise<ProposalRow> {
  const result = await db.execute<Row>(sql`
    insert into shift_handin_proposals (candidate_id, handin_id, transaction_id, kind, from_word, from_user_id, to_word, to_user_id, note,
      delta_mills, why, message_refs, state, after_counted, agent_key_id, created_at)
    values (${input.candidateId}, ${input.handinId}, ${input.transactionId}, ${input.kind}, ${input.fromWord}, ${input.fromUserId},
      ${input.toWord}, ${input.toUserId}, ${input.note}, ${input.deltaMills}, ${input.why}, ${JSON.stringify(input.messageRefs)}::jsonb,
      ${input.state}, ${input.afterCounted}, ${input.agentKeyId}, ${at.toISOString()}::timestamptz)
    returning *`);
  return proposalOf(result.rows[0]!);
}

/** The proposals of a report, oldest first. */
export async function listHandinProposals(db: Database, handinId: number): Promise<ProposalRow[]> {
  const result = await db.execute<Row>(sql`select * from shift_handin_proposals where handin_id = ${handinId} order by id`);
  return result.rows.map(proposalOf);
}

/** How many proposals of each kind Gengar made on each candidate named, by candidate id (one query). */
export async function countHandinProposals(db: Database, candidateIds: readonly number[]): Promise<Map<number, { ownerChange: number; note: number }>> {
  if (candidateIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select candidate_id, count(*) filter (where kind = 'owner_change') as owner_change, count(*) filter (where kind = 'note') as note
    from shift_handin_proposals where candidate_id = any(${ids(candidateIds)}) group by candidate_id`);
  return new Map(result.rows.map((row) => [num(row.candidate_id), { ownerChange: num(row.owner_change), note: num(row.note) }]));
}

export async function findHandinProposal(db: Database, id: number, options: { lock?: boolean } = {}): Promise<ProposalRow | null> {
  const result = await db.execute<Row>(sql`select * from shift_handin_proposals where id = ${id} ${options.lock ? sql`for update` : sql``}`);
  return result.rows[0] === undefined ? null : proposalOf(result.rows[0]);
}

/** The person's answer to a card: declined, accepted, or back to proposed («Вернуть правку»). */
export async function setHandinProposalState(db: Database, input: { id: number; state: ProposalState; byUserId: number | null; at: Date }): Promise<void> {
  const answered = input.state === "declined" || input.state === "accepted";
  await db.execute(sql`
    update shift_handin_proposals set state = ${input.state},
      answered_at = ${answered ? input.at.toISOString() : null}::timestamptz, answered_by_user_id = ${answered ? input.byUserId : null}
    where id = ${input.id}`);
}

/** Reports with late proposals not answered (the person's matter «Генгар дочитал»). */
export async function listLateProposalHandins(db: Database): Promise<Array<{ handinId: number; count: number }>> {
  const result = await db.execute<Row>(sql`
    select handin_id, count(*)::int as n from shift_handin_proposals where state = 'late' group by handin_id`);
  return result.rows.map((row) => ({ handinId: num(row.handin_id), count: num(row.n) }));
}

// ── «Нет в Hub»: sightings ──────────────────────────────────────────────────

export interface SaleSightingRow {
  id: number;
  pageId: number;
  platformRef: string;
  kind: string;
  fanRef: string | null;
  fanName: string | null;
  occurredAt: Date;
  grossMills: number | null;
  netMills: number;
  seenByUserId: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  matchedTransactionId: number | null;
  matchedAt: Date | null;
  addedHandinId: number | null;
  addedAt: Date | null;
}

function sightingOf(row: Row): SaleSightingRow {
  return {
    id: num(row.id),
    pageId: num(row.page_id),
    platformRef: String(row.platform_ref),
    kind: String(row.kind),
    fanRef: text(row.fan_ref),
    fanName: text(row.fan_name),
    occurredAt: date(row.occurred_at),
    grossMills: nullableNum(row.gross_mills),
    netMills: num(row.net_mills),
    seenByUserId: nullableNum(row.seen_by_user_id),
    firstSeenAt: date(row.first_seen_at),
    lastSeenAt: date(row.last_seen_at),
    matchedTransactionId: nullableNum(row.matched_transaction_id),
    matchedAt: nullableDate(row.matched_at),
    addedHandinId: nullableNum(row.added_handin_id),
    addedAt: nullableDate(row.added_at),
  };
}

/** A sighting kept, or seen again (by page and platform reference): its last moment moves, nothing else. */
export async function upsertSaleSighting(
  db: Database,
  input: Omit<SaleSightingRow, "id" | "firstSeenAt" | "lastSeenAt" | "matchedTransactionId" | "matchedAt" | "addedHandinId" | "addedAt"> & { seenByDeviceTokenId: number | null },
  at: Date,
): Promise<void> {
  await db.execute(sql`
    insert into sale_sightings (page_id, platform_ref, kind, fan_ref, fan_name, occurred_at, gross_mills, net_mills, seen_by_user_id,
      seen_by_device_token_id, first_seen_at, last_seen_at)
    values (${input.pageId}, ${input.platformRef}, ${input.kind}, ${input.fanRef}, ${input.fanName}, ${input.occurredAt.toISOString()}::timestamptz,
      ${input.grossMills}, ${input.netMills}, ${input.seenByUserId}, ${input.seenByDeviceTokenId}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz)
    on conflict (page_id, platform_ref) do update set last_seen_at = excluded.last_seen_at`);
}

/** Sightings Hub does not hold yet, on the pages, in the window. */
export async function listOpenSaleSightings(db: Database, input: { pageIds: readonly number[]; from: Date; to: Date }): Promise<SaleSightingRow[]> {
  if (input.pageIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select * from sale_sightings
    where page_id = any(${ids(input.pageIds)}) and matched_transaction_id is null
      and occurred_at >= ${input.from.toISOString()}::timestamptz and occurred_at < ${input.to.toISOString()}::timestamptz
    order by occurred_at desc, id`);
  return result.rows.map(sightingOf);
}

export async function findSaleSighting(db: Database, id: number, options: { lock?: boolean } = {}): Promise<SaleSightingRow | null> {
  const result = await db.execute<Row>(sql`select * from sale_sightings where id = ${id} ${options.lock ? sql`for update` : sql``}`);
  return result.rows[0] === undefined ? null : sightingOf(result.rows[0]);
}

/** «Добавить»: the person took the sighting into their report. False — someone already did, or Hub holds it now. */
export async function setSaleSightingAdded(db: Database, input: { id: number; handinId: number; byUserId: number; at: Date }): Promise<boolean> {
  const result = await db.execute(sql`
    update sale_sightings set added_handin_id = ${input.handinId}, added_at = ${input.at.toISOString()}::timestamptz, added_by_user_id = ${input.byUserId}
    where id = ${input.id} and added_handin_id is null and matched_transaction_id is null`);
  return (result.rowCount ?? 0) > 0;
}

/** Hub holds the sale now: the sighting is matched to its transaction (the reconciliation's interface). */
export async function setSaleSightingMatched(db: Database, input: { id: number; transactionId: number; at: Date }): Promise<void> {
  await db.execute(sql`
    update sale_sightings set matched_transaction_id = ${input.transactionId}, matched_at = ${iso(input.at)}::timestamptz
    where id = ${input.id} and matched_transaction_id is null`);
}

/** Which of the platform references a page already holds as transactions. */
export async function listKnownPlatformRefs(db: Database, input: { pageId: number; refs: readonly string[] }): Promise<Set<string>> {
  if (input.refs.length === 0) return new Set();
  const result = await db.execute<Row>(sql`
    select transaction_id as ref from transactions
    where platform_account_id = ${input.pageId} and transaction_id = any(${sql.param([...input.refs])}::text[])`);
  return new Set(result.rows.map((row) => String(row.ref)));
}

/** The platform's own ids of Hub's transactions (Fansly's wallet number), by Hub's id. */
export async function listTransactionPlatformRefs(db: Database, transactionIds: readonly number[]): Promise<Map<number, { ref: string; grossMills: number }>> {
  if (transactionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select id, transaction_id, gross_amount_mills from transactions where id = any(${ids(transactionIds)})`);
  return new Map(result.rows.map((row) => [num(row.id), { ref: String(row.transaction_id), grossMills: num(row.gross_amount_mills) }]));
}

/**
 * Active reviewer agents of one realm in the people registry (`people.kind = 'agent'`, `state <> 'left'`) holding a
 * live key (`review:shift_reports`, not revoked, not expired) whose page grant covers ALL of `pageIds`, ordered
 * alphabetically by `people.code`. An agent with two live keys during replacement grace appears once.
 */
export async function listShiftReportReviewers(
  db: Database,
  input: { pageIds: readonly number[]; realm: "live" | "test"; at?: Date },
): Promise<Array<{ personId: number; code: string }>> {
  const unique = [...new Set(input.pageIds)];
  if (unique.length === 0) return [];
  const at = (input.at ?? new Date()).toISOString();
  const realm = input.realm === "test" ? sql`p.is_test` : sql`not p.is_test`;
  const result = await db.execute<Row>(sql`
    select p.id, p.code
    from people p
    where p.kind = 'agent'
      and p.state <> 'left'
      and ${realm}
      and exists (
        select 1
        from person_agent_keys pak
        join agent_keys k on k.id = pak.agent_key_id
        where pak.person_id = p.id
          and 'review:shift_reports' = any(k.capabilities)
          and k.revoked_at is null
          and k.expires_at > ${at}::timestamptz
          and k.page_ids @> ${ids(unique)}
      )
    order by p.code, p.id`);
  return result.rows.map((row) => ({ personId: num(row.id), code: String(row.code) }));
}
