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
import { personNameForms } from "@agency_hub_core/contracts";
import { formatUsdFromMills, moscowDayOfMs as moscowDay } from "@agency_hub_core/shared";
import {
  listHandinMarks,
  listOpenPotOffers,
  setHandinMark,
  cancelSaleDecision,
  closeMatter,
  decideOffPlatform,
  findHandinById,
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
  listHandinProposals,
  listHandinPeopleOfUsers,
  listHandinSalesByIds,
  listMatterPageLabels,
  listOpenMattersOfKinds,
  listPendingOffPlatform,
  listSaleCandidates,
  listSaleClaims,
  listSaleDecisions,
  listUnownedSales,
  lockSaleSettlements,
  openMatter,
  reopenSaleClaim,
  supersedeSaleDecision,
  updateSaleClaim,
  type CurrentReport,
  type Database,
  type HandinDoor,
  type HandinSaleRow,
  type HandinVersionLine,
  type HandinVersionMadeFor,
  type MatterActor,
  type MatterOwner,
  type SaleClaimRow,
  type SaleDecisionInsert,
  type SaleDecisionRow,
  type TeamFacts,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors.ts";
import { moscowWeekStart, refreshSaleHomes } from "./sale-homes.ts";
import { TAKE_NOTICE_MS, isTake, takeNoticeOpen, takeSettles } from "./shift-report-phases.ts";
import {
  claimStands,
  claimTitle,
  deriveClaims,
  disputeAnswersOf,
  disputeSidesOf,
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
import { POT_OBSHAK, SALE_RULE, SALE_HOME_REASON_TEXT, halvesOf, type SaleHomeReason } from "./sale-rule.ts";
import { realmOf, testUserIds } from "./sandbox/realm.ts";
import { deciderOf, modelOfPageId, personOfLogin, personsOfLogins, teamFactsFor, type Decider } from "./teams.ts";
import { dayWords } from "./shift-handin-rules.ts";
import { POT_OFFER_KIND } from "./shift-handin-check.ts";
import { SHIFT_REPORT_AFTER_PAID_KIND, draftLineOfSale, ledgerDayPaid, pageCatalog, saleLineFacts, type HandinActor } from "./shift-report-draft.ts";

/**
 * Заявки и договорённости (ecosystem plan 2026-11-12, package G): what people
 * say about a sale reaches the other side and, when they do not agree, the
 * owner. One service for every door.
 *
 * A take (owner, 2026-11-21): a person's «Моя» / «Пополам с …» on a sale the
 * rule gives a colleague who hands shifts in by the board counts AT ONCE — the
 * claim is settled for them as an agreement is (`silence_at`: by their word
 * alone), every handed-in report of the two that holds the sale gets its new
 * version, and the colleague is TOLD, not asked: a notice «Макс записывает себе:
 * PPV, фан, $52.00, 19 нояб.» (`sale.claim`) that opens their board at that
 * line, open a week. «Понятно» closes it; «Не согласен» (no deadline) takes
 * the sale to the decider and back to the rule's holder until the decision; the
 * taker's «Отменить» gives it back. One take per sale: a word on a sale someone
 * else already took, disputed or had decided is the decider's.
 *
 * The pass (`runSaleClaims`, after each shift-rows pass and after a hand-in):
 *  - reads the newest version of every report handed in in the last 14 days
 *    and the claims they make (sale-claim-rules.ts `deriveClaims`): a new one
 *    between two chatters is a take, settled at once like the board's; nobody
 *    to ask (or the other side not handing shifts in in Hub), the pot's, a sale
 *    counted for more than its net — the owner's at once;
 *  - a claim whose report no longer counts the sale is withdrawn (and made
 *    again, in the same row, when the report makes it again);
 *  - the owner's matters: ONE per disputed sale, one per report with «мимо
 *    площадки» waiting, one line a week of the sales nobody claimed on the
 *    days all of whose shifts are handed in, one of the decisions carried over
 *    from the ledger that wait to be tied to a sale; the side's notices.
 * The owner's answer — first, second, halves, nobody — is a decision the rule
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
const SYSTEM: MatterActor = { door: "system" };
const OPEN_STATES = ["asked", "agreed", "owner"] as const;

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
  /** Takes settled for the one who said it (at once, a colleague told). */
  settled: number;
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
  const tally: SaleClaimsTally = { claims: 0, opened: 0, withdrawn: 0, escalated: 0, settled: 0, matters: 0 };
  const since = moscowDay(now.getTime() - LOOKBACK_DAYS * DAY_MS);
  const recent = await listCurrentReportsSince(db, { since });
  const derived = deriveClaims(recent.map(viewOf));
  tally.claims = derived.length;

  // New claims: a take of a colleague's sale (written `asked`, settled at once below), or the owner's at once.
  const derivedSales = [...new Set(derived.map((one) => one.transactionId))];
  const known = new Map((await listSaleClaims(db, { transactionIds: derivedSales })).map((claim) => [claimKey(claim.claimantHandinId, claim.transactionId, claim.sideUserId), claim]));
  const sales = new Map((await listHandinSalesByIds(db, derivedSales)).map((sale) => [sale.transactionId, sale]));
  const people = await listHandinPeopleOfUsers(db, [...new Set(derived.flatMap((one) => (one.sideUserId === null ? [] : [one.sideUserId])))]);
  for (const claim of derived) {
    const existing = known.get(claimKey(claim.claimantHandinId, claim.transactionId, claim.sideUserId));
    if (existing !== undefined && existing.state !== "withdrawn") {
      if (existing.claimantVersion !== claim.claimantVersion && OPEN_STATES.includes(existing.state as typeof OPEN_STATES[number])) {
        await updateSaleClaim(db, existing.id, { claimantVersion: claim.claimantVersion, claimantNote: claim.note }, now, { ifState: existing.state });
      }
      continue;
    }
    const sale = sales.get(claim.transactionId);
    const side = claim.sideUserId === null ? null : people.get(claim.sideUserId) ?? null;
    // A take settles between two chatters only when the side hands shifts in by the board too: a person who posts the old
    // way is paid by a post Gengar writes from decisions, never agreements (arena round 3) — so anyone else, and nobody
    // to ask, is the decider's at once (`no_side`).
    // A sale of the pot is the owner's alone («по общаку решаю я»): never taken from a colleague.
    // The home as stored, else as the claimant's version has it (the hourly job may not have stored one yet): a pot's
    // sale, or one whose home nobody knows, is the decider's — never asked of a colleague.
    const home = sale?.home?.home ?? claim.home;
    const askable = claim.kind === "claim" && side !== null && side.submitsShiftSince !== null && side.state !== "left"
      && home !== null && home !== "pot" && home !== "unknown";
    const why = claim.kind === "double" ? "double" as const : askable ? null : "no_side" as const;
    const asked = { state: why === null ? "asked" as const : "owner" as const, escalatedAt: why === null ? null : now, escalatedWhy: why };
    const said = {
      pageId: sale?.pageId ?? null,
      kind: claim.kind,
      claimantVersion: claim.claimantVersion,
      statement: claim.statement,
      shareWithUserId: claim.shareWithUserId,
      claimantNote: claim.note,
      claimedAt: new Date(claim.claimedAt),
      sideShiftId: await sideShiftOf(db, claim, sale),
    };
    if (existing !== undefined) {
      // Withdrawn — its report had stopped counting the sale — and made again: there is one row per report, sale and
      // side, so the same row is the claim again, asked as a new one is (`reopenSaleClaim`). Not a word the side already
      // said «Не согласен» to: taken back and said again it is no new take but the same dispute, the decider's at once
      // with their answer kept — never «wrote it, disputed, wrote it again».
      const again = why === null && existing.answer === "disagree"
        ? { state: "owner" as const, escalatedAt: now, escalatedWhy: "disagree" as const, keepAnswer: true }
        : asked;
      if (await reopenSaleClaim(db, existing.id, { ...said, pageId: said.pageId ?? existing.pageId, ...again }, now)) tally.opened += 1;
      continue;
    }
    const inserted = await insertSaleClaim(db, {
      ...said,
      transactionId: claim.transactionId,
      claimantUserId: claim.claimantUserId,
      claimantHandinId: claim.claimantHandinId,
      sideUserId: claim.sideUserId,
      ...asked,
    }, now);
    if (inserted !== null) tally.opened += 1;
  }

  // The open claims: withdrawn when the report no longer counts the sale, a take settled at once. The pass is outside
  // the settlements' turn: each write goes through only while the claim is in the state read here, so an answer or a
  // decision committed since is never written over — and only what was really changed is counted.
  const open = await listSaleClaims(db, { states: [...OPEN_STATES], kinds: ["claim", "double"] });
  const openSales = [...new Set(open.flatMap((claim) => (claim.transactionId === null ? [] : [claim.transactionId])))];
  const holding = (await listCurrentReportsOfSales(db, openSales)).map(viewOf);
  // The pot's: as stored, or as any report holding the sale has it (no home stored yet).
  const potSales = new Set([
    ...(await listHandinSalesByIds(db, openSales)).filter((sale) => sale.home?.home === "pot").map((sale) => sale.transactionId),
    ...holding.flatMap((report) => report.lines.filter((line) => line.rule.home === "pot").map((line) => line.transactionId!)),
  ]);
  // The reports a question from the draft was asked in: their phase now (a report in «Правка» still says what its draft says).
  const askedIn = new Map<number, string>();
  for (const handinId of new Set(open.flatMap((claim) => (claim.origin === "draft" && claim.claimantHandinId !== null ? [claim.claimantHandinId] : [])))) {
    const handin = await findHandinById(db, handinId);
    if (handin !== null) askedIn.set(handinId, handin.phase);
  }
  for (const claim of open) {
    // A question asked from the draft (the board, 0412) stands while the person's draft says it: while their report is
    // edited, checked or waits for «Подтверждаю» (its draft and newest candidate say it), or its counted version carries
    // the word; until «Отменить» or a version that no longer says it. A question asked from «Правка» of a counted report
    // is judged by that, never by the version counted before it (review round 2, N4).
    // A sale given to a colleague without the board (no word on the version that claims it) stands until it is decided or
    // the word is taken back.
    const ownLine = holding.find((report) => report.handinId === claim.claimantHandinId)?.lines.find((line) => line.transactionId === claim.transactionId);
    const phase = claim.claimantHandinId === null ? undefined : askedIn.get(claim.claimantHandinId);
    const draftAsk = claim.origin === "draft" && (claim.statement === null || ownLine === undefined
      || phase === "fixing" || phase === "checking" || phase === "confirm" || ownLine.statement === claim.statement);
    if (!draftAsk && !claimStands(claim, holding)) {
      if (await updateSaleClaim(db, claim.id, { state: "withdrawn", closedAt: now }, now, { ifState: claim.state })) tally.withdrawn += 1;
      continue;
    }
    // Asked of a colleague, and the sale is the pot's (it became so after the question): the owner's now, as a claim with
    // nobody to ask is.
    if (claim.kind === "claim" && claim.state === "asked" && claim.transactionId !== null && potSales.has(claim.transactionId)) {
      if (await updateSaleClaim(db, claim.id, { state: "owner", escalatedAt: now, escalatedWhy: "no_side" }, now, { ifState: "asked" })) tally.escalated += 1;
      continue;
    }
    // A take settles at once for the one who said it (owner, 2026-11-21): the sale counts for them; the side is told and
    // may still dispute. A question with nobody to ask is the decider's and never settles so.
    if (takeSettles(claim)) {
      const outcome = await settleTake(app, claim, now);
      if (outcome === "settled") tally.settled += 1;
      else if (outcome === "decider") tally.escalated += 1;
    }
  }

  tally.matters = await syncClaimMatters(app, now);
  tally.matters += await syncOffPlatformMatters(app, now);
  tally.matters += await syncNobodyWeek(app, now);
  tally.matters += await syncUnlinkedDecisions(app, now);
  if (tally.opened + tally.withdrawn + tally.escalated + tally.settled > 0) app.logger.info(tally, "sale claims");
  return tally;
}

/** The cards of Gengar the claimants said «Не согласен» to on the sale: what the card wanted and why. */
async function declinedCardsOf(db: Database, claims: readonly SaleClaimRow[]): Promise<Array<{ proposalId: number; to: string; toUserId: number | null; why: string }>> {
  const out: Array<{ proposalId: number; to: string; toUserId: number | null; why: string }> = [];
  for (const handinId of new Set(claims.flatMap((claim) => (claim.claimantHandinId === null ? [] : [claim.claimantHandinId])))) {
    for (const card of await listHandinProposals(db, handinId)) {
      if (card.kind !== "owner_change" || card.state !== "declined" || !claims.some((claim) => claim.transactionId === card.transactionId)) continue;
      out.push({ proposalId: card.id, to: card.toWord ?? "", toUserId: card.toUserId, why: card.why });
    }
  }
  return out;
}

/** «/workboard/report/<id>?sale=<id>»: the side's board at the row. */
const sideLink = (claim: Pick<SaleClaimRow, "sideShiftId" | "transactionId">) =>
  (claim.sideShiftId === null ? null : `/workboard/report/${claim.sideShiftId}${claim.transactionId === null ? "" : `?sale=${claim.transactionId}`}`);

const disputeKey = (claim: Pick<SaleClaimRow, "transactionId" | "id">) => (claim.transactionId === null ? `${SALE_DISPUTE_KIND}:q${claim.id}` : `${SALE_DISPUTE_KIND}:${claim.transactionId}`);

/**
 * The side's notice of each take while it is open (`takeNoticeOpen`: unanswered, a week), the owner's ONE per sale
 * while any claim of it is his; everything else closes.
 */
async function syncClaimMatters(app: Pick<AppContext, "db" | "logger">, now: Date): Promise<number> {
  const { db } = app;
  const claims = [
    ...await listSaleClaims(db, { states: ["owner"] }),
    ...(await listSaleClaims(db, { states: ["agreed"], kinds: ["claim"], silenceSince: new Date(now.getTime() - TAKE_NOTICE_MS) })).filter((claim) => takeNoticeOpen(claim, now)),
  ];
  const sales = new Map((await listHandinSalesByIds(db, [...new Set(claims.flatMap((claim) => (claim.transactionId === null ? [] : [claim.transactionId])))]))
    .map((sale) => [sale.transactionId, sale]));
  const names = await listHandinNames(db, claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((id): id is number => id !== null)));
  const pages = await listMatterPageLabels(db);
  const teams = await teamFactsFor(app);
  let touched = 0;
  const wantSide = new Set<string>();
  const wantOwner = new Map<string, SaleClaimRow[]>();
  for (const claim of claims) {
    // The side is told of a take, never asked (a question the agent asked the chatters is theirs to settle in their
    // chat: no matter of the side).
    if (claim.state === "agreed" && claim.sideUserId !== null) {
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
          saidAt: claim.claimedAt.toISOString(), takenAt: claim.silenceAt?.toISOString() ?? null,
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
      // Who decides is `deciderOf` (services/teams.ts): the lead of the sale's model, the owner when the team has none,
      // when the lead is a side, and for the pot's and the ledger's questions. A lead's dispute carries no money of
      // people (the sale's amount is the team's, as on «Смены»); the owner's stays his alone as before.
      ...disputeOwnerOf(teams, list, label === null ? null : pages.idOf.get(label) ?? null, sale?.home?.home === "pot"),
      evidence: {
        transactionId: first.transactionId, claimIds: list.map((claim) => claim.id), netMills: sale?.netMills ?? null,
        why: [...new Set(list.map((claim) => claim.escalatedWhy))], saidAt: list.map((claim) => claim.claimedAt.toISOString()).sort()[0],
        // The people's own lines of why, and a card of Gengar one of them said «Не согласен» to.
        notes: list.flatMap((claim) => (claim.claimantNote === null ? [] : [claim.claimantNote])),
        cards: await declinedCardsOf(db, list),
      },
      link: first.transactionId === null ? `/workboard/waiting?claim=${first.id}#questions` : `/workboard/waiting?dispute=${first.transactionId}#questions`,
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
      link: `/workboard/waiting?offPlatform=${first.shiftId}#reports`,
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
      link: `/workboard/waiting?nobody=${week.from}#questions`,
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
    link: "/workboard/waiting?unlinked=1#questions",
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
    // Nothing to write only when it counts the same and says the same settled it: a decision over a take of the same
    // share is the decider's line now (a later cancel finds it by that).
    if (line.amountMills === input.to.amountMills && !line.disputed && (line.settled ?? null) === input.to.settled) return null;
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
    modelComments: current.modelComments,
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

/**
 * Every handed-in report whose line of the sale `holds` it goes back to what the shift's draft says of it now — an
 * agreement of the two sides, else the rule with the person's own word (what handing in again would write) — in the
 * caller's transaction, the settlements' turn taken: every report locked first, then every draft line read, then the
 * versions made, so each draft reads the other reports as they stand before any of them changes.
 */
async function reportsBackToDraft(
  txDb: Database,
  input: {
    transactionId: number; holds: (line: HandinVersionLine) => boolean; madeFor: HandinVersionMadeFor; by: SettleBy;
    paid: ReadonlyMap<number, boolean | null>; at: Date;
  },
): Promise<MadeVersion[]> {
  const { transactionId, at } = input;
  const settled = (await listCurrentReportsOfSales(txDb, [transactionId]))
    .filter((report) => report.lines.some((line) => line.transactionId === transactionId && input.holds(line)));
  for (const report of settled) await findHandinByShift(txDb, report.shiftId, { lock: true });
  const lines: Array<HandinVersionLine | null> = [];
  for (const report of settled) lines.push(await draftLineOfSale(txDb, report.shiftId, transactionId, at));
  const made: MadeVersion[] = [];
  for (const [index, report] of settled.entries()) {
    const one = await settleReport(txDb, {
      shiftId: report.shiftId, transactionId, to: { line: lines[index] ?? null }, madeFor: input.madeFor, by: input.by, at,
      dayPaid: input.paid.get(report.shiftId) ?? null,
    });
    if (one !== null) made.push(one);
  }
  return made;
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
      link: `/workboard/report/${one.shiftId}`,
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

/**
 * A take still asked on one report (made by it, or of its person — one written before takes settled at once, or one
 * the pass has not met yet): settled the moment a board is read, not at the next pass. The pass stays the backstop.
 */
export async function settleAskedTakes(app: Pick<AppContext, "db" | "logger">, input: { handinId: number; userIds: readonly number[] }, now: Date): Promise<number> {
  let settled = 0;
  for (const claim of await listSaleClaims(app.db, { states: ["asked"] })) {
    const ours = claim.claimantHandinId === input.handinId || (claim.sideUserId !== null && input.userIds.includes(claim.sideUserId));
    if (!ours || !takeSettles(claim)) continue;
    if ((await settleTake(app, claim, now)) === "settled") settled += 1;
  }
  return settled;
}

/**
 * Whether a report of someone outside the claim (neither its claimant nor its side) counts the sale: a 50/50 of two
 * holders taken by a third, say. Settling the claim would give the claimant all while that report keeps its share.
 */
async function othersCount(db: Database, claim: Pick<SaleClaimRow, "transactionId" | "claimantUserId">, sideIds: readonly number[]): Promise<boolean> {
  if (claim.transactionId === null) return false;
  return (await listCurrentReportsOfSales(db, [claim.transactionId])).some((report) => report.userId !== claim.claimantUserId
    && !sideIds.includes(report.userId) && report.lines.some((line) => line.transactionId === claim.transactionId && line.amountMills > 0));
}

/**
 * Whether a sale is the pot's: as any report holding it has it, or as stored — and when nothing is stored yet, its day
 * is computed now (the hourly job's own computation) rather than taken for anyone's.
 */
async function isPotSale(db: Database, transactionId: number, now: Date): Promise<boolean> {
  const lines = (await listCurrentReportsOfSales(db, [transactionId])).flatMap((report) => report.lines).filter((line) => line.transactionId === transactionId);
  if (lines.some((line) => line.rule.home === "pot")) return true;
  let sale = (await listHandinSalesByIds(db, [transactionId]))[0];
  if (sale !== undefined && sale.home === null) {
    await refreshHomeWithin(db, sale.occurredAt, now).catch(() => undefined);
    sale = (await listHandinSalesByIds(db, [transactionId]))[0];
  }
  return sale?.home?.home === "pot";
}

/**
 * One settlement per sale: when a claim on a sale settles (an agreement, a take), every other question still asked on
 * that sale — another person who took it too — goes to the decider. Each alone would give its claimant the whole sale.
 * In the caller's transaction, in the settlements' turn.
 */
async function othersToDecider(db: Database, settled: Pick<SaleClaimRow, "id" | "transactionId">, now: Date): Promise<void> {
  if (settled.transactionId === null) return;
  for (const other of await listSaleClaims(db, { transactionIds: [settled.transactionId], states: ["asked"] })) {
    if (other.id === settled.id || other.kind !== "claim") continue;
    await updateSaleClaim(db, other.id, { state: "owner", escalatedAt: now, escalatedWhy: "double" }, now, { ifState: "asked" });
  }
}

/**
 * The same word of the same person against another login of the same colleague: a report makes one claim per login
 * (`deriveClaims`: the login the rule names, the login whose report counts the sale), and they are ONE take — settled,
 * answered and disputed together, each login told by its own notice; never «another person took it too».
 */
async function sameTakeOf(
  db: Database,
  claim: Pick<SaleClaimRow, "id" | "transactionId" | "claimantUserId" | "sideUserId">,
  states: readonly SaleClaimRow["state"][],
): Promise<SaleClaimRow[]> {
  if (claim.transactionId === null || claim.claimantUserId === null || claim.sideUserId === null) return [];
  const claimantIds = (await findHandinPersonOfUser(db, claim.claimantUserId))?.userIds ?? [claim.claimantUserId];
  const sideIds = (await findHandinPersonOfUser(db, claim.sideUserId))?.userIds ?? [claim.sideUserId];
  return (await listSaleClaims(db, { transactionIds: [claim.transactionId], states, kinds: ["claim"] }))
    .filter((one) => one.id !== claim.id && one.claimantUserId !== null && claimantIds.includes(one.claimantUserId)
      && one.sideUserId !== null && sideIds.includes(one.sideUserId));
}

/**
 * An agreement (an answer «Согласен», a take) written into the reports, in the caller's transaction (the settlements'
 * turn taken): every handed-in report of the claimant or of the side that holds the sale gets what the agreement gives
 * its person — the claimant all (or a half), the side none (or the other half). `netIfNone` — the net when no report
 * line names it; `outcome` — why the versions were made (`taken`: by the claimant's word alone).
 */
async function settleAgreedReports(
  txDb: Database,
  input: {
    claim: Pick<SaleClaimRow, "id" | "sideUserId" | "statement" | "claimantHandinId"> & { transactionId: number; claimantUserId: number };
    sideIds: readonly number[]; netIfNone: number; by: SettleBy; paid: ReadonlyMap<number, boolean | null>; at: Date;
    outcome?: "agreed" | "taken";
  },
): Promise<MadeVersion[]> {
  const { claim, sideIds } = input;
  const made: MadeVersion[] = [];
  const reports = await listCurrentReportsOfSales(txDb, [claim.transactionId]);
  const net = reports.flatMap((report) => report.lines).find((line) => line.transactionId === claim.transactionId)?.netMills ?? input.netIfNone;
  // A line another report of the person already holds counts there, nothing here (as a decision reads it).
  const holding = reports.filter((report) => report.lines.some((line) => line.transactionId === claim.transactionId && line.alreadyIn == null));
  // The claimant's share is written once: into the report the word was said in, else the first of theirs holding the
  // sale — two reports of one person never both count it.
  const claimants = holding.filter((report) => report.userId === claim.claimantUserId);
  const counts = claimants.find((report) => report.handinId === claim.claimantHandinId) ?? claimants[0];
  for (const report of holding) {
    const mine = report.userId === claim.claimantUserId;
    const theirs = sideIds.includes(report.userId);
    if (!mine && !theirs) continue;
    if (mine && report !== counts) continue;
    const amount = shareAfter({
      netMills: net, userId: mine ? claim.claimantUserId : claim.sideUserId!, outcome: "agreed",
      first: claim.claimantUserId, second: claim.sideUserId, statement: claim.statement,
    });
    const one = await settleReport(txDb, {
      shiftId: report.shiftId, transactionId: claim.transactionId, to: { amountMills: amount, settled: "agreed" },
      madeFor: { kind: "claim", claimId: claim.id, transactionId: claim.transactionId, outcome: input.outcome ?? "agreed" }, by: input.by, at: input.at,
      dayPaid: input.paid.get(report.shiftId) ?? null,
    });
    if (one !== null) made.push(one);
  }
  return made;
}

/** The ledger's word on the day of every report that holds a sale, asked before the settlements' turn (never under it). */
export async function paidDaysOfSale(app: ClaimsApp, transactionId: number): Promise<ReadonlyMap<number, boolean | null>> {
  return paidDaysOf(app, await listCurrentReportsOfSales(app.db, [transactionId]));
}

/** Who a person's own press on the board is, for the versions it makes. */
export const personSettleBy = (actor: { door: HandinDoor; userId: number }): SettleBy =>
  ({ door: actor.door, actorUserId: actor.userId, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null });

export type { MadeVersion, SettleBy };

/**
 * A take settled at once (owner, 2026-11-21), in the caller's transaction, the settlements' turn taken: a claim asked of
 * a colleague is settled for the one who said it as an agreement is (`agreed`, `silence_at`: by their word alone, the
 * side told and free to object), and every handed-in report of the two that holds the sale gets what it gives — the
 * claimant all (or a half), the side none (or the other half). Not when (`decider`):
 *  - the colleague's report of a day the ledger already paid counts the sale (`paid`): the owner's, nothing moves;
 *  - the sale is settled or disputed already by someone else's word (an agreement or a take of another person, a
 *    claim waiting for the decider) or ruled by a decision — one take per sale, no ping-pong: the word is the
 *    decider's, the sale stays as it is; and when the one saying it is the side of an unanswered take of it, it is
 *    their «Не согласен» to that take as well (`disputeTakeWithin`);
 *  - a third person's report counts the sale (a half of two holders taken by a third).
 * Null — the claim is not asked any more (answered, moved, withdrawn). `paid` — the ledger's word on the reports' days.
 */
export async function settleTakeWithin(
  txDb: Database,
  input: { claimId: number; by: SettleBy; paid: ReadonlyMap<number, boolean | null>; now: Date },
): Promise<{ outcome: "settled" | "decider"; made: MadeVersion[] } | null> {
  const { now } = input;
  const claim = await findSaleClaim(txDb, input.claimId, { lock: true });
  if (claim === null || !takeSettles(claim) || claim.answer !== null || claim.transactionId === null || claim.claimantUserId === null || claim.sideUserId === null) return null;
  const transactionId = claim.transactionId;
  const claimantIds = (await findHandinPersonOfUser(txDb, claim.claimantUserId))?.userIds ?? [claim.claimantUserId];
  const sideIds = (await findHandinPersonOfUser(txDb, claim.sideUserId))?.userIds ?? [claim.sideUserId];
  // The same word against the colleague's other login goes wherever this one goes (`sameTakeOf`).
  const same = [claim, ...await sameTakeOf(txDb, claim, ["asked"])];
  const toDecider = async (why: "double" | "paid" = "double") => {
    for (const one of same) await updateSaleClaim(txDb, one.id, { state: "owner", escalatedAt: now, escalatedWhy: why }, now, { ifState: "asked" });
  };
  // Settled or disputed already, or decided: one take per sale. Only the very same take is none of that — the same
  // word of the person, settled against the colleague's other login or said in another report of theirs. Their own
  // word the colleague said «Не согласен» to, or another word of theirs on the sale (a half agreed, now «моя»), said
  // from another shift or login, is the decider's like anyone's: never written over an open dispute.
  const sameTake = (one: SaleClaimRow) => one.state === "agreed" && one.statement === claim.statement
    && one.claimantUserId !== null && claimantIds.includes(one.claimantUserId) && one.sideUserId !== null && sideIds.includes(one.sideUserId);
  const before = (await listSaleClaims(txDb, { transactionIds: [transactionId], states: ["agreed", "owner"] }))
    .filter((one) => one.id !== claim.id && !sameTake(one));
  if (before.length > 0 || (await listActiveSaleDecisions(txDb, [transactionId])).has(transactionId)) {
    await toDecider();
    const made: MadeVersion[] = [];
    for (const take of before) {
      if (take.answer !== null || take.sideUserId === null || !claimantIds.includes(take.sideUserId) || !isTake(take)) continue;
      made.push(...await disputeTakeWithin(txDb, take, {
        note: claim.claimantNote, answeredByUserId: input.by.actorUserId, door: input.by.door, by: input.by, paid: input.paid, now,
      }));
    }
    return { outcome: "decider", made };
  }
  // Someone else counts the sale too: the two alone cannot settle it — the decider.
  if (await othersCount(txDb, claim, sideIds)) {
    await toDecider();
    await othersToDecider(txDb, claim, now);
    return { outcome: "decider", made: [] };
  }
  // The colleague's report of a day the ledger already paid counts the sale: that money is out, so nothing moves by a
  // word alone — the owner decides (owner, 2026-11-21). A day the ledger did not answer about is not known to be paid.
  if (await sidePaidFor(txDb, transactionId, sideIds, input.paid)) {
    await toDecider("paid");
    await othersToDecider(txDb, claim, now);
    return { outcome: "decider", made: [] };
  }
  for (const one of same) await updateSaleClaim(txDb, one.id, { state: "agreed", closedAt: now, silenceAt: now }, now, { ifState: "asked" });
  await othersToDecider(txDb, claim, now);
  const made = await settleAgreedReports(txDb, {
    claim: { ...claim, transactionId, claimantUserId: claim.claimantUserId }, sideIds, netIfNone: 0, by: input.by, paid: input.paid, at: now, outcome: "taken",
  });
  return { outcome: "settled", made };
}

/** Whether a handed-in report of the side counts the sale on a day the ledger said is paid (`paid`, by shift). */
async function sidePaidFor(db: Database, transactionId: number, sideIds: readonly number[], paid: ReadonlyMap<number, boolean | null>): Promise<boolean> {
  return (await listCurrentReportsOfSales(db, [transactionId])).some((report) => sideIds.includes(report.userId) && paid.get(report.shiftId) === true
    && report.lines.some((line) => line.transactionId === transactionId && line.alreadyIn == null && line.amountMills > 0));
}

/**
 * «Не согласен» to a take that stands, in the caller's transaction (the settlements' turn taken): the claim is the
 * decider's (`owner`, `disagree`, the side's line of why), the sale's home is computed again without the taker's word,
 * and every handed-in report the take settled goes back to what its draft says now — the side's to what the rule gives
 * them, the taker's to their word waiting for the decider (counting nothing, claiming what it claims). Today's dispute,
 * reached from a settled take (before 2026-11-21 a dispute after a day of silence left the reports as the silence made
 * them).
 */
async function disputeTakeWithin(
  txDb: Database,
  take: SaleClaimRow,
  input: { note: string | null; answeredByUserId: number | null; door: HandinDoor; by: SettleBy; paid: ReadonlyMap<number, boolean | null>; now: Date },
): Promise<MadeVersion[]> {
  const { now } = input;
  const disputed = {
    answer: "disagree" as const, answerNote: input.note, answeredAt: now, answerDoor: input.door, answerRef: null, answeredByUserId: input.answeredByUserId,
    answeredByAgentKeyId: null, state: "owner" as const, escalatedAt: now, escalatedWhy: "disagree" as const,
  };
  const written = await updateSaleClaim(txDb, take.id, disputed, now, { ifState: "agreed" });
  // The same take against their other login is disputed with it (`sameTakeOf`).
  if (written) for (const one of await sameTakeOf(txDb, take, ["agreed"])) if (isTake(one) && one.answer === null) await updateSaleClaim(txDb, one.id, disputed, now, { ifState: "agreed" });
  return written ? takeToRuleWithin(txDb, take, { outcome: "disputed", holds: (line) => line.settled === "agreed", by: input.by, paid: input.paid, now }) : [];
}

/**
 * The taker's word back on their report's line, in the caller's transaction. While a take stood the rule's home was
 * theirs: «моя» was no word of their own sale's line (the draft sets it aside), and an edit of the comment or «Отмена»
 * of «Правка» may have cleared it. Disputed, the sale is «рядом» for them again and that word is what waits for the
 * decider: without it their line would say nothing, count nothing, and the pass would take the claim for withdrawn.
 */
async function takersWordBack(txDb: Database, claimId: number, now: Date): Promise<void> {
  const take = await findSaleClaim(txDb, claimId);
  if (take === null || take.claimantHandinId === null || take.transactionId === null || take.statement === null) return;
  const shareWith = take.statement === "share" ? take.shareWithUserId : null;
  const mark = (await listHandinMarks(txDb, take.claimantHandinId)).find((one) => one.transactionId === take.transactionId);
  if (mark !== undefined && mark.statement === take.statement && (mark.shareWithUserId ?? null) === shareWith) return;
  await setHandinMark(txDb, {
    handinId: take.claimantHandinId, transactionId: take.transactionId, statement: take.statement, shareWithUserId: shareWith,
    note: mark?.note ?? take.claimantNote, byUserId: take.claimantUserId, byAgentKeyId: null, at: now,
  });
}

/**
 * A take undone — disputed by the side, or taken back by the one who said it — in the caller's transaction (the
 * settlements' turn taken, the claim already written): the sale's home computed again, then every handed-in report whose
 * line of the sale `holds` goes back to what its draft says now (`reportsBackToDraft`, the path «по правилу» takes).
 */
async function takeToRuleWithin(
  txDb: Database,
  take: Pick<SaleClaimRow, "id" | "transactionId">,
  input: { outcome: "disputed" | "withdrawn"; holds: (line: HandinVersionLine) => boolean; by: SettleBy; paid: ReadonlyMap<number, boolean | null>; now: Date },
): Promise<MadeVersion[]> {
  if (take.transactionId === null) return [];
  const transactionId = take.transactionId;
  if (input.outcome === "disputed") await takersWordBack(txDb, take.id, input.now);
  // No handed-in report to follow (both still drafts): the home is computed again after the commit (`afterTakeSettled`).
  const held = (await listCurrentReportsOfSales(txDb, [transactionId]))
    .some((report) => report.lines.some((line) => line.transactionId === transactionId && input.holds(line)));
  if (!held) return [];
  await refreshHomeWithin(txDb, (await listHandinSalesByIds(txDb, [transactionId]))[0]?.occurredAt ?? null, input.now);
  return reportsBackToDraft(txDb, {
    transactionId, holds: input.holds, madeFor: { kind: "claim", claimId: take.id, transactionId, outcome: input.outcome }, by: input.by, paid: input.paid, at: input.now,
  });
}

/**
 * «Отменить» of a word on a sale, in the caller's transaction (the settlements' turn taken, the claims withdrawn and the
 * person's word cleared before): every handed-in report whose line of the sale a take settled, or that holds a word
 * waiting, holds what its draft says now — the rule's share with the person's own words: a take's settlement undone, a
 * word waiting in a counted version gone (else the pass would make the claim again from it). `claimId` — the claim the
 * versions are made for.
 */
export async function wordTakenBackWithin(
  txDb: Database,
  input: { claimId: number; transactionId: number; by: SettleBy; paid: ReadonlyMap<number, boolean | null>; now: Date },
): Promise<MadeVersion[]> {
  return takeToRuleWithin(txDb, { id: input.claimId, transactionId: input.transactionId }, {
    outcome: "withdrawn", holds: (line) => line.settled === "agreed" || line.disputed, by: input.by, paid: input.paid, now: input.now,
  });
}

/** After a settlement's commit: the owner's matter of a paid day changed, and the sale's home computed again. */
export async function afterTakeSettled(app: ClaimsApp, made: readonly MadeVersion[], transactionId: number, now: Date): Promise<void> {
  await afterPaid(app, made, now);
  await refreshHomeOf(app, (await listHandinSalesByIds(app.db, [transactionId]))[0]?.occurredAt ?? null, now);
}

/**
 * A take the pass meets (one from a handed-in version, or one asked before takes settled at once): settled for the one
 * who said it in its own turn, the paid days read first. A sale of the pot is never settled between two chatters: the
 * owner's. The outcome; null — answered or moved meanwhile.
 */
async function settleTake(app: Pick<AppContext, "db" | "logger">, claim: SaleClaimRow, now: Date): Promise<"settled" | "decider" | null> {
  const { db } = app;
  if (claim.transactionId === null || claim.claimantUserId === null || claim.sideUserId === null) return null;
  if (await isPotSale(db, claim.transactionId, now)) {
    const moved = await updateSaleClaim(db, claim.id, { state: "owner", escalatedAt: now, escalatedWhy: "no_side" }, now, { ifState: "asked" });
    return moved ? "decider" : null;
  }
  const paid = await paidDaysOfSale(app as ClaimsApp, claim.transactionId).catch(() => new Map<number, boolean | null>());
  const by: SettleBy = { door: "workboard", actorUserId: claim.claimantUserId, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null };
  const done = await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    return settleTakeWithin(txDb, { claimId: claim.id, by, paid, now });
  });
  if (done !== null) await afterTakeSettled(app as ClaimsApp, done.made, claim.transactionId, now);
  return done?.outcome ?? null;
}

// ── The other side's answer ──────────────────────────────────────────────────

/**
 * Whether the side may answer now: asked; gone to the owner by silence (before the board) and not decided; or settled
 * for the one who said it without the side's answer (a take; before, a day's silence) — the side may still dispute,
 * with no deadline, or say «Понятно».
 */
const answerable = (claim: SaleClaimRow) => claim.kind === "claim" && claim.answer === null
  && (claim.state === "asked" || (claim.state === "owner" && claim.escalatedWhy === "silence") || (claim.state === "agreed" && claim.silenceAt !== null));

/**
 * `saleClaimAnswer`, `agentSaleClaimAnswer`: «Согласен» («Понятно» on a take: it stands as written, nothing moves)
 * settles it; «Не согласен» takes it to the decider — on a take, the reports it settled go back as well
 * (`disputeTakeWithin`'s path).
 */
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
  // «Не согласен» is one press on the board: a line of why may come with it, never required. «Со слов» the person's
  // words are the answer: an agent's «Не согласен» carries them.
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  if (actor.kind === "agent" && input.answer === "disagree" && note === null) throw new BadRequestError("«Не согласен» со слов needs the person's line of why", { reason: "note_required" });
  if (!answerable(found)) throw new ConflictError("This claim is already answered or decided", { reason: "claim_closed" });
  // «Согласен» never settles a sale of the pot between two chatters (its home stored or not): the owner decides it.
  if (input.answer === "agree" && found.transactionId !== null && (await isPotSale(db, found.transactionId, now))) {
    await updateSaleClaim(db, found.id, { state: "owner", escalatedAt: now, escalatedWhy: "no_side" }, now, { ifState: found.state });
    await runSaleClaims(app, now).catch(() => undefined);
    throw new ConflictError("A sale of the pot is the owner's to decide", { reason: "pot_sale" });
  }

  const door: HandinDoor = actor.kind === "agent" ? "telegram" : actor.door;
  const by: SettleBy = actor.kind === "person"
    ? { door, actorUserId: actor.userId, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null }
    : { door, actorUserId: null, agentKeyId: actor.agentKeyId, telegramMessageRef: actor.sourceRef, telegramSenderId: actor.telegramUserId };
  const made: MadeVersion[] = [];
  const sale = found.transactionId === null ? undefined : (await listHandinSalesByIds(db, [found.transactionId]))[0];
  // The ledger is asked before the turn whenever the answer may make versions: an agreement, or a take disputed.
  const paid = (input.answer !== "agree" && found.state !== "agreed") || found.transactionId === null ? new Map<number, boolean | null>()
    : await paidDaysOf(app, await listCurrentReportsOfSales(db, [found.transactionId]));
  await db.transaction(async (tx) => {
    const txDb = tx as unknown as Database;
    await lockSaleSettlements(txDb);
    const claim = await findSaleClaim(txDb, input.claimId, { lock: true });
    if (claim === null || !answerable(claim)) throw new ConflictError("This claim is already answered or decided", { reason: "claim_closed" });
    // Someone else counts the sale too (a holder of the other half): the two sides alone cannot settle it — the decider.
    const thirdHolds = input.answer === "agree" && (await othersCount(txDb, claim, sideIds));
    const answered = {
      answer: input.answer, answerNote: note, answeredAt: now, answerDoor: door, answerRef: actor.kind === "agent" ? actor.sourceRef : null,
      answeredByUserId: actor.kind === "person" ? actor.userId : null, answeredByAgentKeyId: actor.kind === "agent" ? actor.agentKeyId : null,
      ...(input.answer === "agree" && !thirdHolds ? { state: "agreed" as const, closedAt: now }
        : { state: "owner" as const, escalatedAt: now, escalatedWhy: thirdHolds ? "double" as const : "disagree" as const }),
    };
    await updateSaleClaim(txDb, claim.id, answered, now);
    // The answer to a take is the answer to the same take against the person's other login (`sameTakeOf`): its notice
    // closes with this one, and a dispute leaves no half of the take standing.
    if (claim.state === "agreed") {
      for (const one of await sameTakeOf(txDb, claim, ["agreed"])) if (isTake(one) && one.answer === null) await updateSaleClaim(txDb, one.id, answered, now, { ifState: "agreed" });
    }
    if (thirdHolds) await othersToDecider(txDb, claim, now);
    // «Не согласен» to a take already counted (or settled by a day of silence), or a third holder met at «Понятно»: the
    // sale is back with the one the rule gives it to until the decision, the taker's line waits — every report the
    // settlement made follows by a version.
    if (claim.state === "agreed" && (input.answer !== "agree" || thirdHolds)) {
      made.push(...await takeToRuleWithin(txDb, claim, { outcome: "disputed", holds: (line) => line.settled === "agreed", by, paid, now }));
      return;
    }
    if (input.answer !== "agree" || thirdHolds || claim.transactionId === null || claim.claimantUserId === null) return;
    await othersToDecider(txDb, claim, now);
    // Agreed: every report that counts the sale gets what the agreement gives — the claimant all (or a half), the side none (or the other half).
    made.push(...await settleAgreedReports(txDb, {
      claim: { ...claim, transactionId: claim.transactionId, claimantUserId: claim.claimantUserId }, sideIds, netIfNone: sale?.netMills ?? 0, by, paid, at: now,
    }));
  });
  await afterPaid(app, made, now);
  if (input.answer === "agree" || found.state === "agreed") await refreshHomeOf(app, sale?.occurredAt ?? null, now);
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

/**
 * Who decides a dispute (products package T): `deciderOf` over the dispute's model and sides. Two chatters' «чья
 * продажа» — the lead of the model's team (not a side); a sale with no colleague to ask (the pot's, nobody's) and a
 * question carried over from the ledger — the owner.
 */
export function disputeDeciderOf(facts: TeamFacts, claims: readonly SaleClaimRow[], pageId: number | null, potSale = false): Decider {
  // A sale of the pot is the owner's whoever claims it («по общаку решаю я»); so is a take on a day already paid — the
  // money is out, and only the owner pays.
  const kind = potSale || claims.some((claim) => claim.sideUserId === null || claim.kind === "imported" || claim.kind === "question" || claim.escalatedWhy === "paid")
    ? "pot" : "dispute";
  const sides = personsOfLogins(facts, claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId]));
  return deciderOf(facts, modelOfPageId(facts, pageId ?? claims.find((claim) => claim.pageId !== null)?.pageId ?? null), kind, sides);
}

function disputeOwnerOf(facts: TeamFacts, claims: readonly SaleClaimRow[], pageId: number | null, potSale = false): { owner: MatterOwner; money: boolean } {
  const decider = disputeDeciderOf(facts, claims, pageId, potSale);
  return decider.kind === "team_lead" ? { owner: { userId: decider.userId }, money: false } : { owner: { role: "owner" }, money: true };
}

/** The owner, or the lead who decides this dispute by `disputeDeciderOf`; anyone else is refused. */
async function requireDisputeDecider(app: ClaimsApp, principal: HumanAuthPrincipal, claims: readonly SaleClaimRow[]) {
  if (principal.user.role === "owner" && principal.narrowDeviceTokenId === undefined) return;
  if (principal.narrowDeviceTokenId !== undefined) throw new ForbiddenError("Only the owner decides");
  const facts = await teamFactsFor(app);
  const transactionId = claims.find((claim) => claim.transactionId !== null)?.transactionId ?? null;
  const potSale = transactionId !== null && (await listHandinSalesByIds(app.db, [transactionId]))[0]?.home?.home === "pot";
  const decider = disputeDeciderOf(facts, claims, null, potSale);
  const me = personOfLogin(facts, principal.user.id);
  if (decider.kind !== "team_lead" || me === null || decider.personId !== me) throw new ForbiddenError("Only the owner decides");
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
  input: {
    transactionId?: number | undefined; claimId?: number | undefined; outcome: OwnerOutcome | "dismiss" | "pot" | "return" | "give" | "split" | "rule"; note: string | null;
    shares?: ReadonlyArray<{ userId: number; percent: number }> | undefined; seenSides?: readonly number[] | undefined;
  },
  now: Date = new Date(),
) {
  const { db } = app;
  const claims = input.transactionId !== undefined
    ? await listSaleClaims(db, { transactionIds: [input.transactionId] })
    : await listSaleClaims(db, { ids: [input.claimId!] });
  const open = claims.filter((claim) => claim.state === "owner" || claim.state === "asked" || claim.state === "agreed");
  // A sale its holder gave to the pot: the owner's three answers (the pot is always his: `deciderOf` kind pot).
  const offer = open.length === 0 && input.transactionId !== undefined ? await potOfferOf(db, input.transactionId) : null;
  if (offer !== null) {
    if (principal.user.role !== "owner" || principal.narrowDeviceTokenId !== undefined) throw new ForbiddenError("Only the owner decides");
    if (input.outcome !== "pot" && input.outcome !== "return" && input.outcome !== "nobody") throw new BadRequestError("A sale given to the pot takes «В общак», «Вернуть» or «Никому»", { reason: "pot_offer" });
    return decidePotOffer(app, principal, { offer, outcome: input.outcome, note: input.note }, now);
  }
  if (input.outcome === "return") throw new BadRequestError("Only a sale given to the pot takes this answer", { reason: "not_pot_offer" });
  if (principal.user.role !== "owner" && open.length === 0) throw new ForbiddenError("Only the owner decides");
  await requireDisputeDecider(app, principal, open);
  if (open.length === 0) throw new NotFoundError("No dispute of this sale waits for a decision");
  const transactionId = input.transactionId ?? open[0]!.transactionId;
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  if (input.outcome === "dismiss") {
    if (open.some((claim) => claim.kind !== "imported" && claim.kind !== "question")) throw new BadRequestError("Only a question closes without a decision", { reason: "not_imported" });
    for (const claim of open) await updateSaleClaim(db, claim.id, { state: "decided", closedAt: now }, now);
    await runSaleClaims(app, now).catch(() => undefined);
    return { decided: false, versions: [], savedAt: now.toISOString() };
  }
  if (transactionId === null) throw new BadRequestError("Tie the question to its sale first", { reason: "needs_link" });
  // The sides now, as the window computes them (`disputeSidesNow`): a button names a person among them, and a window
  // read before the sides changed is refused — the decider reads it again.
  // The same claims the window computes its sides from (every one but a withdrawn one: a decided question too), so the
  // sides it showed are compared with like (review round 3, 2); only the open ones are written below.
  const now_ = await disputeSidesNow(app, claims.filter((claim) => claim.state !== "withdrawn"), now);
  const sides = now_.sides;
  if (input.seenSides !== undefined && (input.seenSides.length !== sides.length || input.seenSides.some((id) => !sides.includes(id)))) {
    throw new ConflictError("The dispute's sides changed: read it again", { reason: "sides_changed" });
  }
  if (input.outcome === "rule") {
    // «По правилу»: the questions are closed and the sale is as the rule has it — no decision is recorded, so a later fact
    // still moves it by the rule. Every handed-in report holding the sale holds what the rule gives its person now — one an
    // agreement or a silence had settled, one whose line waited for this answer (a card the person disagreed with) — by
    // the path a cancelled decision takes (review round 3, 1): in the settlements' turn, the paid days asked before. A line
    // that already counts what the rule gives is left as it is (`settleReport` makes no version then).
    if (now_.pot || (now_.sale?.home?.shares.length ?? 0) === 0) throw new BadRequestError("The rule gives this sale to nobody: decide it", { reason: "no_rule_owner" });
    const paid = await paidDaysOf(app, await listCurrentReportsOfSales(db, [transactionId]));
    const made: MadeVersion[] = [];
    const by: SettleBy = { door: "workboard", actorUserId: principal.user.id, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null };
    await db.transaction(async (tx) => {
      const txDb = tx as unknown as Database;
      await lockSaleSettlements(txDb);
      // The questions close. A settlement of two sides that stands (a take, an agreement) is no question: it is part of
      // what the rule has now — the home the window showed for this answer — and stays, with what it gives.
      const closing = (await listSaleClaims(txDb, { transactionIds: [transactionId] })).filter((claim) => claim.state === "owner" || claim.state === "asked");
      for (const claim of closing) await updateSaleClaim(txDb, claim.id, { state: "decided", closedAt: now }, now);
      await refreshHomeWithin(txDb, now_.sale?.occurredAt ?? null, now);
      made.push(...await reportsBackToDraft(txDb, {
        transactionId, holds: () => true, madeFor: { kind: "claim", claimId: (closing[0] ?? open[0]!).id, transactionId, outcome: "rule" }, by, paid, at: now,
      }));
    });
    await afterPaid(app, made, now);
    await runSaleClaims(app, now).catch(() => undefined);
    return { decided: false, versions: made.map((one) => ({ shiftId: one.shiftId, version: one.version })), savedAt: now.toISOString() };
  }
  // The decision by the people it names: the shares sent (a button of the window), or a client before that read in the
  // window's own order (`first` — its first side, `second` — its second, `half` — the two).
  const among = (userId: number) => {
    if (!sides.includes(userId)) throw new ConflictError("This person is not a side of the dispute now: read it again", { reason: "sides_changed" });
    return userId;
  };
  let decision: { kind: "split" | "nobody" | "pot"; shares: Array<{ userId: number; percent: number }>; pot: string | null; outcome: "first" | "half" | "nobody" | "said"; made: "first" | "half" | "nobody" | "pot" };
  const sent = input.shares ?? [];
  switch (input.outcome) {
    case "first":
    case "second":
    case "give": {
      const userId = input.outcome === "give" ? sent.length === 1 && sent[0]!.percent === 100 ? sent[0]!.userId : null : sides[input.outcome === "first" ? 0 : 1] ?? null;
      if (userId === null) throw new BadRequestError("«целиком» names one person", { reason: "no_parties" });
      decision = { kind: "split", shares: [{ userId: among(userId), percent: 100 }], pot: null, outcome: "first", made: "first" };
      break;
    }
    case "half":
    case "split": {
      const two = input.outcome === "split" ? sent.map((one) => one.userId) : [sides[0], sides[1]];
      if (two.length !== 2 || two[0] === undefined || two[1] === undefined || two[0] === two[1] || (input.outcome === "split" && sent.some((one) => one.percent !== 50))) {
        throw new BadRequestError("«пополам» names two people", { reason: "no_second" });
      }
      const [low, high] = [among(two[0]), among(two[1])].sort((a, b) => a - b) as [number, number];
      decision = { kind: "split", shares: [{ userId: low, percent: 50 }, { userId: high, percent: 50 }], pot: null, outcome: "half", made: "half" };
      break;
    }
    case "pot":
      if (!now_.pot) throw new BadRequestError("Only a sale of the pot stays in the pot", { reason: "not_pot" });
      decision = { kind: "pot", shares: [], pot: POT_OBSHAK, outcome: "said", made: "pot" };
      break;
    default:
      decision = { kind: "nobody", shares: [], pot: null, outcome: "nobody", made: "nobody" };
  }
  const sale = now_.sale;
  const applied = await applySaleDecision(app, {
    transactionId,
    insert: {
      kind: decision.kind, shares: decision.shares, pot: decision.pot, outcome: decision.outcome, note, decidedByUserId: principal.user.id, decidedAt: now,
      saidBy: null, source: "dispute", ledgerDecisionId: null, ledgerRef: null,
    },
    madeFor: () => ({ kind: "claim", claimId: open[0]!.id, transactionId, outcome: decision.made }),
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
      made.push(...await reportsBackToDraft(txDb, {
        transactionId: saleId, holds: (line) => line.settled === "owner",
        madeFor: { kind: "decision", decisionId: decision.id, transactionId: saleId, outcome: "cancelled" }, by: input.by, paid, at: now,
      }));
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
  // The wall (sandbox/realm.ts): an owner reads the lines of his realm's people only.
  const test = await testUserIds(app);
  const realm = realmOf(principal) === "test";
  const pending = (await listPendingOffPlatform(app.db))
    .filter((line) => (query.shiftId === undefined || line.shiftId === query.shiftId) && test.has(line.userId) === realm);
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
  // The page by the report's own catalog (both realms, as a report names its pages): a test team's page is no live one,
  // and «мимо площадки» confirmed on it keeps it (review round 2, N6).
  const catalog = await pageCatalog(db);
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
    const pageId = label === null ? null : catalog.idOf.get(label) ?? null;
    if (!(await decideOffPlatform(txDb, { id: row.id, state, pageId, note, byUserId: principal.user.id, at: now }))) {
      throw new ConflictError("This line is already decided", { reason: "already_decided" });
    }
    if (handin === null || current === undefined || handin.state !== "submitted") return;
    const offPlatform = current.offPlatform.map((line) => (line.id === row.id ? { ...line, state, pageLabel: label } : line));
    if (!offPlatform.some((line) => line.id === row.id)) offPlatform.push({ id: row.id, amountMills: row.amountMills, fromWhom: "", whatFor: "", state, pageLabel: label });
    const sums = reportSums(current.lines, reportPages, offPlatform);
    const version = await insertHandinVersion(txDb, {
      handin, door: "workboard", actorUserId: principal.user.id, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null,
      totalMills: sums.totalMills, pages: sums.pages, lines: current.lines, offPlatform, comment: current.comment, modelComments: current.modelComments, dayPaid,
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
  // One cancelled or replaced meanwhile waits for no sale: refused before anything is written.
  if (decision === undefined || !decision.needsLink || decision.state !== "active") throw new NotFoundError("No such decision waiting for a sale");
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
      // No deadline: a colleague's word counts at once and the side may object whenever (owner, 2026-11-21).
      answerBy: null,
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
    else if (claim.answer === "disagree") out.push(claim.answerNote === null ? "«Не согласен»" : `«Не согласен»: ${claim.answerNote}`);
    else if (claim.escalatedWhy === "silence") out.push(`нет ответа ${Math.floor((now.getTime() - claim.createdAt.getTime()) / HOUR_MS)} ч`);
    else if (claim.escalatedWhy === "no_side") out.push("сдаёт смену не в системе: спросить в системе нельзя");
    else if (claim.kind === "double") out.push("посчитана в своём отчёте раньше");
  }
  return out;
}

/**
 * The sides of a disputed sale now — the one computation of the window and the decision (`disputeSidesOf`): everyone
 * who asked, whoever holds the sale by the rule now (its stored home, and the works holding it as the claimant's facts
 * read them — a «стык смен» names both shifts), the other side of each question, whoever's counted report counts it.
 */
async function disputeSidesNow(app: ClaimsApp, claims: readonly SaleClaimRow[], now: Date) {
  const { db } = app;
  const transactionId = claims.find((claim) => claim.transactionId !== null)?.transactionId ?? null;
  const sale = transactionId === null ? undefined : (await listHandinSalesByIds(db, [transactionId]))[0];
  const reports = transactionId === null ? [] : await listCurrentReportsOfSales(db, [transactionId]);
  const open = claims.filter((claim) => claim.state !== "withdrawn");
  let facts: ShiftReportLineFacts | null = null;
  if (transactionId !== null) {
    const shiftIds: number[] = [];
    for (const claim of [...open].sort((a, b) => a.id - b.id)) {
      if (claim.claimantHandinId !== null) {
        const handin = await findHandinById(db, claim.claimantHandinId);
        if (handin !== null) shiftIds.push(handin.shiftId);
      }
      if (claim.sideShiftId !== null) shiftIds.push(claim.sideShiftId);
    }
    for (const report of reports) shiftIds.push(report.shiftId);
    for (const shiftId of [...new Set(shiftIds)]) {
      facts = await saleLineFacts(app, shiftId, transactionId, now).catch(() => null);
      if (facts !== null) break;
    }
  }
  const holders = [...(sale?.home?.shares.map((share) => share.userId) ?? []), ...(facts?.holders?.map((holder) => holder.userId) ?? [])];
  const counting = reports.filter((report) => report.lines.some((line) => line.transactionId === transactionId && line.amountMills > 0)).map((report) => report.userId);
  const pot = sale?.home?.home === "pot" || reports.some((report) => report.lines.some((line) => line.transactionId === transactionId && line.rule.home === "pot"));
  return { transactionId, sale, reports, facts, pot, sides: transactionId === null ? [] : disputeSidesOf({ claims: open, holders, counting }) };
}

async function disputeOf(app: ClaimsApp, claims: readonly SaleClaimRow[], now: Date): Promise<SaleDisputeResponse> {
  const { db } = app;
  const { transactionId, sale, reports, facts: sideFacts, pot, sides } = await disputeSidesNow(app, claims, now);
  const legacy = partiesOf(claims.filter((claim) => claim.state !== "withdrawn"));
  const first = sides[0] ?? legacy.first;
  const ids = [...sides, ...(legacy.first === null ? [] : [legacy.first]), ...(sale?.home?.shares.map((share) => share.userId) ?? [])];
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
  // The sides, each a party of the window: the decider's buttons name them (a question with nobody, the one who asked).
  const parties = (sides.length > 0 ? sides : first === null ? [] : [first]).map((userId, index) => party(userId, index === 0 ? "first" : "second"));
  const facts = sideFacts;
  const net = sale?.netMills ?? 0;
  const outcomes: SaleDisputeResponse["outcomes"] = [];
  const nameOf = (id: number | null) => (id === null ? "" : names.get(id) ?? `#${id}`);
  if (transactionId !== null) {
    const homeMills = (userId: number) => sale?.home?.shares.filter((share) => share.userId === userId).reduce((sum, share) => sum + share.mills, 0) ?? 0;
    for (const answer of disputeAnswersOf({ sides: parties.map((one) => one.userId), pot, ruleNamesSomeone: !pot && (sale?.home?.shares.length ?? 0) > 0 })) {
      const halves = answer.outcome === "split" ? halvesOf(net, answer.shares[0]!.userId, answer.shares[1]!.userId) : [];
      const gives = parties.map((one) => ({
        userId: one.userId,
        mills: answer.outcome === "give" ? (answer.shares[0]!.userId === one.userId ? net : 0)
          : answer.outcome === "split" ? halves.find((half) => half.userId === one.userId)?.mills ?? 0
            : answer.outcome === "rule" ? homeMills(one.userId) : 0,
      }));
      const label = answer.outcome === "give" ? `${nameOf(answer.shares[0]!.userId)}: целиком`
        : answer.outcome === "split" ? `Пополам: ${nameOf(answer.shares[0]!.userId)} и ${nameOf(answer.shares[1]!.userId)}`
          : answer.outcome === "pot" ? "Остаётся в общаке"
            : answer.outcome === "rule" ? "Оставить по правилу" : "Никому";
      outcomes.push({ outcome: answer.outcome, key: answer.key, label, gives, shares: answer.shares });
    }
  }
  if (claims.every((claim) => claim.kind === "imported" || claim.kind === "question")) outcomes.push({ outcome: "dismiss", key: "dismiss", label: "Закрыть без решения", gives: [], shares: [] });
  const cardRows = await declinedCardsOf(db, claims);
  const cardNames = await listHandinNames(db, cardRows.flatMap((card) => (card.toUserId === null ? [] : [card.toUserId])));
  const cardName = (id: number | null) => (id === null ? "" : cardNames.get(id) ?? `#${id}`);
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
    // The card of Gengar a side disagreed with: the decider reads what it wanted and why.
    cards: cardRows.map((card) => ({
      words: card.to === "pot" ? "в общак" : card.to === "give" ? `отдать ${cardName(card.toUserId)}` : card.to === "share" ? `пополам с ${cardName(card.toUserId)}`
        : card.to === "mine" ? "это продажа спросившего" : card.to === "not_mine" ? "не продажа спросившего" : "по правилу",
      why: card.why,
    })),
    facts,
    outcomes,
    decision: decision === undefined ? null : { outcome: decision.outcome, note: decision.note, decidedAt: decision.decidedAt.toISOString(), by: decider },
    reports: held.map((report) => ({ userId: report.userId, name: heldNames.get(report.userId) ?? `#${report.userId}`, shiftId: report.shiftId, reportDate: report.reportDate })),
    serverNow: now.toISOString(),
  };
}

/** `saleDispute`: the owner's dispute of a sale — or a sale its holder gave to the pot, waiting for his word. */
export async function readSaleDispute(app: ClaimsApp, principal: HumanAuthPrincipal, transactionId: number, now: Date = new Date()): Promise<SaleDisputeResponse> {
  const claims = (await listSaleClaims(app.db, { transactionIds: [transactionId] })).filter((claim) => claim.state !== "withdrawn");
  if (claims.length === 0) {
    const offer = await potOfferOf(app.db, transactionId);
    const decided = offer === null ? await decidedPotOfferOf(app.db, transactionId) : null;
    if (offer !== null || decided !== null) {
      if (principal.user.role !== "owner" || principal.narrowDeviceTokenId !== undefined) throw new ForbiddenError("Only the owner decides");
      return offer !== null ? potOfferDisputeOf(app, offer, now) : potOfferDisputeOf(app, decided!.offer, now, decided!.decision);
    }
  }
  if (principal.user.role !== "owner" && claims.length === 0) throw new ForbiddenError("Only the owner decides");
  await requireDisputeDecider(app, principal, claims);
  if (claims.length === 0) throw new NotFoundError("No dispute of this sale");
  return disputeOf(app, claims.sort((a, b) => Number(b.state === "owner") - Number(a.state === "owner") || a.id - b.id), now);
}

/** `saleDisputeOfClaim`: a question carried over from the ledger that names no sale. */
export async function readSaleDisputeOfClaim(app: ClaimsApp, principal: HumanAuthPrincipal, claimId: number, now: Date = new Date()): Promise<SaleDisputeResponse> {
  const claim = await findSaleClaim(app.db, claimId);
  if (claim === null && principal.user.role !== "owner") throw new ForbiddenError("Only the owner decides");
  await requireDisputeDecider(app, principal, claim === null ? [] : [claim]);
  if (claim === null) throw new NotFoundError("No such claim");
  return claim.transactionId === null ? disputeOf(app, [claim], now) : readSaleDispute(app, principal, claim.transactionId, now);
}

// ── A sale given to the pot ──────────────────────────────────────────────────

type PotOffer = Awaited<ReturnType<typeof listOpenPotOffers>>[number] & { note: string | null };

/** The open offer of the pot on a sale: its holder said «в общак» (their mark) and the owner has not decided. Null — none. */
async function potOfferOf(db: Database, transactionId: number): Promise<PotOffer | null> {
  const offer = (await listOpenPotOffers(db)).find((one) => one.transactionId === transactionId);
  if (offer === undefined) return null;
  const mark = (await listHandinMarks(db, offer.handinId)).find((one) => one.transactionId === transactionId);
  return { ...offer, note: mark?.note ?? null };
}

/**
 * What each answer to an offer of the pot decides, by the existing decisions (no kind, outcome or source the decisions'
 * feed does not know): «В общак» — kind pot, the page's pot; «Вернуть» — the whole sale to the person; «Никому» — nobody.
 * And what becomes of the person's word: kept «общак», withdrawn (the rule's word, the decision gives it back), «ничья».
 * Pure (tests/sale-claim-rules.test.ts).
 */
export function potOfferDecision(outcome: "pot" | "return" | "nobody", userId: number): {
  kind: "pot" | "split" | "nobody"; shares: Array<{ userId: number; percent: number }>; pot: string | null; outcome: "said" | "first" | "nobody";
  word: "pot" | "not_mine" | null;
} {
  if (outcome === "pot") return { kind: "pot", shares: [], pot: POT_OBSHAK, outcome: "said", word: "pot" };
  if (outcome === "return") return { kind: "split", shares: [{ userId, percent: 100 }], pot: null, outcome: "first", word: null };
  return { kind: "nobody", shares: [], pot: null, outcome: "nobody", word: "not_mine" };
}

/** The owner's answer to an offer of the pot: a decision through `applySaleDecision` (the decisions door's own path), the word with it. */
async function decidePotOffer(app: ClaimsApp, principal: HumanAuthPrincipal, input: { offer: PotOffer; outcome: "pot" | "return" | "nobody"; note: string | null }, now: Date) {
  const { db } = app;
  const { offer } = input;
  const decision = potOfferDecision(input.outcome, offer.userId);
  const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
  const sale = (await listHandinSalesByIds(db, [offer.transactionId]))[0];
  const applied = await applySaleDecision(app, {
    transactionId: offer.transactionId,
    insert: {
      kind: decision.kind, shares: decision.shares, pot: decision.pot, outcome: decision.outcome, note, decidedByUserId: principal.user.id, decidedAt: now,
      saidBy: null, source: "dispute", ledgerDecisionId: null, ledgerRef: null,
    },
    madeFor: (decisionId) => ({ kind: "decision", decisionId: decisionId!, transactionId: offer.transactionId, outcome: "said" }),
    by: { door: "workboard", actorUserId: principal.user.id, agentKeyId: null, telegramMessageRef: null, telegramSenderId: null },
    // The person's word follows the answer in the same turn: the next «Исправить» starts from it.
    first: async (txDb) => {
      const mark = (await listHandinMarks(txDb, offer.handinId)).find((one) => one.transactionId === offer.transactionId);
      if (mark?.statement !== "pot") throw new ConflictError("The sale is no longer given to the pot", { reason: "pot_offer_gone" });
      if (decision.word !== "pot") {
        await setHandinMark(txDb, {
          handinId: offer.handinId, transactionId: offer.transactionId, statement: decision.word, shareWithUserId: null, note: mark.note,
          byUserId: principal.user.id, byAgentKeyId: null, at: now,
        });
      }
      return {};
    },
  }, sale, now);
  // Answered: the owner's matter leaves «Ждут вас» at once, as a dispute's does (the minute pass would close it later).
  await closeMatter(db, { key: `${POT_OFFER_KIND}:${offer.transactionId}`, how: "resolved", writer: "server" }, SYSTEM, now).catch((error: unknown) => {
    app.logger.warn({ transactionId: offer.transactionId, err: error instanceof Error ? error.message : String(error) }, "pot offer: the matter did not close; the next pass will");
  });
  return { decided: true, versions: applied.versions.map((one) => ({ shiftId: one.shiftId, version: one.version })), savedAt: now.toISOString() };
}

/**
 * An offer of the pot the owner already answered: the window re-read after the press shows what was decided, not a
 * 404. The person is the one whose counted report holds the sale. Null — no such answered offer.
 */
async function decidedPotOfferOf(db: Database, transactionId: number): Promise<{ offer: PotOffer; decision: SaleDecisionRow } | null> {
  const decision = (await listActiveSaleDecisions(db, [transactionId])).get(transactionId);
  if (decision === undefined || decision.source !== "dispute" || !["pot", "split", "nobody"].includes(decision.kind)) return null;
  const report = (await listCurrentReportsOfSales(db, [transactionId])).find((one) => one.lines.some((line) => line.transactionId === transactionId));
  if (report === undefined) return null;
  const handin = await findHandinByShift(db, report.shiftId);
  if (handin === null) return null;
  const mark = (await listHandinMarks(db, handin.id)).find((one) => one.transactionId === transactionId);
  // Only a sale that was given to the pot: its word was «общак» (kept, or withdrawn/«ничья» by the answer, by the owner).
  if (mark === undefined || (mark.statement !== "pot" && mark.statement !== null && mark.statement !== "not_mine")) return null;
  const sale = (await listHandinSalesByIds(db, [transactionId]))[0];
  return {
    offer: {
      handinId: handin.id, shiftId: report.shiftId, userId: report.userId, transactionId, pageId: sale?.pageId ?? 0, kind: sale?.kind ?? "",
      netMills: sale?.netMills ?? 0, occurredAt: sale?.occurredAt ?? new Date(0), note: mark.note,
    },
    decision,
  };
}

/** The window of an offer of the pot: the sale, the person and their why, the three answers with what each gives. */
async function potOfferDisputeOf(app: ClaimsApp, offer: PotOffer, now: Date, decided: SaleDecisionRow | null = null): Promise<SaleDisputeResponse> {
  const { db } = app;
  const sale = (await listHandinSalesByIds(db, [offer.transactionId]))[0];
  const names = await listHandinNames(db, [offer.userId, ...(sale?.home?.shares.map((share) => share.userId) ?? [])]);
  const name = names.get(offer.userId) ?? `#${offer.userId}`;
  const reports = await listCurrentReportsOfSales(db, [offer.transactionId]);
  const own = reports.find((report) => report.userId === offer.userId);
  const line = own?.lines.find((one) => one.transactionId === offer.transactionId);
  const net = sale?.netMills ?? 0;
  const held = reports.filter((report) => report.lines.some((one) => one.transactionId === offer.transactionId));
  const heldNames = await listHandinNames(db, held.map((report) => report.userId));
  return {
    sale: sale === undefined ? null : {
      transactionId: sale.transactionId, pageLabel: sale.pageLabel, platform: sale.platform, kind: sale.kind, occurredAt: sale.occurredAt.toISOString(),
      netMills: sale.netMills, fan: sale.fan,
    },
    home: sale?.home == null ? null : {
      kind: sale.home.home, reason: sale.home.reason, words: SALE_HOME_REASON_TEXT[sale.home.reason as SaleHomeReason] ?? sale.home.reason,
      shares: sale.home.shares.map((share) => ({ userId: share.userId, name: names.get(share.userId) ?? `#${share.userId}`, mills: share.mills })),
    },
    parties: [{
      userId: offer.userId, name, role: "first",
      says: [offer.note === null ? "в общак" : `в общак: ${offer.note}`],
      countedMills: line === undefined ? null : line.amountMills, claimedMills: line?.claimedMills ?? null, shiftId: own?.shiftId ?? offer.shiftId,
    }],
    claims: [],
    cards: [],
    facts: null,
    outcomes: decided !== null ? [] : [
      { outcome: "pot", key: "pot", label: "В общак", gives: [{ userId: offer.userId, mills: 0 }], shares: [] },
      { outcome: "return", key: "return", label: `Вернуть ${personNameForms(name).dat}`, gives: [{ userId: offer.userId, mills: net }], shares: [] },
      { outcome: "nobody", key: "nobody", label: "Никому", gives: [{ userId: offer.userId, mills: 0 }], shares: [] },
    ],
    decision: decided === null ? null : {
      outcome: decided.kind === "pot" ? "в общак" : decided.kind === "nobody" ? "никому" : `вернуть ${personNameForms(name).dat}`,
      note: decided.note,
      decidedAt: decided.decidedAt.toISOString(),
      by: decided.decidedByUserId === null ? null : (await listHandinNames(db, [decided.decidedByUserId])).get(decided.decidedByUserId) ?? null,
    },
    reports: held.map((report) => ({ userId: report.userId, name: heldNames.get(report.userId) ?? `#${report.userId}`, shiftId: report.shiftId, reportDate: report.reportDate })),
    potOffer: { userId: offer.userId, name, note: offer.note },
    serverNow: now.toISOString(),
  };
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
  const of = {
    ...(input.transactionId !== undefined ? { transactionIds: [input.transactionId] } : {}),
    ...(userIds !== null ? { involvingUserIds: userIds } : {}),
  };
  const claims = [
    ...await listSaleClaims(db, { ...of, ...(input.scope === "open" ? { states: ["asked", "owner"] as const } : {}), limit: 500 }),
    // Not over either: a take the side was told of and has not answered while its notice is open (they may still
    // object). Read by its own days, so the agreements of months never crowd an open dispute out of the list.
    ...(input.scope !== "open" ? [] : (await listSaleClaims(db, { ...of, states: ["agreed"], kinds: ["claim"], silenceSince: new Date(now.getTime() - TAKE_NOTICE_MS), limit: 500 }))
      .filter((claim) => takeNoticeOpen(claim, now))),
  ].filter((claim) => claim.pageId !== null && granted.has(claim.pageId));
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
      const what = wire.statement === "share" ? `записывает пополам с ${wire.side?.name ?? "коллегой"}` : wire.kind === "double" ? `и ${wire.side?.name ?? "коллега"} посчитали в отчётах` : `записывает себе (по правилу ${wire.side?.name ?? "ничья"})`;
      // A take stands without the side's answer: counted as written, the side told.
      const state = wire.state === "agreed" && wire.answer === null ? "записано, вторая сторона не отвечала"
        : { asked: "ждёт ответа", agreed: "согласовано", owner: "у владельца", decided: "решено", withdrawn: "снято" }[wire.state];
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
