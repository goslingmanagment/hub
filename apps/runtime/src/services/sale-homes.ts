import type { AgentTeamSale, AgentTeamSalesResponse, AgentTeamWork } from "@agency_hub_core/contracts";
import {
  acquireErasureFenceSharedLock,
  completeSaleHomeRefreshDue,
  deleteVanishedSaleHomesInWindow,
  listActiveSaleDecisions,
  listCurrentHandinVersions,
  listCurrentReportsOfSales,
  listHandinsOfShifts,
  listLoginPeople,
  listSaleClaims,
  listSaleHomeRefreshDue,
  listShiftRows,
  listTestPageIds,
  listUserLeaveFacts,
  listVisiblePages,
  lockSaleHomeRefreshDay,
  readSaleHomeRefreshGeneration,
  upsertSaleHomes,
  versionReportDate,
  type Database,
  type SaleHomeRow,
  type SaleHomeShareDaySource,
  type SaleHomeShareRow,
  type ShiftRowRecord,
  type UserLeaveFacts,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { readAgentTeamSales } from "./agent-team-sales.ts";
import { dayOfWork, moscowDayOf } from "./chatter-shifts.ts";
import { ruleDecisionOf, ruleMarksOf, type ClaimView, type ReportView } from "./sale-claim-rules.ts";
import {
  LOGINS_ALONE,
  landShare,
  peopleLoginsOf,
  piecesByUser,
  type CreditPiece,
  type PeopleLogins,
} from "./sale-rule-screens.ts";
import {
  SALE_RULE,
  homesOfSales,
  type RuleMark,
  type RuleSale,
  type RuleWork,
  type SaleHome,
  type SaleRuleConfig,
} from "./sale-rule.ts";
import { NO_SLOTS, registrySlots, type SaleSlotProvider } from "./schedule-slots.ts";
import { reportDateOfSale, reportDateOfShift } from "./shift-rows.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";
import { soloPageSuggestions } from "./page-workers.ts";
import { reconcilePotsOfDay } from "./pots.ts";

/**
 * Whose each sale is, kept current in `sale_homes` (0380) and served to downstream consumers on
 * `GET /api/v1/agent/sale-homes/feed` (0441). The facts are read by `readAgentTeamSales`, the rule is `sale-rule.ts`,
 * and where each share lands is `landShare` (`sale-rule-screens.ts`) — the same pure landing function screens use.
 *
 * One per-day advisory-locked refresh handler (`refreshSaleHomesForDay`) drives every refresh path:
 *  - `SALE_HOMES_DUE_QUEUE` (every 5 minutes): drains `sale_home_refresh_due` populated in-transaction by input writers;
 *  - `SALE_HOMES_QUEUE` (hourly): refreshes this Moscow week and the previous week plus any queued days;
 *  - `SALE_HOMES_SWEEP_QUEUE` (nightly): refreshes every Moscow day from `SALE_RULE.since` through today;
 *  - `sale-homes:refresh` CLI and immediate post-decision refreshes (`refreshSaleHomes`).
 */

const DAY_MS = 86_400_000;

// The registry's slots as the rule reads them: schedule-slots.ts's (a leaf, the cut of a shift reads them too), under
// the names their importers know.
export { NO_SLOTS, registrySlots, ruleSlotsOf, type SaleSlotProvider } from "./schedule-slots.ts";

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

/** The works of an answer as `CreditPiece` grouped by login, for `landShare`. Pure. */
export function workPiecesOf(works: readonly AgentTeamWork[]): Map<number, CreditPiece[]> {
  return piecesByUser(works.map((work): CreditPiece => ({
    userId: work.userId,
    work: {
      kind: work.kind,
      startedAt: Date.parse(work.startedAt),
      endedAt: Date.parse(work.endedAt),
      salesSince: new Map(
        work.pages.flatMap((page) => (page.salesFrom === null ? [] : [[page.pageLabel, Date.parse(page.salesFrom)] as const])),
      ),
    },
  })));
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

function findShiftRowForPiece(shiftRows: readonly ShiftRowRecord[], piece: CreditPiece): ShiftRowRecord | undefined {
  return shiftRows.find((one) => one.userId === piece.userId && (one.state === "going" || one.state === "closed")
    && one.startedAt.getTime() <= piece.work.startedAt && piece.work.startedAt <= one.endedAt.getTime());
}

/**
 * The row of a sale's home, enriching every share with `personCode`, `reportDate`, and `daySource` via the exact same
 * `landShare` function screens use (`homeCredit`). Pure.
 */
export function saleHomeRowOf(input: {
  sale: Pick<AgentTeamSale, "transactionRef" | "pageLabel" | "occurredAt" | "netMills">;
  home: SaleHome;
  pageId: number;
  pieces: ReadonlyMap<number, readonly CreditPiece[]>;
  logins?: PeopleLogins;
  shiftRows: readonly ShiftRowRecord[];
  /** Submitted shift hand-ins' current `versionReportDate`, keyed by `shiftId`. */
  handedInDates?: ReadonlyMap<number, string>;
  rule: SaleRuleConfig;
}): SaleHomeRow {
  const { sale, home } = input;
  const logins = input.logins ?? LOGINS_ALONE;
  const occurredAt = new Date(sale.occurredAt);
  const handedInDates = input.handedInDates ?? new Map<number, string>();

  const shares: SaleHomeShareRow[] = home.shares.map((share) => {
    const personCode = logins.codeOf(share.userId);
    const landed = landShare(share, { pageLabel: sale.pageLabel, occurredAt }, input.pieces, logins);
    let shiftId: number | null = null;
    let reportDate: string | null = null;
    let daySource: SaleHomeShareDaySource;

    switch (landed.kind) {
      case "shift": {
        const row = findShiftRowForPiece(input.shiftRows, landed.piece);
        shiftId = row?.id ?? null;
        const handedIn = row === undefined ? undefined : handedInDates.get(row.id);
        if (handedIn !== undefined) {
          reportDate = handedIn;
          daySource = "report";
        } else {
          reportDate = row?.reportDate ?? reportDateOfShift(landed.piece.work);
          daySource = "shift";
        }
        break;
      }
      case "visit": {
        reportDate = dayOfWork(landed.piece.work);
        daySource = "visit";
        break;
      }
      case "holding_shift": {
        const row = findShiftRowForPiece(input.shiftRows, landed.piece);
        shiftId = row?.id ?? null;
        const handedIn = row === undefined ? undefined : handedInDates.get(row.id);
        reportDate = handedIn ?? row?.reportDate ?? reportDateOfShift(landed.piece.work);
        daySource = "holding_shift";
        break;
      }
      case "sale_day": {
        reportDate = reportDateOfSale(occurredAt.getTime());
        daySource = "sale_day";
        break;
      }
      case "unresolved": {
        reportDate = null;
        daySource = "unresolved";
        break;
      }
    }

    return {
      personCode,
      userId: share.userId,
      shiftId,
      workRef: share.workRef,
      reportDate,
      daySource,
      percent: share.percent,
      mills: share.mills,
    };
  });

  return {
    transactionId: Number(sale.transactionRef),
    pageId: input.pageId,
    occurredAt,
    netMills: sale.netMills,
    home: home.kind,
    reason: home.reason,
    pot: home.pot,
    waitsUntil: home.waitsUntil === null ? null : new Date(home.waitsUntil),
    shares,
    ruleVersion: input.rule.version,
  };
}

/** Every person the answer names as a PPV's sender: whose leaving the rule needs to know. Pure. */
export const sendersOf = (answer: Pick<AgentTeamSalesResponse, "sales">) =>
  [...new Set(answer.sales.flatMap((sale) => (sale.ppvSender === null ? [] : [sale.ppvSender.userId])))];

/** Reads `versionReportDate` for every submitted hand-in of living shift rows, in turn (safe inside a tx). */
export async function readHandedInReportDates(db: Database, shiftRows: readonly ShiftRowRecord[]): Promise<Map<number, string>> {
  const shiftIds = shiftRows.filter((row) => row.state === "going" || row.state === "closed").map((row) => row.id);
  if (shiftIds.length === 0) return new Map();
  const handins = await listHandinsOfShifts(db, shiftIds);
  const submitted = [...handins.values()].filter((handin) => handin.state === "submitted");
  if (submitted.length === 0) return new Map();
  const versions = await listCurrentHandinVersions(db, submitted.map((handin) => handin.id));
  const out = new Map<number, string>();
  for (const handin of submitted) {
    const version = versions.get(handin.id);
    out.set(handin.shiftId, version === undefined ? handin.reportDate : versionReportDate(version, handin));
  }
  return out;
}

/**
 * The homes of every sale on every page in [from, to): the facts for that window, the rule on them (with person-login
 * mapping across both realms so multi-login shares resolve by person). `db` — a transaction or the pool; read in turn.
 */
export async function computeSaleHomes(
  db: Database,
  input: { from: Date; to: Date; now: Date; rule?: SaleRuleConfig; slots?: SaleSlotProvider },
): Promise<{ answer: AgentTeamSalesResponse; homes: SaleHome[]; pageIds: Map<string, number>; logins: PeopleLogins }> {
  const rule = input.rule ?? SALE_RULE;
  // Every page of both realms (sandbox/realm.ts): a test sale has its home like any other; the realms never meet in
  // one sale (a person works pages of one realm).
  const pages = [...await listVisiblePages(db), ...await listVisiblePages(db, await listTestPageIds(db))];
  const pageIds = new Map(pages.map((page) => [page.label, page.id]));
  const logins = peopleLoginsOf(await listLoginPeople(db, "both"));
  const answer = await readAgentTeamSales(db, { from: input.from, to: input.to, now: input.now, pages: pages.map((page) => ({ id: page.id, label: page.label })), realm: "both" });
  const leftAt = await usersLeftAt(db, sendersOf(answer));
  const slots = await (input.slots ?? NO_SLOTS).slotsFor({ from: new Date(answer.workFrom), to: new Date(answer.workTo) });
  // What people said in their handed-in reports and what the owner decided, instead of the old shift-report tables.
  const inputs = await saleRuleInputs(db, answer.sales.map((sale) => Number(sale.transactionRef)).filter(Number.isSafeInteger));
  const homes = homesOfSales(ruleSalesOf(answer.sales, { pageIds, leftAt, inputs }), ruleWorksOf(answer.works), slots, ruleNowOf(answer), rule, logins);
  return { answer, homes, pageIds, logins };
}

/** Every Moscow day (YYYY-MM-DD) overlapping [from, to) on or after `SALE_RULE.since`, oldest first. Pure. */
export function moscowDaysInRange(from: Date, to: Date): string[] {
  const startMs = Math.max(from.getTime(), SALE_RULE.since);
  const endMs = to.getTime();
  if (!(startMs < endMs)) return [];
  const firstDay = moscowDayOf(startMs);
  const lastDay = moscowDayOf(endMs - 1);
  const days: string[] = [];
  let cursor = Date.parse(`${firstDay}T00:00:00+03:00`);
  const end = Date.parse(`${lastDay}T00:00:00+03:00`);
  while (cursor <= end) {
    days.push(moscowDayOf(cursor));
    cursor += DAY_MS;
  }
  return days;
}

/**
 * The ONE refresh handler for a single Moscow day: acquires the per-day advisory lock BEFORE reading any inputs, reads
 * the day's queued `generation` (if any), recomputes all homes in the day's window, upserts changed rows, retracts
 * vanished sales in that window, and deletes `sale_home_refresh_due` strictly `WHERE day = $1 AND generation = $2`.
 * Used by the 5-min due pass, hourly job, nightly sweep, manual CLI refresh, and post-decision refreshes.
 */
export async function refreshSaleHomesForDay(
  db: Database,
  day: string,
  now?: Date | (() => Date),
  options?: { /** Test seam: runs after reading inputs & generation, before writing/completing. */ afterRead?: () => Promise<void>; deferPots?: boolean },
): Promise<{ sales: number; written: number; retracted: number }> {
  if (day < moscowDayOf(SALE_RULE.since)) return { sales: 0, written: 0, retracted: 0 };
  const dayStart = new Date(`${day}T00:00:00+03:00`);

  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await lockSaleHomeRefreshDay(tx, day);
    // Read the effective clock AFTER acquiring the day lock so a slow sweep never overwrites a fresher pass across a
    // PPV deadline or clears a current-day generation with a stale cutoff.
    const effectiveNow = typeof now === "function" ? now() : now ?? new Date();
    const dayEnd = new Date(Math.min(effectiveNow.getTime(), dayStart.getTime() + DAY_MS));
    if (!(dayStart.getTime() < dayEnd.getTime())) return { sales: 0, written: 0, retracted: 0 };
    const generation = await readSaleHomeRefreshGeneration(tx, day);
    // Take the shared erasure fence in sorted page-id order BEFORE reading sales so an in-flight page erasure commits
    // first (and any later erasure waits for this write before deleting), preventing resurrection of erased homes.
    const testPages = new Set(await listTestPageIds(tx));
    const activePages = [...await listVisiblePages(tx), ...await listVisiblePages(tx, [...testPages])];
    const sortedPageIds = [...new Set(activePages.map((page) => page.id))].sort((a, b) => a - b);
    for (const pageId of sortedPageIds) {
      await acquireErasureFenceSharedLock(tx, pageId);
    }
    const { answer, homes, pageIds, logins } = await computeSaleHomes(tx, { from: dayStart, to: dayEnd, now: effectiveNow, slots: registrySlots(tx) });
    const pieces = workPiecesOf(answer.works);
    const shiftRows = await listShiftRows(tx, { from: new Date(Date.parse(answer.workFrom) - DAY_MS), to: new Date(Date.parse(answer.workTo) + DAY_MS) });
    const handedInDates = await readHandedInReportDates(tx, shiftRows);
    if (options?.afterRead) await options.afterRead();
    const rows = answer.sales.flatMap((sale, at) => {
      const pageId = pageIds.get(sale.pageLabel);
      return pageId === undefined ? [] : [saleHomeRowOf({ sale, home: homes[at]!, pageId, pieces, logins, shiftRows, handedInDates, rule: SALE_RULE })];
    });
    for (const realm of ["live", "test"] as const) {
      const scoped = rows.filter((row) => testPages.has(row.pageId) === (realm === "test"));
      const suggestions = await soloPageSuggestions(tx, realm, scoped.map((row) => ({ ...row, day })));
      for (const row of scoped) row.suggestedPersonId = suggestions.get(row.transactionId)?.personId ?? null;
    }
    const written = await upsertSaleHomes(tx, rows, effectiveNow);
    const retracted = await deleteVanishedSaleHomesInWindow(tx, {
      from: dayStart,
      to: dayEnd,
      pageIds: [...pageIds.values()],
      keepTransactionIds: rows.map((row) => row.transactionId),
    });
    if (options?.deferPots) return { sales: rows.length, written, retracted };
    await reconcilePotsOfDay(tx, day, effectiveNow);
    if (generation !== null) {
      await completeSaleHomeRefreshDue(tx, { day, generation });
    }
    return { sales: rows.length, written, retracted };
  });
}

/** Recomputes the homes of every Moscow day in [from, to) through the single per-day refresh handler. */
export async function refreshSaleHomes(db: Database, input: { from: Date; to: Date; now?: Date; onDayError?: (day: string, err: unknown) => void }): Promise<{ sales: number; written: number; retracted: number }> {
  let sales = 0;
  let written = 0;
  let retracted = 0;
  const failures: unknown[] = [];
  for (const day of moscowDaysInRange(input.from, input.to)) {
    try {
      const one = await refreshSaleHomesForDay(db, day, input.now);
      sales += one.sales;
      written += one.written;
      retracted += one.retracted;
    } catch (error) {
      if (input.onDayError) input.onDayError(day, error);
      else failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Sale home refresh failed for one or more days");
  return { sales, written, retracted };
}

/** Monday 00:00 Moscow of the week holding `at`. Pure. */
export function moscowWeekStart(at: number): number {
  const day = moscowDayOf(at);
  const midnight = Date.parse(`${day}T00:00:00+03:00`);
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday 0
  return midnight - weekday * DAY_MS;
}

export const SALE_HOMES_QUEUE = "team.sale-homes";
export const SALE_HOMES_DUE_QUEUE = "team.sale-homes.due";
export const SALE_HOMES_SWEEP_QUEUE = "team.sale-homes.sweep";

/** 5-minute due pass: drains `sale_home_refresh_due` through the single per-day refresh handler. */
export async function runSaleHomesDueTick(app: Pick<AppContext, "db" | "logger">, now?: Date): Promise<{ days: number; sales: number; written: number; retracted: number }> {
  const due = await listSaleHomeRefreshDue(app.db);
  let sales = 0;
  let written = 0;
  let retracted = 0;
  for (const entry of due) {
    try {
      const one = await refreshSaleHomesForDay(app.db, entry.day, now);
      sales += one.sales;
      written += one.written;
      retracted += one.retracted;
    } catch (err) {
      app.logger.warn({ day: entry.day, err }, "Sale home refresh failed; the day remains queued");
    }
  }
  if (written + retracted > 0) app.logger.info({ days: due.length, sales, written, retracted }, "sale homes due pass refreshed");
  return { days: due.length, sales, written, retracted };
}

/** Hourly job: this Moscow week and the previous week (a PPV waits up to 7 days), plus any queued due days. */
export async function runSaleHomesTick(app: Pick<AppContext, "db" | "logger">, now?: Date): Promise<{ sales: number; written: number; retracted: number }> {
  const windowNow = now ?? new Date();
  const from = new Date(Math.max(SALE_RULE.since, moscowWeekStart(windowNow.getTime()) - 7 * DAY_MS));
  const result = await refreshSaleHomes(app.db, { from, to: windowNow, onDayError: (day, err) => app.logger.warn({ day, err }, "Sale home refresh failed"), ...(now === undefined ? {} : { now }) });
  const due = await runSaleHomesDueTick(app, now);
  const total = { sales: result.sales + due.sales, written: result.written + due.written, retracted: result.retracted + due.retracted };
  if (total.written + total.retracted > 0) app.logger.info(total, "sale homes refreshed");
  return total;
}

/** Nightly sweep: recomputes every Moscow day from `SALE_RULE.since` through today and retracts vanished sales. */
export async function runSaleHomesSweepTick(app: Pick<AppContext, "db" | "logger">, now?: Date): Promise<{ sales: number; written: number; retracted: number }> {
  const windowNow = now ?? new Date();
  const result = await refreshSaleHomes(app.db, { from: new Date(SALE_RULE.since), to: windowNow, onDayError: (day, err) => app.logger.warn({ day, err }, "Sale home refresh failed"), ...(now === undefined ? {} : { now }) });
  if (result.written + result.retracted > 0) app.logger.info(result, "sale homes nightly sweep complete");
  return result;
}

export async function ensureSaleHomesQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, SALE_HOMES_QUEUE, { policy: "exclusive" }, createdQueues);
  await ensureQueueCreated(boss, SALE_HOMES_DUE_QUEUE, { policy: "exclusive" }, createdQueues);
  await ensureQueueCreated(boss, SALE_HOMES_SWEEP_QUEUE, { policy: "exclusive" }, createdQueues);
}

export async function ensureSaleHomesSchedule(boss: QueueCreationClient) {
  if (!boss.schedule) return;
  await boss.schedule(SALE_HOMES_QUEUE, "25 * * * *", null, { tz: "UTC" });
  await boss.schedule(SALE_HOMES_DUE_QUEUE, "*/5 * * * *", null, { tz: "UTC" });
  await boss.schedule(SALE_HOMES_SWEEP_QUEUE, "15 1 * * *", null, { tz: "UTC" });
}
