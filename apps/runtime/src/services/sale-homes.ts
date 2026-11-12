import type { AgentTeamSale, AgentTeamSalesResponse, AgentTeamWork } from "@agency_hub_core/contracts";
import {
  listActiveSaleDecisions,
  listCurrentReportsOfSales,
  listPersonLoginRows,
  listPersonScheduleSlotRows,
  listSaleClaims,
  listShiftRows,
  listUserLeaveFacts,
  listVisiblePages,
  upsertSaleHomes,
  type Database,
  type PersonLoginRow,
  type PersonScheduleSlotRow,
  type SaleHomeRow,
  type ShiftRowRecord,
  type UserLeaveFacts,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { readAgentTeamSales } from "./agent-team-sales.ts";
import { moscowDayOf } from "./chatter-shifts.ts";
import { ruleDecisionOf, ruleMarksOf, type ClaimView, type ReportView } from "./sale-claim-rules.ts";
import {
  RULE_WEEKDAYS,
  SALE_RULE,
  homesOfSales,
  type RuleMark,
  type RuleSale,
  type RuleSlot,
  type RuleWeekday,
  type RuleWork,
  type SaleHome,
  type SaleRuleConfig,
} from "./sale-rule.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

/**
 * Whose each sale is, kept current in `sale_homes` (0380). The facts are the
 * ones the agency ledger reads (`readAgentTeamSales`, the answer of
 * POST /api/v1/agent/team/sales), the rule is sale-rule.ts; so a home here and
 * the ledger's `fact_homes` differ only where the facts or the owner's newer
 * answers do (the comparison tool, sale-rule-compare.ts, says which).
 *
 * The job recomputes the sales of this Moscow week and the one before every
 * hour — a new sale, a new send attribution, a shift that closed, a PPV whose
 * sender's next shift came, a statement handed in, an answer, the owner's
 * decision (sale-claims.ts): whatever changed the facts changes the home — and
 * writes a row only when it changed. `sale-homes:refresh` recomputes any range.
 * The schedule slots of a junction and who has left the team come from the
 * people registry (0384) beside Hub's logins. In shadow: no screen reads the
 * table yet.
 */

const DAY_MS = 86_400_000;

/**
 * Where the people's schedule slots come from (sale-rule.ts `RuleSlot`): the people registry (`registrySlots`), or
 * none — then a junction nobody wrote to waits for the owner, as ledger's Go. A registry with no slot gives none.
 */
export interface SaleSlotProvider {
  slotsFor(input: { from: Date; to: Date }): Promise<readonly RuleSlot[]>;
}

export const NO_SLOTS: SaleSlotProvider = { slotsFor: async () => [] };

const WEEKDAYS: ReadonlySet<string> = new Set(RULE_WEEKDAYS);

/**
 * The registry's slots (0384 `person_schedule_slots`) as the rule reads them: a person's slot holds for every Hub login
 * of theirs (`person_logins`), so it is given once per login; a person with no login has none. Only the slots valid on
 * some day of [from − 1 day, to] (Moscow; a slot that began the day before still runs past midnight). Pure.
 */
export function ruleSlotsOf(input: {
  slots: readonly PersonScheduleSlotRow[];
  logins: ReadonlyArray<Pick<PersonLoginRow, "personId" | "userId">>;
  from: Date;
  to: Date;
}): RuleSlot[] {
  const first = moscowDayOf(input.from.getTime() - DAY_MS);
  const last = moscowDayOf(input.to.getTime());
  const loginsOf = new Map<number, number[]>();
  for (const login of input.logins) loginsOf.set(login.personId, [...(loginsOf.get(login.personId) ?? []), login.userId]);
  return input.slots
    .filter((slot) => (slot.validFrom === null || slot.validFrom <= last) && (slot.validTo === null || first <= slot.validTo))
    .flatMap((slot) => (loginsOf.get(slot.personId) ?? []).map((userId): RuleSlot => ({
      personId: userId,
      pageId: slot.pageId,
      startMinute: slot.startMinute,
      endMinute: slot.endMinute,
      weekdays: slot.weekdays === null ? null : slot.weekdays.filter((day): day is RuleWeekday => WEEKDAYS.has(day)),
      validFrom: slot.validFrom,
      validTo: slot.validTo,
    })));
}

/** The people registry's schedule slots, read through `db` in turn. */
export function registrySlots(db: Database): SaleSlotProvider {
  return {
    slotsFor: async ({ from, to }) => {
      const slots = await listPersonScheduleSlotRows(db);
      if (slots.length === 0) return [];
      return ruleSlotsOf({ slots, logins: await listPersonLoginRows(db), from, to });
    },
  };
}

/**
 * When a user left the team, null — still in it: the first of their login disabled, deleted, and their person in the
 * registry `left` — from the Moscow midnight of `left_on`, or, the day unknown, from when the registry came to say so.
 * A login with no person: its own end alone, as before the registry. Pure.
 */
export function leftAtOf(facts: Omit<UserLeaveFacts, "userId">): number | null {
  const person = facts.personLeft === null
    ? null
    : facts.personLeft.leftOn !== null ? Date.parse(`${facts.personLeft.leftOn}T00:00:00+03:00`) : facts.personLeft.recordedAt.getTime();
  const all = [facts.disabledAt?.getTime() ?? null, facts.deletedAt?.getTime() ?? null, person].filter((at): at is number => at !== null);
  return all.length === 0 ? null : Math.min(...all);
}

/** When each of the users left the team (absent — still in it). */
export async function usersLeftAt(db: Database, userIds: readonly number[]): Promise<Map<number, number>> {
  const left = new Map<number, number>();
  for (const facts of await listUserLeaveFacts(db, userIds)) {
    const at = leftAtOf(facts);
    if (at !== null) left.set(facts.userId, at);
  }
  return left;
}

/** The works of an answer as the rule reads them. Pure. */
export function ruleWorksOf(works: readonly AgentTeamWork[]): RuleWork[] {
  return works.map((work) => ({ ref: work.ref, userId: work.userId, kind: work.kind, startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) }));
}

/**
 * What people said of a sale and what the owner decided, as the rule's inputs (package G): the statements of handed-in
 * reports and the claims' answers (`marks`), the owner's decision (`resolution`, `claimedBy`, «никому», a pot).
 */
export interface SaleRuleInput {
  marks: RuleMark[];
  resolution: Array<{ userId: number; percent: number }> | null;
  claimedBy: number | null;
  ownerNobody: boolean;
  ownerPot: string | null;
}

/**
 * The rule's inputs of the sales named, by sale ref: the newest versions of the reports holding them, their claims and
 * the owner's active decisions. A sale nobody said anything of and the owner never decided has none. In turn.
 */
export async function saleRuleInputs(db: Database, transactionIds: readonly number[]): Promise<Map<string, SaleRuleInput>> {
  if (transactionIds.length === 0) return new Map();
  const reports = await listCurrentReportsOfSales(db, transactionIds);
  const claims = await listSaleClaims(db, { transactionIds });
  const decisions = await listActiveSaleDecisions(db, transactionIds);
  const views: ReportView[] = reports.map((report) => ({
    handinId: report.handinId, shiftId: report.shiftId, userId: report.userId, version: report.version, submittedAt: report.submittedAt.getTime(), lines: report.lines,
  }));
  const marks = ruleMarksOf({ reports: views, claims: claims as readonly ClaimView[] });
  const out = new Map<string, SaleRuleInput>();
  const wanted = new Set(transactionIds);
  for (const [sale, list] of marks) {
    if (!wanted.has(sale)) continue;
    out.set(String(sale), { marks: list, resolution: null, claimedBy: null, ownerNobody: false, ownerPot: null });
  }
  for (const [sale, decision] of decisions) {
    const input = out.get(String(sale)) ?? { marks: [], resolution: null, claimedBy: null, ownerNobody: false, ownerPot: null };
    out.set(String(sale), { ...input, ...ruleDecisionOf(decision) });
  }
  return out;
}

/**
 * The sales of an answer as the rule reads them. `pageIds` — the pages' ids by label; `leftAt` — when each person left
 * the team; `claimedBy` — the owner's claims by sale; `inputs` — what people said and the owner decided (package G),
 * which replace the answer's marks and split (the old shift-report tables, empty) when given. Pure.
 */
export function ruleSalesOf(
  sales: readonly AgentTeamSale[],
  options: {
    pageIds: ReadonlyMap<string, number>;
    leftAt: ReadonlyMap<number, number>;
    claimedBy?: ReadonlyMap<string, number>;
    inputs?: ReadonlyMap<string, SaleRuleInput>;
  },
): RuleSale[] {
  return sales.map((sale) => {
    const base = ruleSaleOf(sale, options);
    if (options.inputs === undefined) return base;
    const input = options.inputs.get(sale.transactionRef);
    if (input === undefined) return { ...base, marks: [], resolution: null };
    return {
      ...base,
      marks: input.marks,
      resolution: input.resolution,
      claimedBy: input.claimedBy ?? base.claimedBy,
      ownerNobody: input.ownerNobody,
      ownerPot: input.ownerPot,
    };
  });
}

function ruleSaleOf(
  sale: AgentTeamSale,
  options: { pageIds: ReadonlyMap<string, number>; leftAt: ReadonlyMap<number, number>; claimedBy?: ReadonlyMap<string, number> },
): RuleSale {
  return ({
    ref: sale.transactionRef,
    pageId: options.pageIds.get(sale.pageLabel) ?? null,
    kind: sale.kind,
    netMills: sale.netMills,
    occurredAt: Date.parse(sale.occurredAt),
    holders: sale.holders,
    ppvSender: sale.ppvSender === null
      ? null
      : { userId: sale.ppvSender.userId, role: sale.ppvSender.role, leftAt: options.leftAt.get(sale.ppvSender.userId) ?? null },
    postTip: sale.postTip,
    campaign: sale.campaign,
    lastWriter: sale.lastWriterUserId,
    marks: sale.marks.map((mark) => ({
      userId: mark.userId, mark: mark.mark, shareWith: mark.shareWithUserId, ownAmountMills: mark.amountMills, confirmed: mark.confirmed,
    })),
    resolution: sale.resolution,
    claimedBy: options.claimedBy?.get(sale.transactionRef) ?? null,
  });
}

/** The moment the answer's works are known up to: a PPV whose wait runs past it still waits (as the ledger reads it). Pure. */
export const ruleNowOf = (answer: Pick<AgentTeamSalesResponse, "workTo">) => Date.parse(answer.workTo);

/** The row of a sale's home; `shiftRows` — the rows of the shifts around, to name a share's shift by its id. Pure. */
export function saleHomeRowOf(input: {
  sale: AgentTeamSale;
  home: SaleHome;
  pageId: number;
  works: ReadonlyMap<string, RuleWork>;
  shiftRows: readonly ShiftRowRecord[];
  rule: SaleRuleConfig;
}): SaleHomeRow {
  const { sale, home } = input;
  const shiftIdOf = (ref: string | null): number | null => {
    const work = ref === null ? undefined : input.works.get(ref);
    if (work === undefined || work.kind !== "shift") return null;
    const row = input.shiftRows.find((one) => one.userId === work.userId && (one.state === "going" || one.state === "closed")
      && one.startedAt.getTime() <= work.startedAt && work.startedAt <= one.endedAt.getTime());
    return row?.id ?? null;
  };
  return {
    transactionId: Number(sale.transactionRef),
    pageId: input.pageId,
    occurredAt: new Date(sale.occurredAt),
    netMills: sale.netMills,
    home: home.kind,
    reason: home.reason,
    pot: home.pot,
    waitsUntil: home.waitsUntil === null ? null : new Date(home.waitsUntil),
    shares: home.shares.map((share) => ({ userId: share.userId, workRef: share.workRef, shiftId: shiftIdOf(share.workRef), percent: share.percent, mills: share.mills })),
    ruleVersion: input.rule.version,
  };
}

/** Every person the answer names as a PPV's sender: whose leaving the rule needs to know. Pure. */
export const sendersOf = (answer: Pick<AgentTeamSalesResponse, "sales">) =>
  [...new Set(answer.sales.flatMap((sale) => (sale.ppvSender === null ? [] : [sale.ppvSender.userId])))];

/**
 * The homes of every sale on every page in [from, to): the ledger's facts for that window, the rule on them.
 * `db` — a transaction or the pool; read in turn.
 */
export async function computeSaleHomes(
  db: Database,
  input: { from: Date; to: Date; now: Date; rule?: SaleRuleConfig; slots?: SaleSlotProvider },
): Promise<{ answer: AgentTeamSalesResponse; homes: SaleHome[]; pageIds: Map<string, number> }> {
  const rule = input.rule ?? SALE_RULE;
  const pages = await listVisiblePages(db);
  const pageIds = new Map(pages.map((page) => [page.label, page.id]));
  const answer = await readAgentTeamSales(db, { from: input.from, to: input.to, now: input.now, pages: pages.map((page) => ({ id: page.id, label: page.label })) });
  const leftAt = await usersLeftAt(db, sendersOf(answer));
  const slots = await (input.slots ?? NO_SLOTS).slotsFor({ from: new Date(answer.workFrom), to: new Date(answer.workTo) });
  // What people said in their handed-in reports and what the owner decided, instead of the old shift-report tables.
  const inputs = await saleRuleInputs(db, answer.sales.map((sale) => Number(sale.transactionRef)).filter(Number.isSafeInteger));
  const homes = homesOfSales(ruleSalesOf(answer.sales, { pageIds, leftAt, inputs }), ruleWorksOf(answer.works), slots, ruleNowOf(answer), rule);
  return { answer, homes, pageIds };
}

/** Recomputes the homes of the sales in [from, to) by the registry's slots and writes the ones that changed. */
export async function refreshSaleHomes(db: Database, input: { from: Date; to: Date; now: Date }): Promise<{ sales: number; written: number }> {
  const { answer, homes, pageIds } = await computeSaleHomes(db, { ...input, slots: registrySlots(db) });
  const works = new Map(ruleWorksOf(answer.works).map((work) => [work.ref, work]));
  const shiftRows = await listShiftRows(db, { from: new Date(Date.parse(answer.workFrom) - DAY_MS), to: new Date(Date.parse(answer.workTo) + DAY_MS) });
  const rows = answer.sales.flatMap((sale, at) => {
    const pageId = pageIds.get(sale.pageLabel);
    return pageId === undefined ? [] : [saleHomeRowOf({ sale, home: homes[at]!, pageId, works, shiftRows, rule: SALE_RULE })];
  });
  const written = await upsertSaleHomes(db, rows, input.now);
  return { sales: rows.length, written };
}

/** Monday 00:00 Moscow of the week holding `at`. Pure. */
export function moscowWeekStart(at: number): number {
  const day = moscowDayOf(at);
  const midnight = Date.parse(`${day}T00:00:00+03:00`);
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
  return midnight - weekday * DAY_MS;
}

export const SALE_HOMES_QUEUE = "team.sale-homes";

/** One run of the job: this Moscow week's sales and the week before's (a PPV waits up to 7 days). */
export async function runSaleHomesTick(app: Pick<AppContext, "db" | "logger">): Promise<{ sales: number; written: number }> {
  const now = new Date();
  const from = new Date(Math.max(SALE_RULE.since, moscowWeekStart(now.getTime()) - 7 * DAY_MS));
  const result = await refreshSaleHomes(app.db, { from, to: now, now });
  if (result.written > 0) app.logger.info(result, "sale homes refreshed");
  return result;
}

export async function ensureSaleHomesQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, SALE_HOMES_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureSaleHomesSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  // Hourly, off the ledger's read of the same facts.
  await boss.schedule(SALE_HOMES_QUEUE, "25 * * * *", null, { tz: "UTC" });
}
