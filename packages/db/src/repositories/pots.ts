import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Workboard pots (0443, H11): switch (`pots_switch`), pot definitions (`pots`), immutable posted distributions
// (`pot_distributions`), and their consumed sale parts (`pot_distribution_parts`).
// Global advisory lock `lockWorkboardPots` enforces remaining-base integrity across ALL pots; lock order is strictly
// `settlements -> refresh_day -> pots`.

type Row = Record<string, unknown>;
const num = (value: unknown) => Number(value);
const text = (value: unknown) => (value === null || value === undefined ? null : String(value));
const ids = (values: readonly number[]) => sql`${sql.param(values.map(String))}::bigint[]`;
const textArr = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;

function numArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "{}" || trimmed === "") return [];
    return trimmed.slice(1, -1).split(",").filter((s) => s !== "").map(Number);
  }
  return [];
}

function strArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "{}" || trimmed === "") return [];
    return trimmed.slice(1, -1).split(",").filter((s) => s !== "").map((s) => s.replace(/^"|"$/g, ""));
  }
  return [];
}

function jsonOf<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

// ── Lock ─────────────────────────────────────────────────────────────────────

/**
 * Global transaction advisory lock for Workboard pot writes and remaining-base checks.
 * Lock order across Hub is strictly `settlements -> refresh_day -> pots`. Never hold across ledger HTTP.
 */
export async function lockWorkboardPots(db: Database): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended('workboard_pots', 0))`);
}

// ── Switch (`pots_switch`) ───────────────────────────────────────────────────

export interface PotsSwitch {
  /** First Moscow day (YYYY-MM-DD) pots live in Workboard; null — off (days stay in ledger). */
  potsFrom: string | null;
  setBy: string | null;
  setAt: Date | null;
}

export async function readPotsSwitch(db: Database): Promise<PotsSwitch> {
  const result = await db.execute<{ pots_from: string | null; set_by: string | null; set_at: Date | string | null }>(sql`
    select to_char(pots_from, 'YYYY-MM-DD') as pots_from, set_by, set_at from pots_switch where id`);
  const row = result.rows[0];
  return {
    potsFrom: row?.pots_from ?? null,
    setBy: row?.set_by ?? null,
    setAt: row?.set_at === null || row?.set_at === undefined ? null : new Date(row.set_at),
  };
}

export async function setPotsSwitch(db: Database, input: { potsFrom: string | null; setBy: string; at: Date }): Promise<void> {
  await db.execute(sql`
    insert into pots_switch (id, pots_from, set_by, set_at)
    values (true, ${input.potsFrom}::date, ${input.setBy}, ${input.at.toISOString()}::timestamptz)
    on conflict (id) do update set pots_from = excluded.pots_from, set_by = excluded.set_by, set_at = excluded.set_at`);
}

export async function countActivePotDistributions(db: Database): Promise<number> {
  const result = await db.execute<{ n: string | number }>(sql`
    select count(*)::bigint as n from pot_distributions where reversed_at is null`);
  return num(result.rows[0]?.n ?? 0);
}

// ── Pots (`pots`) ────────────────────────────────────────────────────────────

export type PotIntakeReason = "post_tip" | "campaign";
export type PotParticipantsMode = "page_workers" | "listed";
export type PotState = "open" | "closed";
export type PotFormulaKind = "equal" | "weights" | "manual";

export interface PotParticipantPeriodRow {
  personCode: string;
  fromDay: string;
  toDay: string | null;
}

export interface PotFormulaRow {
  kind: PotFormulaKind;
  params: Record<string, unknown>;
}

export interface PotRow {
  id: number;
  code: string;
  name: string;
  modelId: number;
  modelSlug: string;
  modelName: string;
  isTest: boolean;
  pageIds: number[];
  intakeReasons: PotIntakeReason[];
  opensOn: string;
  closesOn: string | null;
  participantsMode: PotParticipantsMode;
  participants: PotParticipantPeriodRow[];
  formula: PotFormulaRow;
  autoPost: boolean;
  state: PotState;
  createdByUserId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

function potOf(row: Row): PotRow {
  const formula = jsonOf<PotFormulaRow>(row.formula, { kind: "equal", params: {} });
  return {
    id: num(row.id),
    code: String(row.code),
    name: String(row.name),
    modelId: num(row.model_id),
    modelSlug: String(row.model_slug),
    modelName: String(row.model_name),
    isTest: Boolean(row.is_test),
    pageIds: numArray(row.page_ids),
    intakeReasons: strArray(row.intake_reasons) as PotIntakeReason[],
    opensOn: String(row.opens_on),
    closesOn: text(row.closes_on),
    participantsMode: String(row.participants_mode) as PotParticipantsMode,
    participants: jsonOf<PotParticipantPeriodRow[]>(row.participants, []),
    formula: {
      kind: formula.kind,
      params: formula.params && typeof formula.params === "object" && !Array.isArray(formula.params) ? formula.params : {},
    },
    autoPost: Boolean(row.auto_post),
    state: String(row.state) as PotState,
    createdByUserId: row.created_by_user_id === null || row.created_by_user_id === undefined ? null : num(row.created_by_user_id),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

const POT_SELECT = sql`
  select p.id, p.code, p.name, p.model_id, m.slug as model_slug, m.name as model_name, m.is_test,
    p.page_ids, p.intake_reasons,
    to_char(p.opens_on, 'YYYY-MM-DD') as opens_on,
    to_char(p.closes_on, 'YYYY-MM-DD') as closes_on,
    p.participants_mode, p.participants, p.formula, p.auto_post, p.state,
    p.created_by_user_id, p.created_at, p.updated_at
  from pots p
  join models m on m.id = p.model_id`;

export async function listPots(db: Database, realm: "live" | "test" | "both" = "live"): Promise<PotRow[]> {
  const where = realm === "both" ? sql`` : realm === "test" ? sql`where m.is_test` : sql`where not m.is_test`;
  const result = await db.execute<Row>(sql`
    ${POT_SELECT}
    ${where}
    order by (p.state = 'open') desc, p.opens_on desc, p.code asc`);
  return result.rows.map(potOf);
}

export async function findPotById(db: Database, id: number): Promise<PotRow | null> {
  const result = await db.execute<Row>(sql`${POT_SELECT} where p.id = ${id}`);
  return result.rows[0] ? potOf(result.rows[0]) : null;
}

export async function findPotByCode(db: Database, code: string): Promise<PotRow | null> {
  const result = await db.execute<Row>(sql`${POT_SELECT} where p.code = ${code}`);
  return result.rows[0] ? potOf(result.rows[0]) : null;
}

export interface PotInsert {
  code: string;
  name: string;
  modelId: number;
  pageIds: readonly number[];
  intakeReasons: readonly PotIntakeReason[];
  opensOn: string;
  closesOn: string | null;
  participantsMode: PotParticipantsMode;
  participants: readonly PotParticipantPeriodRow[];
  formula: PotFormulaRow;
  autoPost: boolean;
  createdByUserId: number | null;
}

export async function insertPot(db: Database, input: PotInsert, at: Date): Promise<PotRow> {
  const result = await db.execute<{ id: string | number }>(sql`
    insert into pots (
      code, name, model_id, page_ids, intake_reasons, opens_on, closes_on,
      participants_mode, participants, formula, auto_post, state, created_by_user_id, created_at, updated_at
    ) values (
      ${input.code}, ${input.name}, ${input.modelId}, ${ids(input.pageIds)}, ${textArr(input.intakeReasons)},
      ${input.opensOn}::date, ${input.closesOn}::date,
      ${input.participantsMode}, ${JSON.stringify(input.participants)}::jsonb, ${JSON.stringify(input.formula)}::jsonb,
      ${input.autoPost}, 'open', ${input.createdByUserId}, ${at.toISOString()}::timestamptz, ${at.toISOString()}::timestamptz
    ) returning id`);
  return (await findPotById(db, num(result.rows[0]!.id)))!;
}

export interface PotUpdatePatch {
  name?: string;
  pageIds?: readonly number[];
  intakeReasons?: readonly PotIntakeReason[];
  opensOn?: string;
  closesOn?: string | null;
  participantsMode?: PotParticipantsMode;
  participants?: readonly PotParticipantPeriodRow[];
  formula?: PotFormulaRow;
  autoPost?: boolean;
}

export async function updatePot(db: Database, id: number, patch: PotUpdatePatch, at: Date): Promise<PotRow | null> {
  const existing = await findPotById(db, id);
  if (existing === null) return null;
  const next = {
    name: patch.name ?? existing.name,
    pageIds: patch.pageIds ?? existing.pageIds,
    intakeReasons: patch.intakeReasons ?? existing.intakeReasons,
    opensOn: patch.opensOn ?? existing.opensOn,
    closesOn: patch.closesOn !== undefined ? patch.closesOn : existing.closesOn,
    participantsMode: patch.participantsMode ?? existing.participantsMode,
    participants: patch.participants ?? existing.participants,
    formula: patch.formula ?? existing.formula,
    autoPost: patch.autoPost ?? existing.autoPost,
  };
  await db.execute(sql`
    update pots set
      name = ${next.name},
      page_ids = ${ids(next.pageIds)},
      intake_reasons = ${textArr(next.intakeReasons)},
      opens_on = ${next.opensOn}::date,
      closes_on = ${next.closesOn}::date,
      participants_mode = ${next.participantsMode},
      participants = ${JSON.stringify(next.participants)}::jsonb,
      formula = ${JSON.stringify(next.formula)}::jsonb,
      auto_post = ${next.autoPost},
      updated_at = ${at.toISOString()}::timestamptz
    where id = ${id}`);
  return findPotById(db, id);
}

export async function closePotRow(db: Database, id: number, at: Date): Promise<boolean> {
  const result = await db.execute(sql`
    update pots set state = 'closed', updated_at = ${at.toISOString()}::timestamptz
    where id = ${id} and state = 'open'`);
  return (result.rowCount ?? 0) > 0;
}

// ── Distributions (`pot_distributions` & `pot_distribution_parts`) ───────────

export interface PotDistributionLineRow {
  personCode: string;
  baseMills: number;
  basis: string;
}

export interface PotDistributionPartRow {
  distributionId: number;
  transactionId: number;
  pageId: number;
  pageLabel: string | null;
  baseMills: number;
}

export interface PotDistributionRow {
  id: number;
  potId: number;
  day: string;
  formula: PotFormulaRow;
  baseMills: number;
  lines: PotDistributionLineRow[];
  postedAt: Date;
  postedByUserId: number | null;
  reversedAt: Date | null;
  reversedByUserId: number | null;
  reversedReason: string | null;
  parts: PotDistributionPartRow[];
}

function distributionOf(row: Row, parts: PotDistributionPartRow[]): PotDistributionRow {
  const formula = jsonOf<PotFormulaRow>(row.formula, { kind: "equal", params: {} });
  return {
    id: num(row.id),
    potId: num(row.pot_id),
    day: String(row.day),
    formula: {
      kind: formula.kind,
      params: formula.params && typeof formula.params === "object" && !Array.isArray(formula.params) ? formula.params : {},
    },
    baseMills: num(row.base_mills),
    lines: jsonOf<PotDistributionLineRow[]>(row.lines, []),
    postedAt: new Date(String(row.posted_at)),
    postedByUserId: row.posted_by_user_id === null || row.posted_by_user_id === undefined ? null : num(row.posted_by_user_id),
    reversedAt: row.reversed_at === null || row.reversed_at === undefined ? null : new Date(String(row.reversed_at)),
    reversedByUserId: row.reversed_by_user_id === null || row.reversed_by_user_id === undefined ? null : num(row.reversed_by_user_id),
    reversedReason: text(row.reversed_reason),
    parts,
  };
}

export async function insertPotDistribution(
  db: Database,
  input: {
    potId: number;
    day: string;
    formula: PotFormulaRow;
    baseMills: number;
    lines: readonly PotDistributionLineRow[];
    parts: ReadonlyArray<{ transactionId: number; pageId: number; baseMills: number }>;
    postedByUserId: number | null;
    postedAt: Date;
  },
): Promise<PotDistributionRow> {
  const inserted = await db.execute<{ id: string | number }>(sql`
    insert into pot_distributions (pot_id, day, formula, base_mills, lines, posted_at, posted_by_user_id)
    values (
      ${input.potId}, ${input.day}::date, ${JSON.stringify(input.formula)}::jsonb,
      ${input.baseMills}, ${JSON.stringify(input.lines)}::jsonb,
      ${input.postedAt.toISOString()}::timestamptz, ${input.postedByUserId}
    ) returning id`);
  const distributionId = num(inserted.rows[0]!.id);
  const partsPayload = input.parts.map((part) => ({
    distribution_id: distributionId,
    transaction_id: part.transactionId,
    page_id: part.pageId,
    base_mills: part.baseMills,
  }));
  await db.execute(sql`
    insert into pot_distribution_parts (distribution_id, transaction_id, page_id, base_mills)
    select r.distribution_id, r.transaction_id, r.page_id, r.base_mills
    from jsonb_to_recordset(${JSON.stringify(partsPayload)}::jsonb) as r(
      distribution_id bigint, transaction_id bigint, page_id bigint, base_mills bigint
    )`);
  return (await findPotDistributionById(db, distributionId))!;
}

export async function reversePotDistributionRow(
  db: Database,
  input: { distributionId: number; reversedByUserId: number | null; reason: string; at: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update pot_distributions
    set reversed_at = ${input.at.toISOString()}::timestamptz,
        reversed_by_user_id = ${input.reversedByUserId},
        reversed_reason = ${input.reason}
    where id = ${input.distributionId} and reversed_at is null`);
  return (result.rowCount ?? 0) > 0;
}

async function listPartsByDistributionIds(db: Database, distributionIds: readonly number[]): Promise<Map<number, PotDistributionPartRow[]>> {
  if (distributionIds.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select pp.distribution_id, pp.transaction_id, pp.page_id, p.label as page_label, pp.base_mills
    from pot_distribution_parts pp
    left join pages p on p.id = pp.page_id
    where pp.distribution_id = any(${ids(distributionIds)})
    order by pp.distribution_id, pp.transaction_id`);
  const out = new Map<number, PotDistributionPartRow[]>();
  for (const row of result.rows) {
    const distributionId = num(row.distribution_id);
    const list = out.get(distributionId) ?? [];
    list.push({
      distributionId,
      transactionId: num(row.transaction_id),
      pageId: num(row.page_id),
      pageLabel: text(row.page_label),
      baseMills: num(row.base_mills),
    });
    out.set(distributionId, list);
  }
  return out;
}

export async function findPotDistributionById(db: Database, id: number): Promise<PotDistributionRow | null> {
  const result = await db.execute<Row>(sql`
    select id, pot_id, to_char(day, 'YYYY-MM-DD') as day, formula, base_mills, lines,
      posted_at, posted_by_user_id, reversed_at, reversed_by_user_id, reversed_reason
    from pot_distributions
    where id = ${id}`);
  const row = result.rows[0];
  if (!row) return null;
  const parts = await listPartsByDistributionIds(db, [id]);
  return distributionOf(row, parts.get(id) ?? []);
}

export async function listPotDistributions(db: Database, potId: number): Promise<PotDistributionRow[]> {
  const result = await db.execute<Row>(sql`
    select id, pot_id, to_char(day, 'YYYY-MM-DD') as day, formula, base_mills, lines,
      posted_at, posted_by_user_id, reversed_at, reversed_by_user_id, reversed_reason
    from pot_distributions
    where pot_id = ${potId}
    order by day desc, id desc`);
  const distIds = result.rows.map((row) => num(row.id));
  const parts = await listPartsByDistributionIds(db, distIds);
  return result.rows.map((row) => distributionOf(row, parts.get(num(row.id)) ?? []));
}

/**
 * Sum of non-reversed distributed `base_mills` across ALL pots for the named `transactionIds`.
 * This is the global remaining-base invariant check: prevents double-distribution even when a sale moves pots.
 */
export async function sumActiveDistributedByTransactions(db: Database, transactionIds: readonly number[]): Promise<Map<number, number>> {
  const unique = [...new Set(transactionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const result = await db.execute<{ transaction_id: string | number; total_mills: string | number }>(sql`
    select pp.transaction_id, coalesce(sum(pp.base_mills), 0)::bigint as total_mills
    from pot_distribution_parts pp
    join pot_distributions d on d.id = pp.distribution_id
    where d.reversed_at is null and pp.transaction_id = any(${ids(unique)})
    group by pp.transaction_id`);
  return new Map(result.rows.map((row) => [num(row.transaction_id), num(row.total_mills)]));
}

/** Sum of non-reversed distributed `base_mills` per transaction WITHIN one specific pot. */
export async function sumActiveDistributedByTransactionsInPot(
  db: Database,
  potId: number,
  transactionIds: readonly number[],
): Promise<Map<number, number>> {
  const unique = [...new Set(transactionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const result = await db.execute<{ transaction_id: string | number; total_mills: string | number }>(sql`
    select pp.transaction_id, coalesce(sum(pp.base_mills), 0)::bigint as total_mills
    from pot_distribution_parts pp
    join pot_distributions d on d.id = pp.distribution_id
    where d.reversed_at is null and d.pot_id = ${potId} and pp.transaction_id = any(${ids(unique)})
    group by pp.transaction_id`);
  return new Map(result.rows.map((row) => [num(row.transaction_id), num(row.total_mills)]));
}

/** Non-reversed distribution totals and counts per pot id. */
export async function summarizeActiveDistributionsByPot(
  db: Database,
  potIds: readonly number[],
): Promise<Map<number, { postedBaseMills: number; distributionsCount: number }>> {
  const unique = [...new Set(potIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const result = await db.execute<{ pot_id: string | number; posted_base_mills: string | number; dist_count: string | number }>(sql`
    select pot_id, coalesce(sum(base_mills), 0)::bigint as posted_base_mills, count(*)::bigint as dist_count
    from pot_distributions
    where reversed_at is null and pot_id = any(${ids(unique)})
    group by pot_id`);
  return new Map(result.rows.map((row) => [
    num(row.pot_id),
    { postedBaseMills: num(row.posted_base_mills), distributionsCount: num(row.dist_count) },
  ]));
}

// ── Eligible `sale_homes` reads & day-reconciliation reads ───────────────────

export interface PotSaleHomeRow {
  transactionId: number;
  pageId: number;
  pageLabel: string;
  modelId: number;
  modelSlug: string;
  isTest: boolean;
  canonicalType: string;
  occurredAt: Date;
  day: string;
  netMills: number;
  home: string;
  reason: string;
  pot: string | null;
}

function potSaleHomeOf(row: Row): PotSaleHomeRow {
  return {
    transactionId: num(row.transaction_id),
    pageId: num(row.page_id),
    pageLabel: String(row.page_label),
    modelId: num(row.model_id),
    modelSlug: String(row.model_slug),
    isTest: Boolean(row.is_test),
    canonicalType: String(row.canonical_type ?? "tip"),
    occurredAt: new Date(String(row.occurred_at)),
    day: String(row.day),
    netMills: num(row.net_mills),
    home: String(row.home),
    reason: String(row.reason),
    pot: text(row.pot),
  };
}

/** All `sale_homes` rows with `home = 'pot'` on/after `potsFrom` (Moscow) in `realm`, oldest first. */
export async function listPotSaleHomesSince(
  db: Database,
  input: { sinceDay: string; realm: "live" | "test" | "both"; day?: string; pageIds?: readonly number[] },
): Promise<PotSaleHomeRow[]> {
  const fromIso = `${input.sinceDay}T00:00:00+03:00`;
  const realmSql = input.realm === "both" ? sql`` : input.realm === "test" ? sql`and m.is_test` : sql`and not m.is_test`;
  const daySql = input.day === undefined
    ? sql``
    : sql`and h.occurred_at >= ${`${input.day}T00:00:00+03:00`}::timestamptz
          and h.occurred_at < (${`${input.day}T00:00:00+03:00`}::timestamptz + interval '1 day')`;
  const pageSql = input.pageIds === undefined
    ? sql``
    : input.pageIds.length === 0 ? sql`and false` : sql`and h.page_id = any(${ids(input.pageIds)})`;
  const result = await db.execute<Row>(sql`
    select h.transaction_id, h.page_id, p.label as page_label, p.model_id, m.slug as model_slug, m.is_test,
      t.canonical_type::text as canonical_type, h.occurred_at,
      to_char(h.occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day,
      h.net_mills, h.home, h.reason, h.pot
    from sale_homes h
    join pages p on p.id = h.page_id
    join models m on m.id = p.model_id
    left join transactions t on t.id = h.transaction_id
    where h.home = 'pot'
      and h.occurred_at >= ${fromIso}::timestamptz
      and h.net_mills > 0
      ${realmSql}
      ${daySql}
      ${pageSql}
    order by h.occurred_at asc, h.transaction_id asc`);
  return result.rows.map(potSaleHomeOf);
}

/** Loads specific `sale_homes` rows (any home!) by transaction id for posting/reconciliation validation. */
export async function listSaleHomesForPotCheck(db: Database, transactionIds: readonly number[]): Promise<Map<number, PotSaleHomeRow>> {
  const unique = [...new Set(transactionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return new Map();
  const result = await db.execute<Row>(sql`
    select h.transaction_id, h.page_id, p.label as page_label, p.model_id, m.slug as model_slug, m.is_test,
      t.canonical_type::text as canonical_type, h.occurred_at,
      to_char(h.occurred_at at time zone 'Europe/Moscow', 'YYYY-MM-DD') as day,
      h.net_mills, h.home, h.reason, h.pot
    from sale_homes h
    join pages p on p.id = h.page_id
    join models m on m.id = p.model_id
    left join transactions t on t.id = h.transaction_id
    where h.transaction_id = any(${ids(unique)})`);
  return new Map(result.rows.map((row) => {
    const item = potSaleHomeOf(row);
    return [item.transactionId, item];
  }));
}

export interface ActivePotPartForReconcile {
  distributionId: number;
  potId: number;
  potCode: string;
  potName: string;
  autoPost: boolean;
  potPageIds: number[];
  potOpensOn: string;
  potClosesOn: string | null;
  potState: PotState;
  distributionDay: string;
  isTest: boolean;
  transactionId: number;
  pageId: number;
  baseMills: number;
}

/**
 * Active (non-reversed) distribution parts whose sale occurred on Moscow `day` (or whose transaction vanished and whose
 * distribution is on `day`). Used by `reconcilePotsOfDay` to detect sales that moved out of a pot.
 */
export async function listActivePotPartsForDay(db: Database, day: string): Promise<ActivePotPartForReconcile[]> {
  const dayStart = `${day}T00:00:00+03:00`;
  const result = await db.execute<Row>(sql`
    select d.id as distribution_id, d.pot_id, to_char(d.day, 'YYYY-MM-DD') as distribution_day,
      p.code as pot_code, p.name as pot_name, p.auto_post, p.page_ids as pot_page_ids,
      to_char(p.opens_on, 'YYYY-MM-DD') as pot_opens_on,
      to_char(p.closes_on, 'YYYY-MM-DD') as pot_closes_on,
      p.state as pot_state, m.is_test,
      pp.transaction_id, pp.page_id, pp.base_mills
    from pot_distribution_parts pp
    join pot_distributions d on d.id = pp.distribution_id
    join pots p on p.id = d.pot_id
    join models m on m.id = p.model_id
    left join transactions t on t.id = pp.transaction_id
    where d.reversed_at is null
      and (
        (t.occurred_at >= ${dayStart}::timestamptz and t.occurred_at < (${dayStart}::timestamptz + interval '1 day'))
        or (t.id is null and d.day = ${day}::date)
      )
    order by d.id, pp.transaction_id`);
  return result.rows.map((row) => ({
    distributionId: num(row.distribution_id),
    potId: num(row.pot_id),
    potCode: String(row.pot_code),
    potName: String(row.pot_name),
    autoPost: Boolean(row.auto_post),
    potPageIds: numArray(row.pot_page_ids),
    potOpensOn: String(row.pot_opens_on),
    potClosesOn: text(row.pot_closes_on),
    potState: String(row.pot_state) as PotState,
    distributionDay: String(row.distribution_day),
    isTest: Boolean(row.is_test),
    transactionId: num(row.transaction_id),
    pageId: num(row.page_id),
    baseMills: num(row.base_mills),
  }));
}

/** Active (non-reversed) distribution parts for a specific transaction across all pots. */
export async function listActivePotPartsForTransactions(db: Database, transactionIds: readonly number[]): Promise<ActivePotPartForReconcile[]> {
  const unique = [...new Set(transactionIds.filter(Number.isSafeInteger))];
  if (unique.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select d.id as distribution_id, d.pot_id, to_char(d.day, 'YYYY-MM-DD') as distribution_day,
      p.code as pot_code, p.name as pot_name, p.auto_post, p.page_ids as pot_page_ids,
      to_char(p.opens_on, 'YYYY-MM-DD') as pot_opens_on,
      to_char(p.closes_on, 'YYYY-MM-DD') as pot_closes_on,
      p.state as pot_state, m.is_test,
      pp.transaction_id, pp.page_id, pp.base_mills
    from pot_distribution_parts pp
    join pot_distributions d on d.id = pp.distribution_id
    join pots p on p.id = d.pot_id
    join models m on m.id = p.model_id
    where d.reversed_at is null and pp.transaction_id = any(${ids(unique)})
    order by d.id, pp.transaction_id`);
  return result.rows.map((row) => ({
    distributionId: num(row.distribution_id),
    potId: num(row.pot_id),
    potCode: String(row.pot_code),
    potName: String(row.pot_name),
    autoPost: Boolean(row.auto_post),
    potPageIds: numArray(row.pot_page_ids),
    potOpensOn: String(row.pot_opens_on),
    potClosesOn: text(row.pot_closes_on),
    potState: String(row.pot_state) as PotState,
    distributionDay: String(row.distribution_day),
    isTest: Boolean(row.is_test),
    transactionId: num(row.transaction_id),
    pageId: num(row.page_id),
    baseMills: num(row.base_mills),
  }));
}

/** Catalog of models and active pages for a realm, used by the Workboard pots screen and Create Page Pots. */
export async function listPotCatalogModelsAndPages(
  db: Database,
  realm: "live" | "test",
): Promise<Array<{ modelId: number; modelSlug: string; modelName: string; pages: Array<{ id: number; label: string; platform: string }> }>> {
  const isTest = realm === "test";
  const result = await db.execute<Row>(sql`
    select m.id as model_id, m.slug as model_slug, m.name as model_name,
      p.id as page_id, p.label as page_label, p.platform::text as platform
    from models m
    left join pages p on p.model_id = m.id and p.status = 'active'
    where m.is_test = ${isTest}
    order by m.name asc, m.id asc, p.label asc`);
  const byModel = new Map<number, { modelId: number; modelSlug: string; modelName: string; pages: Array<{ id: number; label: string; platform: string }> }>();
  for (const row of result.rows) {
    const modelId = num(row.model_id);
    let entry = byModel.get(modelId);
    if (entry === undefined) {
      entry = { modelId, modelSlug: String(row.model_slug), modelName: String(row.model_name), pages: [] };
      byModel.set(modelId, entry);
    }
    if (row.page_id !== null && row.page_id !== undefined) {
      entry.pages.push({ id: num(row.page_id), label: String(row.page_label), platform: String(row.platform) });
    }
  }
  return [...byModel.values()];
}
