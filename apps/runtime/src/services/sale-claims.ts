import type {
  AgentSaleClaimsResponse,
  OffPlatformPendingResponse,
  SaleClaim,
  SaleDecisionsUnlinkedResponse,
  SaleDisputeResponse,
  SaleNobodyResponse,
  ShiftReportClaim,
  ShiftReportLineFacts,
} from "@agency_hub_core/contracts";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import {
  cancelSaleDecision,
  closeMatter,
  decideOffPlatform,
  findHandinByShift,
  findHandinPersonBy,
  findHandinPersonOfUser,
  findLatestHandinShift,
  findOffPlatformWithReport,
  findSaleClaim,
  insertHandinEvent,
  insertHandinVersion,
  insertSaleClaim,
  insertSaleDecision,
  linkSaleDecision,
  listActiveSaleDecisions,
  listCurrentHandinVersions,
  listCurrentReportsOfSales,
  listCurrentReportsSince,
  listDaysHandedIn,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSalesByIds,
  listMatterPageLabels,
  listOpenMattersOfKinds,
  listPendingOffPlatform,
  listSaleCandidates,
  listSaleClaims,
  listSaleDecisions,
  listUnownedSales,
  listVisiblePages,
  lockSaleSettlements,
  openMatter,
  supersedeSaleDecision,
  updateSaleClaim,
  type CurrentReport,
  type Database,
  type HandinDoor,
  type HandinPerson,
  type HandinSaleRow,
  type HandinVersionLine,
  type HandinVersionMadeFor,
  type MatterActor,
  type SaleClaimRow,
  type SaleDecisionInsert,
  type SaleDecisionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { moscowWeekStart, refreshSaleHomes } from "./sale-homes.ts";
import {
  claimStands,
  claimTitle,
  decisionOfOutcome,
  deriveClaims,
  disputeTitle,
  nobodyWeekTitle,
  offPlatformTitle,
  reportSums,
  settledShareOf,
  settledVersion,
  shareAfter,
  type DerivedClaim,
  type OwnerOutcome,
  type ReportView,
} from "./sale-claim-rules.ts";
import { SALE_RULE, SALE_HOME_REASON_TEXT, type SaleHomeReason } from "./sale-rule.ts";
import { dayWords } from "./shift-handin-rules.ts";
import { SHIFT_REPORT_AFTER_PAID_KIND, draftLineOfSale, ledgerDayPaid, saleLineFacts, type HandinActor } from "./shift-handins.ts";

/**
 * Заявки и договорённости (ecosystem plan 2026-11-12, package G): what people
 * say about a sale reaches the other side and, when they do not agree, the
 * owner. One service for every door.
 *
 * The pass (`runSaleClaims`, after each shift-rows pass and after a hand-in):
 *  - reads the newest version of every report handed in in the last 14 days
 *    and the claims they make (sale-claim-rules.ts `deriveClaims`): a new one is
 *    asked of the other side — a matter «Катя считает своей: PPV, фан, $36.00,
 *    11 нояб.» that opens their shift report at that line — or, nobody to ask
 *    (or the other side not handing shifts in in Hub), goes to the owner at
 *    once; a sale counted for more than its net is the owner's at once;
 *  - a claim whose report no longer counts the sale is withdrawn; one asked 24
 *    hours ago and not answered goes to the owner;
 *  - the owner's matters: ONE per disputed sale, one per report with «мимо
 *    площадки» waiting, one line a week of the sales nobody claimed on the
 *    days all of whose shifts are handed in, one of the decisions carried over
 *    from the ledger that wait to be tied to a sale.
 * An answer «Согласен» settles a claim; «Не согласен» takes it to the owner;
 * the owner's answer — first, second, halves, nobody — is a decision the rule
 * takes before itself (sale-rule.ts). Every handed-in report that counts the
 * sale then gets a new version made by the system with what the settlement
 * gives (the ledger's feed serves it; the ledger supersedes), and the sale's
 * home is computed again. The people's words never move a home by themselves:
 * agreeing statements do, and the owner's decision does. Database only, and
 * the ledger's payouts read for a new version's day.
 */

type ClaimsApp = Pick<AppContext, "db" | "config" | "logger">;

export const SALE_CLAIM_KIND = "sale.claim";
export const SALE_DISPUTE_KIND = "sale.dispute";
export const SALE_NOBODY_WEEK_KIND = "sale.nobody_week";
export const OFF_PLATFORM_PENDING_KIND = "off_platform.pending";
export const SALE_DECISIONS_UNLINKED_KIND = "sale.decisions.unlinked";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** How far back the pass reads reports: older claims keep their state. */
const LOOKBACK_DAYS = 14;
/** How long the other side has to answer before the owner hears of it. */
export const CLAIM_SILENCE_MS = 24 * HOUR_MS;
const SYSTEM: MatterActor = { door: "system" };
const OPEN_STATES = ["asked", "agreed", "owner"] as const;

const moscowDay = (at: number) => new Date(at + 3 * HOUR_MS).toISOString().slice(0, 10);

/** A long text cut for a title: at the last word that fits, with «…», never mid-word. */
export function cutAtWord(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.—–-]+$/u, "")}…`;
}
const money = (mills: number) => formatUsdFromMills(mills);

function viewOf(report: CurrentReport): ReportView {
  return {
    handinId: report.handinId, shiftId: report.shiftId, userId: report.userId, version: report.version,
    submittedAt: report.submittedAt.getTime(), lines: report.lines,
  };
}

const claimKey = (handinId: number | null, transactionId: number | null, sideUserId: number | null) => `${handinId ?? 0}:${transactionId ?? 0}:${sideUserId ?? 0}`;

// ── The pass ─────────────────────────────────────────────────────────────────

export interface SaleClaimsTally {
  claims: number;
  opened: number;
  withdrawn: number;
  escalated: number;
  matters: number;
}

/** The side's shift a claim's answer is given on: the side's report holding it, else their shift holding it by the rule, else their latest. */
async function sideShiftOf(db: Database, claim: DerivedClaim, sale: HandinSaleRow | undefined): Promise<number | null> {
  if (claim.sideShiftId !== null) return claim.sideShiftId;
  if (claim.sideUserId === null) return null;
  const share = sale?.home?.shares.find((one) => one.userId === claim.sideUserId && one.shiftId !== null);
  if (share?.shiftId) return share.shiftId;
  const person = await findHandinPersonOfUser(db, claim.sideUserId);
  const latest = await findLatestHandinShift(db, { userIds: person?.userIds ?? [claim.sideUserId], before: new Date(claim.claimedAt) });
  return latest?.id ?? null;
}

export async function runSaleClaims(app: Pick<AppContext, "db" | "logger">, now: Date = new Date()): Promise<SaleClaimsTally> {
  const { db } = app;
  const tally: SaleClaimsTally = { claims: 0, opened: 0, withdrawn: 0, escalated: 0, matters: 0 };
  const since = moscowDay(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const recent = await listCurrentReportsSince(db, { since });
  const derived = deriveClaims(recent.map(viewOf));
  tally.claims = derived.length;

  // New claims: asked of the other side, or the owner's at once.
  const derivedSales = [...new Set(derived.map((one) => one.transactionId))];
  const known = new Map((await listSaleClaims(db, { transactionIds: derivedSales })).map((claim) => [claimKey(claim.claimantHandinId, claim.transactionId, claim.sideUserId), claim]));
  const sales = new Map((await listHandinSalesByIds(db, derivedSales)).map((sale) => [sale.transactionId, sale]));
  const people = await listHandinPeopleOfUsers(db, [...new Set(derived.flatMap((one) => (one.sideUserId === null ? [] : [one.sideUserId])))]);
  for (const claim of derived) {
    const existing = known.get(claimKey(claim.claimantHandinId, claim.transactionId, claim.sideUserId));
    if (existing !== undefined) {
      if (existing.claimantVersion !== claim.claimantVersion && OPEN_STATES.includes(existing.state as typeof OPEN_STATES[number])) {
        await updateSaleClaim(db, existing.id, { claimantVersion: claim.claimantVersion, claimantNote: claim.note }, now);
      }
      continue;
    }
    const sale = sales.get(claim.transactionId);
    const side = claim.sideUserId === null ? null : people.get(claim.sideUserId) ?? null;
    // The side answers on their shift report: a person who hands shifts in in Hub. Anyone else — the owner decides.
    const askable = claim.kind === "claim" && side !== null && side.submitsShiftSince !== null && side.state !== "left";
    const why = claim.kind === "double" ? "double" as const : askable ? null : "no_side" as const;
    const inserted = await insertSaleClaim(db, {
      transactionId: claim.transactionId,
      pageId: sale?.pageId ?? null,
      kind: claim.kind,
      claimantUserId: claim.claimantUserId,
      claimantHandinId: claim.claimantHandinId,
      claimantVersion: claim.claimantVersion,
      statement: claim.statement,
      shareWithUserId: claim.shareWithUserId,
      claimantNote: claim.note,
      claimedAt: new Date(claim.claimedAt),
      sideUserId: claim.sideUserId,
      sideShiftId: await sideShiftOf(db, claim, sale),
      state: why === null ? "asked" : "owner",
      escalatedAt: why === null ? null : now,
      escalatedWhy: why,
    }, now);
    if (inserted !== null) tally.opened += 1;
  }

  // The open claims: withdrawn when the report no longer counts the sale, the owner's after a day of silence.
  const open = await listSaleClaims(db, { states: [...OPEN_STATES], kinds: ["claim", "double"] });
  const holding = (await listCurrentReportsOfSales(db, [...new Set(open.flatMap((claim) => (claim.transactionId === null ? [] : [claim.transactionId])))])).map(viewOf);
  for (const claim of open) {
    if (!claimStands(claim, holding)) {
      await updateSaleClaim(db, claim.id, { state: "withdrawn", closedAt: now }, now);
      tally.withdrawn += 1;
      continue;
    }
    if (claim.state === "asked" && now.getTime() - claim.createdAt.getTime() >= CLAIM_SILENCE_MS) {
      await updateSaleClaim(db, claim.id, { state: "owner", escalatedAt: now, escalatedWhy: "silence" }, now);
      tally.escalated += 1;
    }
  }

  tally.matters = await syncClaimMatters(app, now);
  tally.matters += await syncOffPlatformMatters(app, now);
  tally.matters += await syncNobodyWeek(app, now);
  tally.matters += await syncUnlinkedDecisions(app, now);
  if (tally.opened + tally.withdrawn + tally.escalated > 0) app.logger.info(tally, "sale claims");
  return tally;
}

/** «/workboard/my/shifts/<id>?sale=<id>»: the side's shift report at the line. */
const sideLink = (claim: Pick<SaleClaimRow, "sideShiftId" | "transactionId">) =>
  (claim.sideShiftId === null ? null : `/workboard/my/shifts/${claim.sideShiftId}${claim.transactionId === null ? "" : `?sale=${claim.transactionId}`}`);

const disputeKey = (claim: Pick<SaleClaimRow, "transactionId" | "id">) => (claim.transactionId === null ? `${SALE_DISPUTE_KIND}:q${claim.id}` : `${SALE_DISPUTE_KIND}:${claim.transactionId}`);

/** The side's matters while asked, the owner's ONE per sale while any claim of it is his; everything else closes. */
async function syncClaimMatters(app: Pick<AppContext, "db" | "logger">, now: Date): Promise<number> {
  const { db } = app;
  const claims = await listSaleClaims(db, { states: ["asked", "owner"] });
  const sales = new Map((await listHandinSalesByIds(db, [...new Set(claims.flatMap((claim) => (claim.transactionId === null ? [] : [claim.transactionId])))]))
    .map((sale) => [sale.transactionId, sale]));
  const names = await listHandinNames(db, claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((id): id is number => id !== null)));
  const pages = await listMatterPageLabels(db);
  let touched = 0;
  const wantSide = new Set<string>();
  const wantOwner = new Map<string, SaleClaimRow[]>();
  for (const claim of claims) {
    // A question the agent asked the chatters is theirs to settle in their chat: no matter of the side.
    if (claim.state === "asked" && claim.sideUserId !== null && claim.kind !== "question") {
      const key = `${SALE_CLAIM_KIND}:${claim.id}`;
      wantSide.add(key);
      const sale = claim.transactionId === null ? undefined : sales.get(claim.transactionId);
      const opened = await openMatter(db, {
        key,
        kind: SALE_CLAIM_KIND,
        source: "server",
        title: claimTitle({
          claimant: names.get(claim.claimantUserId ?? -1) ?? "Коллега",
          statement: claim.statement ?? "mine",
          kind: sale?.kind ?? "",
          fan: sale ? fanName(sale.fan) : null,
          netMills: sale?.netMills ?? 0,
          day: moscowDay((sale?.occurredAt ?? claim.claimedAt).getTime()),
        }),
        object: { type: "sale_claim", id: String(claim.id) },
        pageIds: claim.pageId === null ? [] : [claim.pageId],
        owner: { userId: claim.sideUserId },
        money: false,
        evidence: {
          claimId: claim.id, transactionId: claim.transactionId, statement: claim.statement, note: claim.claimantNote,
          saidAt: claim.claimedAt.toISOString(), answerBy: new Date(claim.createdAt.getTime() + CLAIM_SILENCE_MS).toISOString(),
        },
        link: sideLink(claim),
      }, SYSTEM, now);
      if (opened.transition !== "unchanged") touched += 1;
    }
    if (claim.state === "owner") {
      const key = disputeKey(claim);
      wantOwner.set(key, [...(wantOwner.get(key) ?? []), claim]);
    }
  }
  for (const [key, list] of wantOwner) {
    const first = list[0]!;
    const sale = first.transactionId === null ? undefined : sales.get(first.transactionId);
    const who = [...new Set(list.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((id): id is number => id !== null)))]
      .map((id) => names.get(id) ?? `#${id}`);
    const label = sale?.pageLabel ?? (typeof first.ledgerRef?.pageLabel === "string" ? first.ledgerRef.pageLabel : null);
    const opened = await openMatter(db, {
      key,
      kind: SALE_DISPUTE_KIND,
      source: "server",
      // A dispute's title names the page, the amount, the day and the people — never a fan (review R2b-3c); a question
      // says it is one, and one asked of the chatters that nobody answered says so and since when (review R2b-6).
      title: list.every((claim) => claim.kind === "imported" || claim.kind === "question")
        ? questionTitle({
          list, pageLabel: label, ref: first.ledgerRef ?? {}, sale,
          names: who.length > 0 ? who : first.whoText === null ? [] : [first.whoText],
        })
        : sale
          ? disputeTitle({ names: who, kind: sale.kind, netMills: sale.netMills, day: moscowDay(sale.occurredAt.getTime()) })
          : questionTitle({ list, pageLabel: label, ref: first.ledgerRef ?? {}, sale, names: who.length > 0 ? who : first.whoText === null ? [] : [first.whoText] }),
      object: first.transactionId === null ? { type: "sale_claim", id: String(first.id) } : { type: "transaction", id: String(first.transactionId) },
      pageIds: label === null ? [] : [pages.idOf.get(label)].filter((id): id is number => id !== undefined),
      owner: { role: "owner" },
      money: true,
      evidence: {
        transactionId: first.transactionId, claimIds: list.map((claim) => claim.id), netMills: sale?.netMills ?? null,
        why: [...new Set(list.map((claim) => claim.escalatedWhy))], saidAt: list.map((claim) => claim.claimedAt.toISOString()).sort()[0],
      },
      link: first.transactionId === null ? `/workboard/decisions?claim=${first.id}#questions` : `/workboard/decisions?dispute=${first.transactionId}#questions`,
    }, SYSTEM, now);
    if (opened.transition !== "unchanged") touched += 1;
  }
  for (const matter of await listOpenMattersOfKinds(db, [SALE_CLAIM_KIND, SALE_DISPUTE_KIND])) {
    const wanted = matter.kind === SALE_CLAIM_KIND ? wantSide.has(matter.key) : wantOwner.has(matter.key);
    if (wanted) continue;
    const closed = await closeMatter(db, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") touched += 1;
  }
  return touched;
}

/**
 * The owner's matter of a question, never naming the fan: «Вопрос чаттерам без ответа с 5 нояб.: mia-1, $16.00,
 * 11 нояб., Аня и Боря» (asked of the chatters, nobody answered), else «Вопрос «чья продажа» из ledger: …» — the page,
 * the amount, the sale's day, the people.
 */
function questionTitle(input: {
  list: readonly SaleClaimRow[];
  pageLabel: string | null;
  ref: Record<string, unknown>;
  sale: HandinSaleRow | undefined;
  names: readonly string[];
}): string {
  const refAt = typeof input.ref.occurredAt === "string" ? Date.parse(input.ref.occurredAt) : Number.NaN;
  const at = input.sale?.occurredAt.getTime() ?? refAt;
  const net = input.sale?.netMills ?? (typeof input.ref.netMills === "number" ? input.ref.netMills : null);
  const parts = [
    input.pageLabel,
    net === null ? null : money(net),
    Number.isNaN(at) ? null : dayWords(moscowDay(at)),
    input.names.length > 0 ? input.names.join(" и ") : null,
  ].filter((part): part is string => part !== null && part !== "");
  const words = parts.length > 0 ? `: ${parts.join(", ")}` : "";
  const toChatters = input.list.some((claim) => (claim.askedOf ?? (typeof claim.ledgerRef?.askedOf === "string" ? claim.ledgerRef.askedOf : null)) === "chatters");
  if (toChatters) {
    const since = Math.min(...input.list.map((claim) => claim.claimedAt.getTime()));
    return `Вопрос чаттерам без ответа с ${dayWords(moscowDay(since))}${words}`;
  }
  return `Вопрос «чья продажа»${input.list.some((claim) => claim.kind === "imported") ? " из ledger" : ""}${words}`;
}

function fanName(fan: { name: string | null; username: string | null }): string | null {
  return fan.name?.trim() || (fan.username ? `@${fan.username}` : null);
}

/** One owner's matter per handed-in report with «мимо площадки» waiting. */
async function syncOffPlatformMatters(app: Pick<AppContext, "db">, now: Date): Promise<number> {
  const { db } = app;
  const pending = await listPendingOffPlatform(db);
  const byReport = new Map<number, typeof pending>();
  for (const line of pending) byReport.set(line.handinId, [...(byReport.get(line.handinId) ?? []), line]);
  const names = await listHandinNames(db, pending.map((line) => line.userId));
  const pages = await listMatterPageLabels(db);
  let touched = 0;
  const want = new Set<string>();
  for (const [handinId, lines] of byReport) {
    const key = `${OFF_PLATFORM_PENDING_KIND}:${handinId}`;
    want.add(key);
    const first = lines[0]!;
    const mills = lines.reduce((sum, line) => sum + line.amountMills, 0);
    const opened = await openMatter(db, {
      key,
      kind: OFF_PLATFORM_PENDING_KIND,
      source: "server",
      title: offPlatformTitle({ person: names.get(first.userId) ?? "чаттер", reportDate: first.reportDate, count: lines.length, mills }),
      object: { type: "shift", id: String(first.shiftId) },
      pageIds: first.pages.map((label) => pages.idOf.get(label)).filter((id): id is number => id !== undefined),
      owner: { role: "owner" },
      money: true,
      evidence: {
        shiftId: first.shiftId, reportDate: first.reportDate, totalMills: mills, saidAt: first.createdAt.toISOString(),
        lines: lines.map((line) => ({ id: line.id, amountMills: line.amountMills, fromWhom: line.fromWhom, whatFor: line.whatFor })),
      },
      link: `/workboard/decisions?offPlatform=${first.shiftId}#reports`,
    }, SYSTEM, now);
    if (opened.transition !== "unchanged") touched += 1;
  }
  for (const matter of await listOpenMattersOfKinds(db, [OFF_PLATFORM_PENDING_KIND])) {
    if (want.has(matter.key)) continue;
    const closed = await closeMatter(db, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") touched += 1;
  }
  return touched;
}

/**
 * The week's sales nobody claimed: of the days all of whose shifts are handed in, the sales whose home is nobody's or
 * the owner's to decide, that no report counts and the owner has not decided. Pure on its inputs.
 */
async function nobodyOfWeek(db: Database, weekStart: number, now: Date): Promise<{ from: string; to: string; days: string[]; sales: Array<Awaited<ReturnType<typeof listUnownedSales>>[number]> }> {
  const from = moscowDay(weekStart);
  const to = moscowDay(weekStart + 6 * DAY_MS);
  const today = moscowDay(now.getTime());
  const days = await listDaysHandedIn(db, { from, to: to < today ? to : today });
  const unowned = await listUnownedSales(db, { days });
  const ids = unowned.map((sale) => sale.transactionId);
  const counted = new Set((await listCurrentReportsOfSales(db, ids)).flatMap((report) => report.lines
    .filter((line) => line.transactionId !== null && (line.amountMills > 0 || (line.claimedMills ?? 0) > 0)).map((line) => line.transactionId!)));
  const decided = await listActiveSaleDecisions(db, ids);
  return { from, to, days, sales: unowned.filter((sale) => !counted.has(sale.transactionId) && !decided.has(sale.transactionId)) };
}

async function syncNobodyWeek(app: Pick<AppContext, "db">, now: Date): Promise<number> {
  const { db } = app;
  let touched = 0;
  const thisWeek = moscowWeekStart(now.getTime());
  const want = new Set<string>();
  for (const start of [thisWeek - 7 * DAY_MS, thisWeek]) {
    if (start + 7 * DAY_MS <= SALE_RULE.since) continue;
    const week = await nobodyOfWeek(db, start, now);
    const key = `${SALE_NOBODY_WEEK_KIND}:${week.from}`;
    if (week.sales.length === 0) continue;
    want.add(key);
    const mills = week.sales.reduce((sum, sale) => sum + sale.netMills, 0);
    const opened = await openMatter(db, {
      key,
      kind: SALE_NOBODY_WEEK_KIND,
      source: "server",
      title: nobodyWeekTitle({ count: week.sales.length, mills, from: week.from, to: week.to }),
      object: null,
      pageIds: [],
      owner: { role: "owner" },
      money: true,
      evidence: { week: week.from, count: week.sales.length, totalMills: mills, days: week.days, transactionIds: week.sales.slice(0, 200).map((sale) => sale.transactionId) },
      link: `/workboard/decisions?nobody=${week.from}#questions`,
    }, SYSTEM, now);
    if (opened.transition !== "unchanged") touched += 1;
  }
  for (const matter of await listOpenMattersOfKinds(db, [SALE_NOBODY_WEEK_KIND])) {
    if (want.has(matter.key)) continue;
    const closed = await closeMatter(db, { key: matter.key, how: "resolved", writer: "server" }, SYSTEM, now);
    if (closed.transition === "closed") touched += 1;
  }
  return touched;
}

async function syncUnlinkedDecisions(app: Pick<AppContext, "db">, now: Date): Promise<number> {
  const { db } = app;
  const key = `${SALE_DECISIONS_UNLINKED_KIND}:ledger`;
  const unlinked = await listSaleDecisions(db, { needsLink: true, activeOnly: true });
  if (unlinked.length === 0) {
    const closed = await closeMatter(db, { key, how: "resolved", writer: "server" }, SYSTEM, now);
    return closed.transition === "closed" ? 1 : 0;
  }
  const opened = await openMatter(db, {
    key,
    kind: SALE_DECISIONS_UNLINKED_KIND,
    source: "server",
    title: `Решения «чья продажа» из ledger без продажи: ${unlinked.length}, привяжите`,
    object: null,
    pageIds: [],
    owner: { role: "owner" },
    money: true,
    evidence: { decisionIds: unlinked.map((one) => one.id), count: unlinked.length },
    link: "/workboard/decisions?unlinked=1#questions",
  }, SYSTEM, now);
  return opened.transition === "unchanged" ? 0 : 1;
}

// ── Settling a claim: the reports' new versions ──────────────────────────────

interface SettleBy {
  door: HandinDoor;
  actorUserId: number | null;
  agentKeyId: number | null;
  telegramMessageRef: string | null;
  telegramSenderId: number | null;
}

/**
 * Whether the ledger paid the day of each report, by shift: asked once per person and day, before any report is locked
 * — the ledger's HTTP (up to 20 s a call) never runs under a lock. A report that appears after this read is «not known».
 */
async function paidDaysOf(app: ClaimsApp, reports: ReadonlyArray<{ shiftId: number; userId: number; reportDate: string }>): Promise<Map<number, boolean | null>> {
  const codes = await listHandinPeopleOfUsers(app.db, reports.map((report) => report.userId));
  const byDay = new Map<string, boolean | null>();
  const out = new Map<number, boolean | null>();
  for (const report of reports) {
    const personCode = codes.get(report.userId)?.code ?? null;
    const key = `${personCode ?? `#${report.userId}`}:${report.reportDate}`;
    if (!byDay.has(key)) byDay.set(key, await ledgerDayPaid(app, { personCode, reportDate: report.reportDate }));
    out.set(report.shiftId, byDay.get(key) ?? null);
  }
  return out;
}

/** A version the system made of a report: which, and whether the ledger had said its day paid. */
interface MadeVersion {
  shiftId: number;
  version: number;
  versionId: number;
  dayPaid: boolean | null;
}

/** Whether two lines count the same: the amount, the dispute and what it claims, and what settled it. */
const countsAlike = (a: HandinVersionLine, b: HandinVersionLine) => a.amountMills === b.amountMills && a.disputed === b.disputed
  && (a.claimedMills ?? null) === (b.claimedMills ?? null) && (a.settled ?? null) === (b.settled ?? null);

/**
 * A new version of a handed-in report with one sale's line changed (made by the system, the reason kept in `made_for`);
 * nothing when the line already says it. `to` — what the line becomes: settled at an amount (the owner's decision, the
 * sides' agreement), or, a settlement gone, the line as the shift's draft has it now (`line`; null — the sale is no line
 * of that draft: it counts nothing here). Run in the caller's transaction (the report locked): it checks only Hub's own
 * versions under the lock; whether the day is paid was read before it (`paidDaysOf`). The version keeps the report's
 * date: only the person's own hand-in dates a report, and the day asked of the ledger is the day written.
 */
async function settleReport(
  db: Database,
  input: {
    shiftId: number; transactionId: number;
    to: { amountMills: number; settled: "agreed" | "owner" } | { line: HandinVersionLine | null };
    madeFor: HandinVersionMadeFor; by: SettleBy; at: Date; dayPaid: boolean | null;
  },
): Promise<MadeVersion | null> {
  const handin = await findHandinByShift(db, input.shiftId, { lock: true });
  if (handin === null || handin.state !== "submitted") return null;
  const current = (await listCurrentHandinVersions(db, [handin.id])).get(handin.id);
  if (current === undefined) return null;
  const line = current.lines.find((one) => one.transactionId === input.transactionId);
  if (line === undefined) return null;
  const pages = current.pages.map((page) => page.pageLabel);
  let made: { lines: HandinVersionLine[]; pages: Array<{ pageLabel: string; amountMills: number }>; totalMills: number };
  if ("line" in input.to) {
    const { claimedMills: _claimed, settled: _settled, ...rest } = line;
    const next: HandinVersionLine = input.to.line ?? { ...rest, amountMills: 0, disputed: false, statement: null, shareWithUserId: null };
    if (countsAlike(line, next)) return null;
    const lines = current.lines.map((one) => (one.transactionId === input.transactionId ? next : one));
    made = { lines, ...reportSums(lines, pages, current.offPlatform) };
  } else {
    if (line.amountMills === input.to.amountMills && !line.disputed) return null;
    const settled = settledVersion({
      lines: current.lines, pages, offPlatform: current.offPlatform,
      transactionId: input.transactionId, amountMills: input.to.amountMills, settled: input.to.settled,
    });
    made = { ...settled, lines: settled.lines as HandinVersionLine[] };
  }
  const dayPaid = input.dayPaid;
  // Telegram's door is an agent's «со слов» alone; the system's version on the owner's word is the owner's Workboard.
  const telegram = input.by.door === "telegram" && input.by.agentKeyId !== null && input.by.telegramMessageRef !== null && input.by.telegramSenderId !== null;
  const version = await insertHandinVersion(db, {
    handin,
    door: telegram ? "telegram" : input.by.door === "telegram" ? "workboard" : input.by.door,
    actorUserId: input.by.actorUserId,
    agentKeyId: telegram ? input.by.agentKeyId : null,
    telegramMessageRef: telegram ? input.by.telegramMessageRef : null,
    telegramSenderId: telegram ? input.by.telegramSenderId : null,
    totalMills: made.totalMills,
    pages: made.pages,
    lines: made.lines,
    offPlatform: current.offPlatform,
    comment: current.comment,
    dayPaid,
    ruleVersion: SALE_RULE.version,
    madeFor: input.madeFor,
    reportDate: handin.reportDate,
    at: input.at,
  });
  const amountMills = made.lines.find((one) => one.transactionId === input.transactionId)?.amountMills ?? 0;
  await insertHandinEvent(db, {
    handinId: handin.id, event: "shift_report.settled", door: "system", actorUserId: input.by.actorUserId, agentKeyId: input.by.agentKeyId,
    onBehalfOfUserId: null, changes: { version: version.version, transactionId: input.transactionId, amountMills, madeFor: input.madeFor }, at: input.at,
  });
  return { shiftId: input.shiftId, version: version.version, versionId: version.id, dayPaid };
}

/** After a settlement: the report of a paid day changed is the owner's matter (as a hand-in after the ledger paid it). */
async function afterPaid(app: ClaimsApp, made: readonly MadeVersion[], now: Date) {
  for (const one of made) {
    if (one.dayPaid !== true) continue;
    await openMatter(app.db, {
      key: `${SHIFT_REPORT_AFTER_PAID_KIND}:${one.versionId}`,
      kind: SHIFT_REPORT_AFTER_PAID_KIND,
      source: "server",
      title: `Отчёт смены после выплаты: версия ${one.version} по решению о продаже`,
      object: { type: "shift", id: String(one.shiftId) },
      pageIds: [],
      owner: { role: "owner" },
      money: true,
      evidence: { shiftId: one.shiftId, version: one.version },
      link: `/workboard/shifts/report/${one.shiftId}`,
    }, SYSTEM, now).catch((error: unknown) => {
      app.logger.warn({ shiftId: one.shiftId, err: error instanceof Error ? error.message : String(error) }, "sale claims: the owner's matter «после выплаты» did not open");
    });
  }
}

/**
 * The sale's Moscow day computed again (never a day before the rule), on `db` — the pool, or the caller's transaction
 * when what follows in it reads the home (a cancel: the reports go back to the rule's home, so it is computed first and
 * a failure fails the cancel whole).
 */
async function refreshHomeWithin(db: Database, occurredAt: Date | null, now: Date): Promise<void> {
  if (occurredAt === null || occurredAt.getTime() < SALE_RULE.since) return;
  const from = new Date(`${moscowDay(occurredAt.getTime())}T00:00:00+03:00`);
  await refreshSaleHomes(db, { from, to: new Date(Math.min(now.getTime(), from.getTime() + DAY_MS)), now });
}

/** The sale's Moscow day computed again after a commit: its home follows the agreement or the decision at once. */
async function refreshHomeOf(app: ClaimsApp, occurredAt: Date | null, now: Date) {
  await refreshHomeWithin(app.db, occurredAt, now).catch((error: unknown) => {
    app.logger.warn({ at: occurredAt?.toISOString(), err: error instanceof Error ? error.message : String(error) }, "sale claims: the sale's home was not computed again; the hourly job will");
  });
}

// ── The other side's answer ──────────────────────────────────────────────────

/** Whether the side may answer now: asked, or gone to the owner by silence and not decided. */
const answerable = (claim: SaleClaimRow) => claim.kind === "claim"
  && (claim.state === "asked" || (claim.state === "owner" && claim.escalatedWhy === "silence" && claim.answer === null));

/** `saleClaimAnswer`, `agentSaleClaimAnswer`: «Согласен» settles it; «Не согласен» with a line of why takes it to the owner. */
export async function answerSaleClaim(
  app: ClaimsApp,
  actor: HandinActor,
  input: { claimId: number; answer: "agree" | "disagree"; note: string | null },
  now: Date = new Date(),
): Promise<{ claim: SaleClaim; savedAt: string }> {
  const { db } = app;
  const found = await findSaleClaim(db, input.claimId);
  if (found === null || found.sideUserId === null || found.kind !== "claim") throw new NotFoundError("No such claim");
  const side = await findHandinPersonOfUser(db, found.sideUserId);
  const sideIds = side?.userIds ?? [found.sideUserId];
  if (actor.kind === "person") {
    if (!sideIds.includes(actor.userId)) throw new ForbiddenError("Only the other side answers a claim");
  } else {
    if (found.pageId !== null && !actor.pageIds.includes(found.pageId)) throw new NotFoundError("Not found");
    if (actor.sourceRef === null) throw new BadRequestError("An answer «со слов» needs the message", { reason: "source_ref_required" });
    if (side?.telegramUserId == null || side.telegramUserId !== actor.telegramUserId) {
      throw new ConflictError("The message's sender is not this person", { reason: "sender_not_person" });
    }
  }
  if (side !== null && side.submitsShiftSince === null) throw new ForbiddenError("The shift report is not switched on for this person");
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  if (input.answer === "disagree" && note === null) throw new BadRequestError("«Не согласен» needs one line of why", { reason: "note_required" });
  if (!answerable(found)) throw new ConflictError("This claim is already answered or decided", { reason: "claim_closed" });

  const door: HandinDoor = actor.kind === "agent" ? "telegram" : actor.door;
  const by: SettleBy = actor.kind === "person"
    ? { door, actorUserId: actor.userId, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null }
    : { door, actorUserId: null, agentKeyId: actor.agentKeyId, telegramMessageRef: actor.sourceRef, telegramSenderId: actor.telegramUserId };
  const made: MadeVersion[] = [];
  const sale = found.transactionId === null ? undefined : (await listHandinSalesByIds(db, [found.transactionId]))[0];
  const paid = input.answer !== "agree" || found.transactionId === null ? new Map<number, boolean | null>()
    : await paidDaysOf(app, await listCurrentReportsOfSales(db, [found.transactionId]));
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    const claim = await findSaleClaim(txDb, input.claimId, { lock: true });
    if (claim === null || !answerable(claim)) throw new ConflictError("This claim is already answered or decided", { reason: "claim_closed" });
    await updateSaleClaim(txDb, claim.id, {
      answer: input.answer, answerNote: note, answeredAt: now, answerDoor: door, answerRef: actor.kind === "agent" ? actor.sourceRef : null,
      answeredByUserId: actor.kind === "person" ? actor.userId : null, answeredByAgentKeyId: actor.kind === "agent" ? actor.agentKeyId : null,
      ...(input.answer === "agree" ? { state: "agreed" as const, closedAt: now } : { state: "owner" as const, escalatedAt: now, escalatedWhy: "disagree" as const }),
    }, now);
    if (input.answer !== "agree" || claim.transactionId === null || claim.claimantUserId === null) return;
    // Agreed: every report that counts the sale gets what the agreement gives — the claimant all (or a half), the side none (or the other half).
    const reports = await listCurrentReportsOfSales(txDb, [claim.transactionId]);
    const net = reports.flatMap((report) => report.lines).find((line) => line.transactionId === claim.transactionId)?.netMills ?? sale?.netMills ?? 0;
    for (const report of reports) {
      const mine = report.userId === claim.claimantUserId;
      const theirs = sideIds.includes(report.userId);
      if (!mine && !theirs) continue;
      const amount = shareAfter({
        netMills: net, userId: mine ? claim.claimantUserId : claim.sideUserId!, outcome: "agreed",
        first: claim.claimantUserId, second: claim.sideUserId, statement: claim.statement,
      });
      const one = await settleReport(txDb, {
        shiftId: report.shiftId, transactionId: claim.transactionId, to: { amountMills: amount, settled: "agreed" },
        madeFor: { kind: "claim", claimId: claim.id, transactionId: claim.transactionId, outcome: "agreed" }, by, at: now,
        dayPaid: paid.get(report.shiftId) ?? null,
      });
      if (one !== null) made.push(one);
    }
  });
  await afterPaid(app, made, now);
  if (input.answer === "agree") await refreshHomeOf(app, sale?.occurredAt ?? null, now);
  await runSaleClaims(app, now).catch((error: unknown) => {
    app.logger.warn({ claimId: input.claimId, err: error instanceof Error ? error.message : String(error) }, "sale claims: the pass after an answer failed; the next one will");
  });
  const claim = (await findSaleClaim(db, input.claimId))!;
  const [wire] = await claimWires(db, [claim]);
  return { claim: wire!, savedAt: now.toISOString() };
}

// ── The owner's decision ─────────────────────────────────────────────────────

function requireOwnerSession(principal: HumanAuthPrincipal) {
  if (principal.user.role !== "owner" || principal.narrowDeviceTokenId !== undefined) throw new ForbiddenError("Only the owner decides");
}

/** The two people of a sale's dispute: the first claim's claimant, its side (null — none). */
function partiesOf(claims: readonly SaleClaimRow[]): { first: number | null; second: number | null } {
  const lead = claims.find((claim) => claim.state === "owner") ?? claims[0];
  return { first: lead?.claimantUserId ?? null, second: lead?.sideUserId ?? null };
}

/** `saleDisputeDecide`: to the first, to the second, in halves, to nobody (who, when and why kept); every counting report follows. */
export async function decideSaleDispute(
  app: ClaimsApp,
  principal: HumanAuthPrincipal,
  input: { transactionId?: number | undefined; claimId?: number | undefined; outcome: OwnerOutcome | "dismiss"; note: string | null },
  now: Date = new Date(),
) {
  requireOwnerSession(principal);
  const { db } = app;
  const claims = input.transactionId !== undefined
    ? await listSaleClaims(db, { transactionIds: [input.transactionId] })
    : await listSaleClaims(db, { ids: [input.claimId!] });
  const open = claims.filter((claim) => claim.state === "owner" || claim.state === "asked" || claim.state === "agreed");
  if (open.length === 0) throw new NotFoundError("No dispute of this sale waits for a decision");
  const transactionId = input.transactionId ?? open[0]!.transactionId;
  const { first, second } = partiesOf(open);
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  if (input.outcome === "dismiss") {
    if (open.some((claim) => claim.kind !== "imported" && claim.kind !== "question")) throw new BadRequestError("Only a question closes without a decision", { reason: "not_imported" });
    for (const claim of open) await updateSaleClaim(db, claim.id, { state: "decided", closedAt: now }, now);
    await runSaleClaims(app, now).catch(() => undefined);
    return { decided: false, versions: [], savedAt: now.toISOString() };
  }
  const outcome: OwnerOutcome = input.outcome;
  if (transactionId === null) throw new BadRequestError("Tie the question to its sale first", { reason: "needs_link" });
  if (first === null && outcome !== "nobody") throw new BadRequestError("This dispute names nobody: only «никому»", { reason: "no_parties" });
  if ((outcome === "second" || outcome === "half") && second === null) throw new BadRequestError("This dispute has no second side", { reason: "no_second" });
  const decision = decisionOfOutcome(outcome, first ?? 0, second);
  const sale = (await listHandinSalesByIds(db, [transactionId]))[0];
  const applied = await applySaleDecision(app, {
    transactionId,
    insert: {
      kind: decision.kind, shares: decision.shares, pot: null, outcome, note, decidedByUserId: principal.user.id, decidedAt: now,
      saidBy: null, source: "dispute", ledgerDecisionId: null, ledgerRef: null,
    },
    madeFor: () => ({ kind: "claim", claimId: open[0]!.id, transactionId, outcome }),
    by: { door: "workboard", actorUserId: principal.user.id, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null },
  }, sale, now);
  return { decided: true, versions: applied.versions.map((one) => ({ shiftId: one.shiftId, version: one.version })), savedAt: now.toISOString() };
}

/**
 * A decision on a sale, written and followed (review R2b-3b): the active one before it superseded, every open claim and
 * question of the sale decided with it, every handed-in report holding the sale given what the decision gives its person
 * (a new version, settled; the ledger asked about paid days before any lock), the sale's home computed again and the
 * matters closed by the claims' pass. The owner's decision of a dispute and a decision recorded «со слов» through the
 * agent's door both go here, so they behave the same.
 *
 * Everything is read where it is written: in the transaction, in the sale settlements' turn (`lockSaleSettlements`) —
 * the claims open then, the reports handed in then, the people's logins then — never what was read before the wait for
 * the ledger. A share is its person's by any of their logins (`settledShareOf`, the one a later draft counts by); a
 * line another report of the person already holds stays at nothing here.
 */
export async function applySaleDecision(
  app: ClaimsApp,
  input: {
    transactionId: number;
    insert: Omit<SaleDecisionInsert, "transactionId" | "pageId" | "ruleHome">;
    /** Why the reports' new versions were made. */
    madeFor: (decisionId: number | null) => HandinVersionMadeFor;
    by: SettleBy;
    /**
     * The caller's own checks, run first in the decision's transaction, before anything is written (the agent's door:
     * what the decision replaces and what it answers, read there). It throws to refuse. What it returns the decision
     * takes with it: `supersedes` — another decision it replaces (one with no sale: the sale's own active one is
     * superseded by the write itself), `answers` — a question it closes that the sale's open claims do not hold.
     */
    first?: (txDb: Database) => Promise<{ supersedes?: number | null; answers?: number | null }>;
  },
  sale: HandinSaleRow | undefined,
  now: Date,
): Promise<{ decisionId: number | null; versions: MadeVersion[] }> {
  const { db } = app;
  const { transactionId } = input;
  const made: MadeVersion[] = [];
  const paid = await paidDaysOf(app, await listCurrentReportsOfSales(db, [transactionId]));
  let decisionId: number | null = null;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    const also = (await input.first?.(txDb)) ?? {};
    const saved = await insertSaleDecision(txDb, { ...input.insert, transactionId, pageId: sale?.pageId ?? null, ruleHome: sale?.home?.home ?? null }, now);
    decisionId = saved?.id ?? null;
    if (also.supersedes != null && !(await supersedeSaleDecision(txDb, { id: also.supersedes, at: now }))) {
      throw new ConflictError("The decision it replaces is not active", { reason: "not_active" });
    }
    made.push(...await followDecision(txDb, {
      transactionId, decisionId, decision: { kind: input.insert.kind, shares: input.insert.shares }, answers: also.answers ?? null,
      madeFor: input.madeFor(decisionId), by: input.by, at: now, paid, saleNet: sale?.netMills ?? 0,
    }));
  });
  await afterPaid(app, made, now);
  await refreshHomeOf(app, sale?.occurredAt ?? null, now);
  await runSaleClaims(app, now).catch((error: unknown) => {
    app.logger.warn({ transactionId, err: error instanceof Error ? error.message : String(error) }, "sale claims: the pass after a decision failed; the next one will");
  });
  return { decisionId, versions: made };
}

/**
 * In the caller's transaction (the settlements' turn taken), a decision that rules a sale from now is followed: every
 * claim and question of the sale open now is decided with it (and `answers`, a question the sale's own do not hold),
 * and every handed-in report that holds the sale gets what it gives the report's person — their share under any of
 * their logins; a line another report of the person already holds stays at nothing here. Made on the sale, or tied to
 * it: the same.
 */
async function followDecision(
  txDb: Database,
  input: {
    transactionId: number; decisionId: number | null; answers?: number | null;
    decision: { kind: SaleDecisionRow["kind"]; shares: ReadonlyArray<{ userId: number; percent: number }> };
    madeFor: HandinVersionMadeFor; by: SettleBy; at: Date; paid: ReadonlyMap<number, boolean | null>; saleNet: number;
  },
): Promise<MadeVersion[]> {
  const { transactionId, decisionId, at } = input;
  const made: MadeVersion[] = [];
  const open = await listSaleClaims(txDb, { transactionIds: [transactionId], states: ["owner", "asked", "agreed"] });
  for (const id of new Set([...open.map((claim) => claim.id), ...(input.answers == null ? [] : [input.answers])])) {
    await updateSaleClaim(txDb, id, { state: "decided", decisionId, closedAt: at }, at);
  }
  const reports = await listCurrentReportsOfSales(txDb, [transactionId]);
  const people = await listHandinPeopleOfUsers(txDb, reports.map((report) => report.userId));
  const net = reports.flatMap((report) => report.lines).find((line) => line.transactionId === transactionId)?.netMills ?? input.saleNet;
  for (const report of reports) {
    const line = report.lines.find((one) => one.transactionId === transactionId);
    // Another report of the person holds the sale: it counts there, nothing here.
    if (line === undefined || line.alreadyIn != null) continue;
    const amount = settledShareOf({
      netMills: net, userIds: new Set(people.get(report.userId)?.userIds ?? [report.userId]), decision: input.decision, agreed: [],
    })?.amountMills ?? 0;
    if (line.amountMills === 0 && !line.disputed && amount === 0) continue;
    const one = await settleReport(txDb, {
      shiftId: report.shiftId, transactionId, to: { amountMills: amount, settled: "owner" },
      madeFor: input.madeFor, by: input.by, at, dayPaid: input.paid.get(report.shiftId) ?? null,
    });
    if (one !== null) made.push(one);
  }
  return made;
}

/** Where a claim a decision had closed waits again: where it was — the other side's to answer, or the owner's. */
function waitsAgain(claim: SaleClaimRow, now: Date): Pick<SaleClaimRow, "state" | "decisionId" | "closedAt" | "escalatedAt" | "escalatedWhy"> {
  const owner = claim.kind === "imported" || (claim.kind === "question" ? claim.askedOf !== "chatters" : claim.escalatedAt !== null);
  return {
    state: owner ? "owner" : "asked", decisionId: null, closedAt: null,
    escalatedAt: owner ? claim.escalatedAt ?? now : claim.escalatedAt,
    escalatedWhy: owner ? claim.escalatedWhy ?? (claim.kind === "imported" ? "imported" : "question") : claim.escalatedWhy,
  };
}

/**
 * A decision cancelled, and what follows it — the path a decision takes, the other way (final review, round 2). In one
 * transaction, in the settlements' turn: the decision is cancelled; nothing else decides its sale then (a decision it
 * had replaced does not come back), so the agreements a decision of the sale overrode stand again, the sale's home is
 * computed without it, and every handed-in report whose line a decision had settled gets a new version with what rules
 * now — the line as the shift's draft has it: an agreement of the two sides, else the rule with the person's own word,
 * what handing in again would write. The claims and questions a decision had closed wait again where they stand again:
 * a question always, a claim when the reports make it again. A day the ledger paid raises the owner's matter as after a
 * decision (asked before any lock).
 * `check` — the caller's own check of the decision as the transaction reads it (the agent's door: its page, whose it
 * is and whose message cancels it), on the connection it is read on; it throws to refuse and is asked once before the
 * ledger too, so a refusal costs no call.
 */
export async function cancelSaleDecisionApplied(
  app: ClaimsApp,
  input: { decisionId: number; note: string; by: SettleBy; check: (decision: SaleDecisionRow | null, db: Database) => Promise<SaleDecisionRow> },
  now: Date,
): Promise<{ versions: MadeVersion[] }> {
  const { db } = app;
  const before = await input.check((await listSaleDecisions(db, { ids: [input.decisionId] }))[0] ?? null, db);
  const paid = before.transactionId === null ? new Map<number, boolean | null>() : await paidDaysOf(app, await listCurrentReportsOfSales(db, [before.transactionId]));
  const made: MadeVersion[] = [];
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    const decision = await input.check((await listSaleDecisions(txDb, { ids: [input.decisionId] }))[0] ?? null, txDb);
    if (!(await cancelSaleDecision(txDb, { id: decision.id, note: input.note, at: now }))) {
      throw new ConflictError("Only an active decision is cancelled", { reason: "not_active" });
    }
    const saleId = decision.transactionId;
    const unruled = saleId !== null && !(await listActiveSaleDecisions(txDb, [saleId])).has(saleId);
    // What a decision closed and nothing decides now: the claims and questions of the sale, when no decision rules it
    // (also the ones a decision this one had replaced closed), and a question with no sale that this one answered.
    const closed = new Map<number, SaleClaimRow>();
    for (const claim of await listSaleClaims(txDb, { decisionIds: [decision.id], states: ["decided"] })) {
      if (claim.transactionId === null) closed.set(claim.id, claim);
    }
    if (unruled) {
      for (const claim of await listSaleClaims(txDb, { transactionIds: [saleId], states: ["decided"] })) if (claim.decisionId !== null) closed.set(claim.id, claim);
    }
    const agreed = [...closed.values()].filter((claim) => claim.answer === "agree");
    for (const claim of agreed) await updateSaleClaim(txDb, claim.id, { state: "agreed", decisionId: null, closedAt: claim.answeredAt }, now);
    let again: DerivedClaim[] = [];
    if (unruled) {
      await refreshHomeWithin(txDb, (await listHandinSalesByIds(txDb, [saleId]))[0]?.occurredAt ?? null, now);
      const settled = (await listCurrentReportsOfSales(txDb, [saleId]))
        .filter((report) => report.lines.some((line) => line.transactionId === saleId && line.settled === "owner"));
      // Every report first, then every line, then the versions: each draft reads the other reports as they stand before any of them changes.
      for (const report of settled) await findHandinByShift(txDb, report.shiftId, { lock: true });
      const lines: Array<HandinVersionLine | null> = [];
      for (const report of settled) lines.push(await draftLineOfSale(txDb, report.shiftId, saleId, now));
      for (const [at, report] of settled.entries()) {
        const one = await settleReport(txDb, {
          shiftId: report.shiftId, transactionId: saleId, to: { line: lines[at] ?? null },
          madeFor: { kind: "decision", decisionId: decision.id, transactionId: saleId, outcome: "cancelled" },
          by: input.by, at: now, dayPaid: paid.get(report.shiftId) ?? null,
        });
        if (one !== null) made.push(one);
      }
      again = deriveClaims((await listCurrentReportsOfSales(txDb, [saleId])).map(viewOf)).filter((one) => one.transactionId === saleId);
    }
    for (const claim of closed.values()) {
      if (claim.answer === "agree") continue;
      const stands = claim.kind === "question" || claim.kind === "imported"
        || again.some((one) => one.kind === claim.kind && one.claimantHandinId === claim.claimantHandinId && one.sideUserId === claim.sideUserId);
      if (stands) await updateSaleClaim(txDb, claim.id, waitsAgain(claim, now), now);
    }
  });
  await afterPaid(app, made, now);
  await runSaleClaims(app, now).catch((error: unknown) => {
    app.logger.warn({ decisionId: input.decisionId, err: error instanceof Error ? error.message : String(error) }, "sale claims: the pass after a cancelled decision failed; the next one will");
  });
  return { versions: made };
}

// ── «Мимо площадки» ──────────────────────────────────────────────────────────

/** `offPlatformPending`: the reports with «мимо площадки» waiting for the owner. */
export async function readOffPlatformPending(app: ClaimsApp, principal: HumanAuthPrincipal, query: { shiftId?: number | undefined }, now: Date = new Date()): Promise<OffPlatformPendingResponse> {
  requireOwnerSession(principal);
  const pending = (await listPendingOffPlatform(app.db)).filter((line) => query.shiftId === undefined || line.shiftId === query.shiftId);
  const names = await listHandinNames(app.db, pending.map((line) => line.userId));
  const versions = await listCurrentHandinVersions(app.db, [...new Set(pending.map((line) => line.handinId))]);
  const byReport = new Map<number, typeof pending>();
  for (const line of pending) byReport.set(line.handinId, [...(byReport.get(line.handinId) ?? []), line]);
  return {
    reports: [...byReport.entries()].map(([handinId, lines]) => ({
      shiftId: lines[0]!.shiftId,
      person: { userId: lines[0]!.userId, name: names.get(lines[0]!.userId) ?? "" },
      reportDate: lines[0]!.reportDate,
      pages: lines[0]!.pages,
      totalMills: versions.get(handinId)?.totalMills ?? 0,
      lines: lines.map((line) => ({ id: line.id, amountMills: line.amountMills, fromWhom: line.fromWhom, whatFor: line.whatFor, addedAt: line.createdAt.toISOString() })),
    })),
    serverNow: now.toISOString(),
  };
}

/**
 * `offPlatformDecide`: the owner's «Подтвердить» (the amount counts on a page of the report) or «Отклонить». The report
 * gets a new version made by the system with the line's state; the person never hands it in again for it.
 */
export async function decideOffPlatformLine(
  app: ClaimsApp,
  principal: HumanAuthPrincipal,
  input: { offPlatformId: number; decision: "confirm" | "reject"; pageLabel?: string | undefined; note: string | null },
  now: Date = new Date(),
) {
  requireOwnerSession(principal);
  const { db } = app;
  const row = await findOffPlatformWithReport(db, input.offPlatformId);
  if (row === null || row.state === "withdrawn") throw new NotFoundError("No such «мимо площадки» line");
  if (row.state !== "pending") throw new ConflictError("This line is already decided", { reason: "already_decided" });
  const pages = await listVisiblePages(db);
  const state = input.decision === "confirm" ? "confirmed" as const : "rejected" as const;
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  const person = await findHandinPersonOfUser(db, row.userId);
  // Asked before the report is locked, and only of a report handed in: the ledger's HTTP never runs under the lock.
  const report = await findHandinByShift(db, row.shiftId);
  const dayPaid = report === null || report.state !== "submitted" ? null : await ledgerDayPaid(app, { personCode: person?.code ?? null, reportDate: report.reportDate });
  let made: { version: number; versionId: number; dayPaid: boolean | null; shiftId: number } | null = null;
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    const handin = await findHandinByShift(txDb, row.shiftId, { lock: true });
    const current = handin === null ? undefined : (await listCurrentHandinVersions(txDb, [handin.id])).get(handin.id);
    const reportPages = current?.pages.map((page) => page.pageLabel) ?? [];
    const label = input.decision === "confirm" ? input.pageLabel ?? reportPages[0] ?? null : null;
    if (input.decision === "confirm" && (label === null || !reportPages.includes(label))) {
      throw new BadRequestError("Confirm it on one of the report's pages", { reason: "page_not_in_report" });
    }
    const pageId = label === null ? null : pages.find((page) => page.label === label)?.id ?? null;
    if (!(await decideOffPlatform(txDb, { id: row.id, state, pageId, note, byUserId: principal.user.id, at: now }))) {
      throw new ConflictError("This line is already decided", { reason: "already_decided" });
    }
    if (handin === null || current === undefined || handin.state !== "submitted") return;
    const offPlatform = current.offPlatform.map((line) => (line.id === row.id ? { ...line, state, pageLabel: label } : line));
    if (!offPlatform.some((line) => line.id === row.id)) offPlatform.push({ id: row.id, amountMills: row.amountMills, fromWhom: "", whatFor: "", state, pageLabel: label });
    const sums = reportSums(current.lines, reportPages, offPlatform);
    const version = await insertHandinVersion(txDb, {
      handin, door: "workboard", actorUserId: principal.user.id, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null,
      totalMills: sums.totalMills, pages: sums.pages, lines: current.lines, offPlatform, comment: current.comment, dayPaid,
      ruleVersion: SALE_RULE.version, madeFor: { kind: "off_platform", offPlatformId: row.id, decision: state },
      // The report's own date, the one the ledger was asked about above: only the person's hand-in dates a report.
      reportDate: handin.reportDate, at: now,
    });
    await insertHandinEvent(txDb, {
      handinId: handin.id, event: "shift_report.off_platform_decided", door: "workboard", actorUserId: principal.user.id, agentKeyId: null,
      onBehalfOfUserId: null, changes: { offPlatformId: row.id, state, pageLabel: label, version: version.version }, at: now,
    });
    made = { version: version.version, versionId: version.id, dayPaid, shiftId: row.shiftId };
  });
  const done = made as { version: number; versionId: number; dayPaid: boolean | null; shiftId: number } | null;
  if (done !== null) await afterPaid(app, [done], now);
  await syncOffPlatformMatters(app, now);
  return { state, version: done?.version ?? null, savedAt: now.toISOString() };
}

// ── The week's sales nobody claimed ──────────────────────────────────────────

export async function readSaleNobody(app: ClaimsApp, principal: HumanAuthPrincipal, query: { week: string }, now: Date = new Date()): Promise<SaleNobodyResponse> {
  requireOwnerSession(principal);
  const start = moscowWeekStart(Date.parse(`${query.week}T12:00:00+03:00`));
  const week = await nobodyOfWeek(app.db, start, now);
  const rows = new Map((await listHandinSalesByIds(app.db, week.sales.map((sale) => sale.transactionId))).map((row) => [row.transactionId, row]));
  const sales = week.sales.flatMap((sale) => {
    const row = rows.get(sale.transactionId);
    if (row === undefined) return [];
    return [{
      transactionId: row.transactionId, pageLabel: row.pageLabel, platform: row.platform, kind: row.kind, occurredAt: row.occurredAt.toISOString(),
      netMills: row.netMills, fan: row.fan, home: sale.home,
      words: sale.home === "decide" ? "держали несколько смен, фану никто из них не писал" : SALE_HOME_REASON_TEXT[sale.reason as SaleHomeReason] ?? sale.reason,
    }];
  });
  return { from: week.from, to: week.to, days: week.days, sales, totalMills: sales.reduce((sum, sale) => sum + sale.netMills, 0), serverNow: now.toISOString() };
}

/** `saleNobodyKeep`: the owner leaves the week's unclaimed sales nobody's: each is his decision «никому». */
export async function keepSalesNobody(app: ClaimsApp, principal: HumanAuthPrincipal, input: { week: string; transactionIds?: readonly number[] | undefined }, now: Date = new Date()) {
  requireOwnerSession(principal);
  const start = moscowWeekStart(Date.parse(`${input.week}T12:00:00+03:00`));
  const week = await nobodyOfWeek(app.db, start, now);
  const wanted = input.transactionIds === undefined ? null : new Set(input.transactionIds);
  const sales = week.sales.filter((sale) => wanted === null || wanted.has(sale.transactionId));
  await app.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    for (const sale of sales) {
      await insertSaleDecision(txDb, {
        transactionId: sale.transactionId, pageId: sale.pageId, kind: "nobody", shares: [], pot: null, outcome: "nobody", ruleHome: sale.home,
        note: "ничья: никто не заявил, владелец оставил", decidedByUserId: principal.user.id, decidedAt: now, saidBy: null, source: "dispute",
        ledgerDecisionId: null, ledgerRef: null,
      }, now);
    }
  });
  await syncNobodyWeek(app, now);
  return { kept: sales.length, savedAt: now.toISOString() };
}

// ── Decisions carried over from the ledger, tied to a sale by the owner ──────

export async function readUnlinkedDecisions(app: ClaimsApp, principal: HumanAuthPrincipal, now: Date = new Date()): Promise<SaleDecisionsUnlinkedResponse> {
  requireOwnerSession(principal);
  const decisions = await listSaleDecisions(app.db, { needsLink: true, activeOnly: true });
  const names = await listHandinNames(app.db, decisions.flatMap((one) => one.shares.map((share) => share.userId)));
  const out: SaleDecisionsUnlinkedResponse["decisions"] = [];
  for (const decision of decisions) {
    const ref = decision.ledgerRef ?? {};
    const pageLabel = typeof ref.pageLabel === "string" ? ref.pageLabel : null;
    const around = typeof ref.occurredAt === "string" ? new Date(ref.occurredAt) : typeof ref.saidAt === "string" ? new Date(ref.saidAt) : decision.decidedAt;
    const candidates = pageLabel === null ? [] : await listSaleCandidates(app.db, {
      pageLabel, fan: typeof ref.fanRef === "string" ? ref.fanRef : null,
      from: new Date(around.getTime() - 10 * DAY_MS), to: new Date(around.getTime() + 2 * DAY_MS), around, limit: 12,
    });
    out.push({
      id: decision.id,
      ledgerDecisionId: decision.ledgerDecisionId,
      pageLabel,
      words: ledgerWords(ref, decision.note),
      saidBy: decision.saidBy,
      shares: decision.shares.map((share) => ({ userId: share.userId, name: names.get(share.userId) ?? `#${share.userId}`, percent: share.percent })),
      kind: decision.kind,
      candidates: candidates.map((one) => ({
        transactionId: one.transactionId, pageLabel: one.pageLabel, platform: one.platform, kind: one.kind,
        occurredAt: one.occurredAt.toISOString(), netMills: one.netMills, fan: { fanRef: one.fanRef, name: one.fanName, username: one.fanUsername },
      })),
    });
  }
  return { decisions: out, serverNow: now.toISOString() };
}

/** The words that name a sale not tied yet, in one line: the fan's reference, the amount, the day, why (the decision's note). */
export function ledgerWords(ref: Record<string, unknown>, note: string | null = null): string {
  const parts = [
    typeof ref.fanRef === "string" && ref.fanRef !== "" ? ref.fanRef : null,
    typeof ref.netMills === "number" ? money(ref.netMills) : null,
    typeof ref.occurredAt === "string" && !Number.isNaN(Date.parse(ref.occurredAt)) ? `${dayWords(moscowDay(Date.parse(ref.occurredAt)))}` : null,
    note !== null && note !== "" ? note.slice(0, 200) : null,
  ];
  return parts.filter((part): part is string => part !== null).join(", ");
}

export async function linkUnlinkedDecision(app: ClaimsApp, principal: HumanAuthPrincipal, input: { decisionId: number; transactionId: number }, now: Date = new Date()) {
  requireOwnerSession(principal);
  const sale = (await listHandinSalesByIds(app.db, [input.transactionId]))[0];
  if (sale === undefined) throw new NotFoundError("No such sale");
  const decision = (await listSaleDecisions(app.db, { ids: [input.decisionId] }))[0];
  if (decision === undefined || !decision.needsLink) throw new NotFoundError("No such decision waiting for a sale");
  const pageLabel = typeof decision.ledgerRef?.pageLabel === "string" ? decision.ledgerRef.pageLabel : null;
  if (pageLabel !== null && pageLabel !== sale.pageLabel) throw new BadRequestError("The sale is of another page", { reason: "page_mismatch" });
  // Tied to its sale, it rules the sale from now exactly as a decision made on it (and replaces the one that ruled it):
  // the sale's open claims are decided with it and the reports that hold the sale get what it gives. The ledger is
  // asked about paid days before any lock.
  const paid = await paidDaysOf(app, await listCurrentReportsOfSales(app.db, [sale.transactionId]));
  const made: MadeVersion[] = [];
  const linked = await app.db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    if (!(await linkSaleDecision(txDb, { id: input.decisionId, transactionId: sale.transactionId, pageId: sale.pageId, at: now }))) return false;
    made.push(...await followDecision(txDb, {
      transactionId: sale.transactionId, decisionId: decision.id, decision,
      madeFor: { kind: "decision", decisionId: decision.id, transactionId: sale.transactionId, outcome: "said" },
      by: { door: "workboard", actorUserId: principal.user.id, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null },
      at: now, paid, saleNet: sale.netMills,
    }));
    return true;
  });
  await afterPaid(app, made, now);
  if (linked) await refreshHomeOf(app, sale.occurredAt, now);
  await runSaleClaims(app, now).catch((error: unknown) => {
    app.logger.warn({ decisionId: input.decisionId, err: error instanceof Error ? error.message : String(error) }, "sale claims: the pass after a decision was tied to its sale failed; the next one will");
  });
  return { linked, savedAt: now.toISOString() };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Claims on the wire: the people's names, the decision. */
async function claimWires(db: Database, claims: readonly SaleClaimRow[]): Promise<SaleClaim[]> {
  const names = await listHandinNames(db, claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((id): id is number => id !== null)));
  const decisions = new Map((await listSaleDecisions(db, { ids: claims.flatMap((claim) => (claim.decisionId === null ? [] : [claim.decisionId])) })).map((one) => [one.id, one]));
  const pages = await listMatterPageLabels(db);
  return claims.map((claim) => {
    const decision = claim.decisionId === null ? null : decisions.get(claim.decisionId) ?? null;
    return {
      id: claim.id,
      kind: claim.kind,
      transactionId: claim.transactionId,
      pageLabel: claim.pageId === null ? (typeof claim.ledgerRef?.pageLabel === "string" ? claim.ledgerRef.pageLabel : null) : pages.labelOf.get(claim.pageId) ?? null,
      claimant: claim.claimantUserId === null ? null : { userId: claim.claimantUserId, name: names.get(claim.claimantUserId) ?? `#${claim.claimantUserId}` },
      statement: claim.statement,
      note: claim.claimantNote,
      claimedAt: claim.claimedAt.toISOString(),
      side: claim.sideUserId === null ? null : { userId: claim.sideUserId, name: names.get(claim.sideUserId) ?? `#${claim.sideUserId}` },
      sideShiftId: claim.sideShiftId,
      state: claim.state,
      answer: claim.answer,
      answerNote: claim.answerNote,
      answeredAt: claim.answeredAt?.toISOString() ?? null,
      escalatedWhy: claim.escalatedWhy,
      decision: decision === null ? null : { outcome: decision.outcome, note: decision.note, decidedAt: decision.decidedAt.toISOString() },
      answerBy: answerable(claim) ? new Date(claim.createdAt.getTime() + CLAIM_SILENCE_MS).toISOString() : null,
      question: claim.question,
    };
  });
}

/**
 * The claims of a shift report (`shiftReport.claims`): incoming — someone claims a sale of the person on this shift (by
 * the side's shift, or a line of the report); outgoing — the report's own; for another reader, those of the pages they
 * may open (the owner every one).
 */
export async function claimsOfReport(
  db: Database,
  input: { shiftId: number; handinId: number | null; userIds: readonly number[]; lineIds: readonly number[]; own: boolean; readerUserId: number; cutToPageIds: ReadonlySet<number> | null },
): Promise<ShiftReportClaim[]> {
  const ofSales = input.lineIds.length === 0 ? [] : await listSaleClaims(db, { transactionIds: input.lineIds });
  const ofSide = await listSaleClaims(db, { sideUserIds: input.userIds });
  const byId = new Map<number, SaleClaimRow>();
  for (const claim of [...ofSales, ...ofSide]) {
    if (claim.state === "withdrawn") continue;
    const incoming = claim.sideUserId !== null && input.userIds.includes(claim.sideUserId)
      && (claim.sideShiftId === input.shiftId || (claim.transactionId !== null && input.lineIds.includes(claim.transactionId)));
    const outgoing = input.handinId !== null && claim.claimantHandinId === input.handinId;
    if (!incoming && !outgoing) continue;
    if (input.cutToPageIds !== null && (claim.pageId === null || !input.cutToPageIds.has(claim.pageId))) continue;
    byId.set(claim.id, claim);
  }
  const claims = [...byId.values()].sort((a, b) => a.claimedAt.getTime() - b.claimedAt.getTime() || a.id - b.id);
  const wires = await claimWires(db, claims);
  const lines = new Set(input.lineIds);
  const missing = claims.filter((claim) => claim.transactionId !== null && !lines.has(claim.transactionId)).map((claim) => claim.transactionId!);
  const sales = new Map((await listHandinSalesByIds(db, missing)).map((sale) => [sale.transactionId, sale]));
  return claims.map((claim, at) => {
    const incoming = claim.sideUserId !== null && input.userIds.includes(claim.sideUserId);
    const sale = claim.transactionId === null ? undefined : sales.get(claim.transactionId);
    return {
      ...wires[at]!,
      direction: incoming ? "incoming" as const : claim.claimantHandinId === input.handinId ? "outgoing" as const : "other" as const,
      canAnswer: input.own && incoming && input.userIds.includes(input.readerUserId) && answerable(claim),
      sale: sale === undefined ? null : { kind: sale.kind, occurredAt: sale.occurredAt.toISOString(), netMills: sale.netMills, fan: sale.fan },
    };
  });
}

/** What a party said, in plain words, for the owner. */
function saysOf(claim: SaleClaimRow, userId: number, now: Date): string[] {
  const out: string[] = [];
  if (claim.claimantUserId === userId) {
    if (claim.kind === "double") out.push("посчитана в своём отчёте, без слова о ней");
    else if (claim.statement === "share") out.push(`«Делим пополам»${claim.claimantNote ? `: ${claim.claimantNote}` : ""}`);
    else if (claim.statement === "mine") out.push(`«Моё»${claim.claimantNote ? `: ${claim.claimantNote}` : ""}`);
  }
  if (claim.sideUserId === userId) {
    if (claim.answer === "agree") out.push(`«Согласен»${claim.answerNote ? `: ${claim.answerNote}` : ""}`);
    else if (claim.answer === "disagree") out.push(`«Не согласен»: ${claim.answerNote ?? ""}`);
    else if (claim.escalatedWhy === "silence") out.push(`нет ответа ${Math.floor((now.getTime() - claim.createdAt.getTime()) / HOUR_MS)} ч`);
    else if (claim.escalatedWhy === "no_side") out.push("сдаёт смену не в системе: спросить в системе нельзя");
    else if (claim.kind === "double") out.push("посчитана в своём отчёте раньше");
  }
  return out;
}

async function disputeOf(app: ClaimsApp, claims: readonly SaleClaimRow[], now: Date): Promise<SaleDisputeResponse> {
  const { db } = app;
  const transactionId = claims[0]?.transactionId ?? null;
  const sale = transactionId === null ? undefined : (await listHandinSalesByIds(db, [transactionId]))[0];
  const { first, second } = partiesOf(claims.filter((claim) => claim.state !== "withdrawn"));
  const reports = transactionId === null ? [] : await listCurrentReportsOfSales(db, [transactionId]);
  const ids = [first, second, ...(sale?.home?.shares.map((share) => share.userId) ?? [])].filter((id): id is number => id !== null);
  const names = await listHandinNames(db, ids);
  const decision = transactionId === null ? undefined : (await listActiveSaleDecisions(db, [transactionId])).get(transactionId);
  const decider = decision?.decidedByUserId == null ? null : (await listHandinNames(db, [decision.decidedByUserId])).get(decision.decidedByUserId) ?? null;
  const counted = (userId: number) => {
    const report = reports.find((one) => one.userId === userId);
    const line = report?.lines.find((one) => one.transactionId === transactionId);
    return { mills: line === undefined ? null : line.amountMills, claimed: line?.claimedMills ?? null, shiftId: report?.shiftId ?? null };
  };
  const party = (userId: number, role: "first" | "second") => ({
    userId, name: names.get(userId) ?? `#${userId}`, role,
    says: claims.flatMap((claim) => saysOf(claim, userId, now)),
    countedMills: counted(userId).mills,
    claimedMills: counted(userId).claimed,
    shiftId: counted(userId).shiftId ?? (role === "second" ? claims.find((claim) => claim.sideUserId === userId)?.sideShiftId ?? null : null),
  });
  const parties = [first === null ? null : party(first, "first"), second === null ? null : party(second, "second")].filter((one): one is NonNullable<typeof one> => one !== null);
  // The facts the claimant's draft read of the sale (F1's facts, not computed again): the claimant's shift first.
  let facts: ShiftReportLineFacts | null = null;
  if (transactionId !== null) {
    const shifts = [counted(first ?? -1).shiftId, claims[0]?.sideShiftId ?? null, counted(second ?? -1).shiftId].filter((id): id is number => id !== null);
    for (const shiftId of [...new Set(shifts)]) {
      facts = await saleLineFacts(app, shiftId, transactionId, now).catch(() => null);
      if (facts !== null) break;
    }
  }
  const net = sale?.netMills ?? 0;
  const outcomes: SaleDisputeResponse["outcomes"] = [];
  const nameOf = (id: number | null) => (id === null ? "" : names.get(id) ?? `#${id}`);
  if (transactionId !== null && first !== null) {
    const gives = (outcome: OwnerOutcome) => [first, second].filter((id): id is number => id !== null)
      .map((userId) => ({ userId, mills: shareAfter({ netMills: net, userId, outcome, first, second, statement: null }) }));
    outcomes.push({ outcome: "first", label: `${nameOf(first)}: целиком`, gives: gives("first") });
    if (second !== null) {
      outcomes.push({ outcome: "second", label: `${nameOf(second)}: целиком`, gives: gives("second") });
      outcomes.push({ outcome: "half", label: "Пополам", gives: gives("half") });
    }
  }
  if (transactionId !== null) outcomes.push({ outcome: "nobody", label: "Никому", gives: parties.map((one) => ({ userId: one.userId, mills: 0 })) });
  if (claims.every((claim) => claim.kind === "imported" || claim.kind === "question")) outcomes.push({ outcome: "dismiss", label: "Закрыть без решения", gives: [] });
  // Which handed-in reports a decision gives a new version: the window says so instead of promising it of every report.
  const held = reports.filter((report) => report.lines.some((line) => line.transactionId === transactionId));
  const heldNames = await listHandinNames(db, held.map((report) => report.userId));
  return {
    sale: sale === undefined ? null : {
      transactionId: sale.transactionId, pageLabel: sale.pageLabel, platform: sale.platform, kind: sale.kind, occurredAt: sale.occurredAt.toISOString(),
      netMills: sale.netMills, fan: sale.fan,
    },
    // A sale before the rule's first day has no stored home: the rule never moves it, a decision is kept for the record.
    home: sale !== undefined && sale.home === null && sale.occurredAt.getTime() < SALE_RULE.since
      ? { kind: "before_rule", reason: "sale_before_rule", words: SALE_HOME_REASON_TEXT.sale_before_rule, shares: [] }
      : sale?.home == null ? null : {
      kind: sale.home.home,
      reason: sale.home.reason,
      words: SALE_HOME_REASON_TEXT[sale.home.reason as SaleHomeReason] ?? sale.home.reason,
      shares: sale.home.shares.map((share) => ({ userId: share.userId, name: names.get(share.userId) ?? `#${share.userId}`, mills: share.mills })),
    },
    parties,
    claims: await claimWires(db, claims),
    facts,
    outcomes,
    decision: decision === undefined ? null : { outcome: decision.outcome, note: decision.note, decidedAt: decision.decidedAt.toISOString(), by: decider },
    reports: held.map((report) => ({ userId: report.userId, name: heldNames.get(report.userId) ?? `#${report.userId}`, shiftId: report.shiftId, reportDate: report.reportDate })),
    serverNow: now.toISOString(),
  };
}

/** `saleDispute`: the owner's dispute of a sale. */
export async function readSaleDispute(app: ClaimsApp, principal: HumanAuthPrincipal, transactionId: number, now: Date = new Date()): Promise<SaleDisputeResponse> {
  requireOwnerSession(principal);
  const claims = (await listSaleClaims(app.db, { transactionIds: [transactionId] })).filter((claim) => claim.state !== "withdrawn");
  if (claims.length === 0) throw new NotFoundError("No dispute of this sale");
  return disputeOf(app, claims.sort((a, b) => Number(b.state === "owner") - Number(a.state === "owner") || a.id - b.id), now);
}

/** `saleDisputeOfClaim`: a question carried over from the ledger that names no sale. */
export async function readSaleDisputeOfClaim(app: ClaimsApp, principal: HumanAuthPrincipal, claimId: number, now: Date = new Date()): Promise<SaleDisputeResponse> {
  requireOwnerSession(principal);
  const claim = await findSaleClaim(app.db, claimId);
  if (claim === null) throw new NotFoundError("No such claim");
  return claim.transactionId === null ? disputeOf(app, [claim], now) : readSaleDispute(app, principal, claim.transactionId, now);
}

// ── The agent's read ─────────────────────────────────────────────────────────

function decisionWords(decision: SaleDecisionRow, nameOf: (id: number) => string, pageLabel: string | null): string {
  const where = pageLabel === null ? "" : `${pageLabel}: `;
  const what = decision.kind === "nobody" ? "никому"
    : decision.kind === "pot" ? `в общак ${decision.pot ?? ""}`.trim()
      : decision.shares.map((share) => `${nameOf(share.userId)}${share.percent === 100 ? "" : ` ${share.percent}%`}`).join(" и ");
  const by = decision.source === "ledger" ? `из ledger${decision.saidBy ? `, сказал ${decision.saidBy}` : ""}` : "решение владельца";
  return `${where}продажа ${decision.transactionId ?? "не привязана"}: ${what} (${by}${decision.note ? `; ${decision.note.slice(0, 160)}` : ""})`;
}

/** `agentSaleClaims`: the decisions and claims of a person or a sale on the key's pages, each with a line of words. */
export async function readAgentSaleClaims(
  app: ClaimsApp,
  input: { pageIds: readonly number[]; person?: string | undefined; telegramUserId?: number | undefined; transactionId?: number | undefined; scope: "open" | "all" },
  now: Date = new Date(),
): Promise<AgentSaleClaimsResponse> {
  const { db } = app;
  const granted = new Set(input.pageIds);
  let userIds: number[] | null = null;
  if (input.person !== undefined || input.telegramUserId !== undefined) {
    const named = await findHandinPersonBy(db, { ...(input.person !== undefined ? { code: input.person } : {}), ...(input.telegramUserId !== undefined ? { telegramUserId: input.telegramUserId } : {}) });
    if (named === null) throw new NotFoundError("Not found");
    userIds = named.userIds;
  }
  const claims = (await listSaleClaims(db, {
    ...(input.transactionId !== undefined ? { transactionIds: [input.transactionId] } : {}),
    ...(userIds !== null ? { involvingUserIds: userIds } : {}),
    ...(input.scope === "open" ? { states: ["asked", "owner"] as const } : {}),
    limit: 500,
  })).filter((claim) => claim.pageId !== null && granted.has(claim.pageId));
  const decisions = (await listSaleDecisions(db, {
    ...(input.transactionId !== undefined ? { transactionIds: [input.transactionId] } : {}),
    ...(userIds !== null ? { userIds } : {}),
    activeOnly: input.scope === "open",
    limit: 500,
  })).filter((decision) => decision.pageId !== null && granted.has(decision.pageId));
  const codes = await listHandinPeopleOfUsers(db, decisions.flatMap((one) => one.shares.map((share) => share.userId)));
  const names = await listHandinNames(db, decisions.flatMap((one) => one.shares.map((share) => share.userId)));
  const pages = await listMatterPageLabels(db);
  const sales = new Map((await listHandinSalesByIds(db, claims.flatMap((claim) => (claim.transactionId === null ? [] : [claim.transactionId])))).map((sale) => [sale.transactionId, sale]));
  const wires = await claimWires(db, claims);
  const nameOf = (id: number) => names.get(id) ?? `#${id}`;
  return {
    decisions: decisions.map((decision) => {
      const pageLabel = decision.pageId === null ? null : pages.labelOf.get(decision.pageId) ?? null;
      return {
        id: decision.id, transactionId: decision.transactionId, pageLabel, kind: decision.kind,
        shares: decision.shares.map((share) => ({ person: codes.get(share.userId)?.code ?? null, name: nameOf(share.userId), percent: share.percent })),
        pot: decision.pot, outcome: decision.outcome, note: decision.note, saidBy: decision.saidBy, decidedAt: decision.decidedAt.toISOString(),
        active: decision.state === "active", needsLink: decision.needsLink, words: decisionWords(decision, nameOf, pageLabel),
      };
    }),
    claims: wires.map((wire, at) => {
      const sale = claims[at]!.transactionId === null ? undefined : sales.get(claims[at]!.transactionId!);
      const who = wire.claimant?.name ?? "кто-то";
      const what = wire.statement === "share" ? `делит с ${wire.side?.name ?? "коллегой"}` : wire.kind === "double" ? `и ${wire.side?.name ?? "коллега"} посчитали в отчётах` : `считает своей (против ${wire.side?.name ?? "правила"})`;
      const state = { asked: "ждёт ответа", agreed: "согласовано", owner: "у владельца", decided: "решено", withdrawn: "снято" }[wire.state];
      return {
        ...wire,
        netMills: sale?.netMills ?? null,
        occurredAt: sale?.occurredAt.toISOString() ?? null,
        words: `${wire.pageLabel ?? ""} ${sale ? money(sale.netMills) : ""}: ${who} ${what}; ${state}`.trim(),
      };
    }),
    serverNow: now.toISOString(),
  };
}

/** A person by login, for the import: the registry's code to a login. */
export async function personOfUser(db: Database, userId: number): Promise<HandinPerson | null> {
  return findHandinPersonOfUser(db, userId);
}
