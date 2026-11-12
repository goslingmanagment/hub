import type { AgentTeamSale, AgentTeamSalesResponse, AgentTeamWork } from "@agency_hub_core/contracts";
import {
  listShiftRows,
  listUsersLeftAt,
  listVisiblePages,
  upsertSaleHomes,
  type Database,
  type SaleHomeRow,
  type ShiftRowRecord,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { readAgentTeamSales } from "./agent-team-sales.ts";
import { moscowDayOf } from "./chatter-shifts.ts";
import { SALE_RULE, homesOfSales, type RuleSale, type RuleSlot, type RuleWork, type SaleHome, type SaleRuleConfig } from "./sale-rule.ts";
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
 * sender's next shift came: whatever changed the facts changes the home — and
 * writes a row only when it changed. `sale-homes:refresh` recomputes any range.
 * In shadow: no screen reads the table yet.
 */

const DAY_MS = 86_400_000;

/**
 * Where the people's schedule slots come from (sale-rule.ts `RuleSlot`). Hub keeps no schedule yet: the one provider
 * gives none, so a junction nobody wrote to waits for the owner, as ledger's Go. The people registry feeds it next.
 */
export interface SaleSlotProvider {
  slotsFor(input: { from: Date; to: Date }): Promise<readonly RuleSlot[]>;
}

export const NO_SLOTS: SaleSlotProvider = { slotsFor: async () => [] };

/** The works of an answer as the rule reads them. Pure. */
export function ruleWorksOf(works: readonly AgentTeamWork[]): RuleWork[] {
  return works.map((work) => ({ ref: work.ref, userId: work.userId, kind: work.kind, startedAt: Date.parse(work.startedAt), endedAt: Date.parse(work.endedAt) }));
}

/**
 * The sales of an answer as the rule reads them. `pageIds` — the pages' ids by label; `leftAt` — when each person left
 * the team; `claimedBy` — the owner's claims by sale (Hub keeps none yet). Pure.
 */
export function ruleSalesOf(
  sales: readonly AgentTeamSale[],
  options: { pageIds: ReadonlyMap<string, number>; leftAt: ReadonlyMap<number, number>; claimedBy?: ReadonlyMap<string, number> },
): RuleSale[] {
  return sales.map((sale) => ({
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
  }));
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
  const left = await listUsersLeftAt(db, sendersOf(answer));
  const leftAt = new Map([...left].map(([userId, at]) => [userId, at.getTime()]));
  const slots = await (input.slots ?? NO_SLOTS).slotsFor({ from: new Date(answer.workFrom), to: new Date(answer.workTo) });
  const homes = homesOfSales(ruleSalesOf(answer.sales, { pageIds, leftAt }), ruleWorksOf(answer.works), slots, ruleNowOf(answer), rule);
  return { answer, homes, pageIds };
}

/** Recomputes the homes of the sales in [from, to) and writes the ones that changed. */
export async function refreshSaleHomes(db: Database, input: { from: Date; to: Date; now: Date }): Promise<{ sales: number; written: number }> {
  const { answer, homes, pageIds } = await computeSaleHomes(db, input);
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
