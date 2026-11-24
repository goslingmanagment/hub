import type {
  SaleChainLink,
  SaleChainResponse,
  TeamLedgerPayoutPersonResponse,
  TeamLedgerReportDay,
  TeamLedgerReportsResponse,
} from "@agency_hub_core/contracts";
import { formatDateTime, moscowDayOf, moscowToday } from "@agency_hub_core/look";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import {
  findHandinShift,
  findOwnPayPerson,
  findSaleIdByPlatformRef,
  listActiveSaleDecisions,
  listAdminModels,
  listCurrentReportsOfSales,
  listHandinNames,
  listHandinPeopleOfUsers,
  listHandinSalesByIds,
  listSaleClaims,
  shiftOfUsersHoldsSale,
  type CurrentReport,
  type HandinSaleRow,
  type HandinShift,
  type SaleClaimRow,
  type SaleDecisionRow,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AuthPrincipal } from "./auth.ts";
import { NotFoundError } from "./errors.ts";
import { hubModelNameOf, type HubModel } from "./ledger-month.ts";
import { realmOf, requireSalesOfRealm } from "./sandbox/realm.ts";
import { readTeamLedgerPayoutPerson } from "./ledger-person-pay.ts";
import { readTeamLedgerReports } from "./ledger-team-reports.ts";
import { SALE_HOME_REASON_TEXT, SALE_RULE, isTeamHiddenSaleHome, type SaleHomeReason } from "./sale-rule.ts";
import { dayWords, shiftWords } from "./shift-handin-rules.ts";

/**
 * Цепочка продажи (ecosystem plan 2026-11-12, package T; OA-003): from one sale, where its money is — whose it is (the
 * home of the one rule, the owner's decision or the agreement above it, an open claim), the shift the home names, the
 * person's report of that day (Hub's handed-in version holding the sale, else the ledger's report of the day), and the
 * ledger's accrual and payout of that person's day for the sale's exact model. Read only; nothing is computed anew:
 * `sale_homes`, the shift rows, the handed-in versions, and the ledger's reads «Выплаты → Отчёты» and the payout panel
 * already make. The chain never asserts «this sale is paid»: on a Hub-basis day it states two verifiable facts (what
 * active version N counted for this sale, and whether the person's day for that model is paid); on a post, sheet or
 * facts day it states the day's payout status and that this sale's inclusion is unconfirmed; when the source, basis or
 * model is unknown it says «неизвестно», never a guess and never another model of the day.
 *
 * Who reads what (`ChainViewer`): the owner everything, pay sums included; a chatter a sale of their own shifts,
 * reports or claims on a page they may open — the home, their own report, their accrual and payout as states, their
 * sums only with «видит свои деньги»; a team lead a sale of their pages — whose it is, the shift and the report, never
 * another person's accrual or payout, not even as a state (the ledger is not asked); an agent key (read:money) a sale
 * of its pages, no pay sums. Another sale is not found (404), never an empty chain.
 */

type ChainApp = Pick<AppContext, "db" | "config" | "logger">;

export type ChainViewer =
  | { kind: "owner" }
  | { kind: "team_lead"; userId?: number; pageIds: readonly number[] }
  | { kind: "chatter"; userId: number; pageIds: readonly number[] }
  | { kind: "agent"; pageIds: readonly number[] };

const notFound = () => new NotFoundError("No such sale");
const money = (mills: number) => formatUsdFromMills(mills);

// ── Pure: the links' words ───────────────────────────────────────────────────

/** What a reader may see of sums: a sale's share and a report's line; a post's page sum; a day's accrual and payout. */
export interface ChainSums {
  share: boolean;
  hubLine: boolean;
  post: boolean;
  pay: boolean;
}

/** «Чья»: the home, the decision or agreement above the rule, an open claim. Pure. */
export function homeLinkOf(input: {
  sale: Pick<HandinSaleRow, "transactionId" | "occurredAt" | "home">;
  names: ReadonlyMap<number, string>;
  decision: Pick<SaleDecisionRow, "kind" | "shares" | "pot" | "outcome" | "source" | "saidBy"> | null;
  claims: ReadonlyArray<Pick<SaleClaimRow, "state" | "sideUserId" | "createdAt" | "claimantUserId" | "statement">>;
  ownerReads: boolean;
}): SaleChainResponse["home"] {
  const { sale, names } = input;
  const home = sale.home;
  const nameOf = (id: number) => names.get(id) ?? `#${id}`;
  const before = sale.occurredAt.getTime() < SALE_RULE.since;
  const reason = home === null ? null : SALE_HOME_REASON_TEXT[home.reason as SaleHomeReason] ?? home.reason;
  let state: SaleChainLink["state"];
  let words: string;
  if (home === null) {
    state = before ? "none" : "unknown";
    words = before ? "продажа раньше 2 нояб., до правила: считается по-старому, постами" : "неизвестно: правило ещё не посчитало эту продажу";
  } else {
    const people = [...new Set(home.shares.map((share) => share.userId))];
    const shares = people.map((userId) => {
      const mills = home.shares.filter((share) => share.userId === userId).reduce((sum, share) => sum + share.mills, 0);
      return people.length > 1 ? `${nameOf(userId)} ${money(mills)}` : nameOf(userId);
    }).join(", ");
    switch (home.home) {
      case "shift":
      case "visit":
        state = "done";
        words = `${shares}: ${reason}`;
        break;
      case "pot":
        state = "done";
        words = `общак: ${reason}`;
        break;
      case "waiting":
        state = "wait";
        words = reason ?? "PPV ждёт смены отправителя";
        break;
      case "decide":
        state = "open";
        words = `решает владелец: ${reason}`;
        break;
      case "nobody":
        state = "none";
        words = `ничья: ${reason}`;
        break;
      case "before_rule":
        state = "none";
        words = "продажа до правила (раньше 2 нояб.): считается по-старому, постами";
        break;
      default:
        state = "unknown";
        words = `неизвестно: ${reason ?? "правило не решило"}`;
    }
  }
  let above: string | null = null;
  if (input.decision !== null) {
    const decision = input.decision;
    const who = decision.kind === "nobody" ? "никому" : decision.kind === "pot" ? `в общак ${decision.pot ?? ""}`.trim()
      : decision.shares.map((share) => `${nameOf(share.userId)}${share.percent === 100 ? "" : ` ${share.percent}%`}`).join(" и ");
    above = decision.source === "ledger"
      ? `решение из ledger${decision.saidBy ? ` (сказал ${decision.saidBy})` : ""}: ${who}`
      : `решение владельца: ${who}`;
    if (before) above += "; продажа до правила, дом не меняется";
  } else if (home?.reason === "agreed") {
    above = "по согласию сторон";
  }
  const open = input.claims.find((claim) => claim.state === "owner") ?? input.claims.find((claim) => claim.state === "asked");
  let dispute: string | null = null;
  if (open !== undefined) {
    state = "open";
    dispute = open.state === "owner"
      ? "спор открыт: решает владелец"
      : `спор открыт: ждёт ответа ${open.sideUserId === null ? "второй стороны" : nameOf(open.sideUserId)}`;
  }
  return {
    state,
    words,
    link: open !== undefined && input.ownerReads ? `/workboard/waiting?dispute=${sale.transactionId}#questions` : null,
    amountMills: null,
    kind: home?.home ?? null,
    reason,
    above,
    dispute,
  };
}

/** «Смена»: the shift the home names, or why there is none. Pure. */
export function shiftLinkOf(input: { shift: HandinShift | null; workRef: string | null; own: boolean; transactionId: number; kind: string | null }): SaleChainLink {
  const { shift } = input;
  if (shift === null) {
    const words = input.workRef === null
      ? input.kind === "shift" ? "без смены: продажа отдана решением или заявкой" : "смены нет"
      : "заход, не смена: отчёта смены у него нет";
    return { state: "none", words, link: null, amountMills: null };
  }
  const path = `/workboard/report/${shift.id}?sale=${input.transactionId}`;
  return { state: shift.state === "going" ? "wait" : "done", words: `смена ${shiftWords(shift.startedAt, shift.endedAt)}${shift.state === "going" ? ", идёт" : ""}`, link: path, amountMills: null };
}

/** What the person's active handed-in Hub version counts for this sale. */
export type HubReportLineStatus = "counted" | "disputed" | "zero";

export interface HubReportEvidence {
  version: number;
  status: HubReportLineStatus;
}

/** Extract the active handed-in Hub version's verdict on this sale; null when no report holds it. Pure. */
export function hubReportEvidenceOf(report: Pick<CurrentReport, "version" | "lines"> | null, transactionId: number): HubReportEvidence | null {
  if (report === null) return null;
  const line = report.lines.find((one) => one.transactionId === transactionId);
  if (line === undefined) return null;
  const status: HubReportLineStatus = line.disputed || (line.claimedMills ?? 0) > 0
    ? "disputed"
    : line.amountMills > 0 ? "counted" : "zero";
  return { version: report.version, status };
}

/**
 * The report day of a person's share in the chain: the handed-in Hub version's date first; else the owner's decision's
 * `appliedReportDate` (when it names this person or no specific login); else the shift's report date; else the sale's
 * Moscow day. Pure.
 */
export function chainReportDateOf(input: {
  handedIn: Pick<CurrentReport, "reportDate"> | null;
  decision: Pick<SaleDecisionRow, "appliedReportDate" | "appliedUserId"> | null;
  logins: readonly number[];
  shift: Pick<HandinShift, "reportDate"> | null;
  occurredAt: Date;
}): string {
  const applied = input.decision !== null
    && input.decision.appliedReportDate !== null
    && (input.decision.appliedUserId === null || input.logins.includes(input.decision.appliedUserId))
    ? input.decision.appliedReportDate
    : null;
  return input.handedIn?.reportDate ?? applied ?? input.shift?.reportDate ?? moscowDayOf(input.occurredAt);
}

/** The ledger's report day, exact model and `basis` for the sale's page from `readReports(reportDate)`. Pure. */
export function reportPageMetaOf(
  reports: Pick<TeamLedgerReportsResponse, "reports">,
  input: { personCode: string; reportDate: string; pageLabel: string },
): { day: TeamLedgerReportDay | null; model: string | null; basis: string | null } {
  const day = reports.reports.find((one) => one.person.slug === input.personCode && one.reportDate === input.reportDate) ?? null;
  const page = day?.pages.find((one) => one.pageLabel === input.pageLabel) ?? null;
  const model = page !== null && page.model.trim() !== "" ? page.model.trim() : null;
  return { day, model, basis: page?.basis ?? null };
}

/**
 * On a non-report day (`sheet` or `facts`), `/v1/report-days` carries no row for the page. Resolve the ledger's model
 * from the day's non-report rows only when it unambiguously maps to the sale's Hub model (`hubModelNameOf`), never
 * guessing and never substituting another model of the day. Pure.
 */
export function nonReportDayModelOf(input: {
  days: ReadonlyArray<Pick<TeamLedgerPayoutPersonResponse["days"][number], "date" | "model" | "source">>;
  reportDate: string;
  saleModel: HubModel;
  models: readonly HubModel[];
}): string | null {
  const ofDay = input.days.filter((one) => one.date === input.reportDate);
  const nonReport = ofDay.filter((one) => one.source === "sheet" || one.source === "facts");
  if (nonReport.length === 0) return null;
  const known = input.models.length > 0 ? input.models : [input.saleModel];
  const matched = [...new Set(nonReport.map((one) => one.model))]
    .filter((ledgerModel) => hubModelNameOf(ledgerModel, known) === input.saleModel.name);
  if (matched.length === 1) return matched[0]!;
  const knownNames = new Set(known.map((one) => one.name));
  if (matched.length === 0 && ofDay.every((one) => knownNames.has(hubModelNameOf(one.model, known)))) {
    return input.saleModel.name;
  }
  return null;
}

/** The report's link from Hub's handed-in version holding the sale. Pure. */
export function hubReportLinkOf(input: { report: CurrentReport; transactionId: number; own: boolean; sums: ChainSums }): SaleChainLink {
  const line = input.report.lines.find((one) => one.transactionId === input.transactionId)!;
  const claimed = line.claimedMills ?? 0;
  const disputed = line.disputed || claimed > 0;
  const counted = disputed
    ? (claimed > 0 ? `спорно, ждёт решения: ${money(claimed)}` : "спорно, ждёт решения")
    : line.amountMills > 0 ? `засчитано ${money(line.amountMills)}` : "в отчёте с нулём";
  const statement = line.statement === "not_mine" ? ", «не моё»" : line.statement === "share" ? ", «делим»" : line.statement === "mine" ? ", «моё»" : "";
  const path = `/workboard/report/${input.report.shiftId}?sale=${input.transactionId}`;
  return {
    state: disputed ? "open" : "done",
    words: `сдан: версия ${input.report.version}, ${formatDateTime(input.report.submittedAt.toISOString())}; ${input.sums.hubLine ? counted : disputed ? "спорно, ждёт решения" : line.amountMills > 0 ? "засчитана" : "не засчитана"}${statement}`,
    link: path,
    amountMills: input.sums.hubLine ? line.amountMills : null,
  };
}

/** The report's link from the ledger's report of the day: a post, a draft, a post the ledger could not use, none. Pure. */
export function postReportLinkOf(input: {
  day: TeamLedgerReportDay | null;
  posts: TeamLedgerReportsResponse["posts"];
  pageLabel: string;
  reportDate: string;
  sums: ChainSums;
  link: string | null;
}): SaleChainLink {
  const { day } = input;
  const date = dayWords(input.reportDate);
  if (day === null) return { state: "wait", words: `отчёта за ${date} в ledger пока нет`, link: input.link, amountMills: null };
  const blocking = input.posts.find((post) => day.postIds.includes(post.id) && post.blocking);
  if (blocking !== undefined) {
    return { state: "wait", words: `пост за ${date} не разобран, не начислен: ${blocking.flags.join(", ")}`, link: input.link, amountMills: null };
  }
  const page = day.pages.find((one) => one.pageLabel === input.pageLabel) ?? null;
  if (page?.basis === "hub" && page.hubMills !== null) {
    return { state: "wait", words: `отчёт за ${date} сдан в системе, но без этой продажи`, link: input.link, amountMills: null };
  }
  const posted = page?.postedMills ?? null;
  if (posted !== null) {
    return {
      state: "done",
      words: `пост за ${date} отправлен${input.sums.post ? `: ${input.pageLabel} ${money(posted)}` : ""}; пост не перечисляет продажи по одной`,
      link: input.link,
      amountMills: input.sums.post ? posted : null,
    };
  }
  if (day.pages.some((one) => one.postedMills !== null)) {
    return { state: "wait", words: `пост за ${date} отправлен, но без страницы ${input.pageLabel}`, link: input.link, amountMills: null };
  }
  if (day.draft !== null) return { state: "wait", words: `отчёт за ${date} собран агентом, пост не отправлен`, link: input.link, amountMills: null };
  return { state: "wait", words: `поста за ${date} пока нет`, link: input.link, amountMills: null };
}

type EffectivePayBasis = "hub" | "post" | "sheet" | "facts" | "unknown";

function effectiveBasisOf(days: ReadonlyArray<{ source: string }>, pageBasis: string | null): EffectivePayBasis {
  const sources = new Set(days.map((one) => one.source));
  if (sources.size !== 1) return "unknown";
  const [source] = sources;
  if (source === "sheet") return "sheet";
  if (source === "facts") return "facts";
  if (source === "reports" || source === "report") {
    if (pageBasis === "hub") return "hub";
    if (pageBasis === "post") return "post";
    return "unknown";
  }
  return "unknown";
}

function basisWords(basis: Exclude<EffectivePayBasis, "unknown">): string {
  switch (basis) {
    case "hub": return "отчёт Hub";
    case "post": return "пост";
    case "sheet": return "таблица";
    case "facts": return "факты";
  }
}

function hubStatusWords(status: HubReportLineStatus): string {
  switch (status) {
    case "counted": return "засчитано";
    case "disputed": return "спорно";
    case "zero": return "ноль";
  }
}

/**
 * «Начисление» and «Выплата» from the ledger's day of the person for the sale's exact model (never falling back to
 * other models of the day). Never asserts «this sale is paid»: on a Hub-basis day states what active version N counted
 * for this sale plus whether the person's day for that model is paid; on a sheet, post or facts day states that the
 * day's payout does not confirm this sale's inclusion; when basis or model is unknown says «неизвестно». Pure.
 */
export function payLinksOf(input: {
  pay: Pick<TeamLedgerPayoutPersonResponse, "days" | "payouts" | "reportsFrom"> | null;
  /** Why the ledger is not read: not connected, did not answer, has no tab of the person. */
  unknown: string | null;
  reportDate: string;
  /** The sale's exact model in the ledger; null — unknown. */
  model: string | null;
  /** The page's basis from the ledger's `/v1/report-days` (`hub`, `post`); null — unknown from report-days. */
  basis: string | null;
  /** What the person's active handed-in Hub version counts for this sale; null — none holds it. */
  hubReport: HubReportEvidence | null;
  /** Why `/v1/report-days` was not read (e.g. ledger did not answer); null — read succeeded or not needed. */
  reportsUnknown?: string | null;
  sums: ChainSums;
  link: string | null;
}): { accrual: SaleChainLink; payout: SaleChainLink } {
  if (input.pay === null) {
    const words = `неизвестно: ${input.unknown ?? "ledger не ответил"}`;
    return { accrual: { state: "unknown", words, link: input.link, amountMills: null }, payout: { state: "unknown", words, link: input.link, amountMills: null } };
  }
  const date = dayWords(input.reportDate);
  const ofDay = input.pay.days.filter((one) => one.date === input.reportDate);
  if (input.model === null) {
    if (input.reportsUnknown != null) {
      const words = `неизвестно: ${input.reportsUnknown}`;
      return { accrual: { state: "unknown", words, link: input.link, amountMills: null }, payout: { state: "unknown", words, link: input.link, amountMills: null } };
    }
    if (ofDay.length > 0) {
      const words = "неизвестно: модель страницы в ledger не определена";
      return { accrual: { state: "unknown", words, link: input.link, amountMills: null }, payout: { state: "unknown", words, link: input.link, amountMills: null } };
    }
  }
  const days = input.model === null ? [] : ofDay.filter((one) => one.model === input.model);
  const accrued = days.reduce((sum, one) => sum + one.amountMills, 0);
  const paid = days.reduce((sum, one) => sum + one.paidMills, 0);
  const unpaid = days.reduce((sum, one) => sum + one.unpaidMills, 0);
  if (accrued <= 0) {
    const notYet = input.pay.reportsFrom !== null && input.reportDate >= input.pay.reportsFrom;
    const modelPart = input.model === null ? "" : ` по модели ${input.model}`;
    const payout: SaleChainLink = input.basis === "hub" && input.hubReport !== null
      ? {
        state: input.hubReport.status === "disputed" ? "open" : "none",
        words: `в версии ${input.hubReport.version} — ${hubStatusWords(input.hubReport.status)}; день${modelPart} не начислен`,
        link: input.link,
        amountMills: null,
      }
      : { state: "none", words: "платить пока нечего", link: input.link, amountMills: null };
    return {
      accrual: { state: "wait", words: notYet ? `за ${date}${modelPart} пока не начислено: ledger начисляет по отчёту дня` : `за ${date}${modelPart} не начислено`, link: input.link, amountMills: null },
      payout,
    };
  }
  const effectiveBasis = effectiveBasisOf(days, input.basis);
  if (effectiveBasis === "unknown") {
    const words = `неизвестно: ${input.reportsUnknown ?? "основа начисления дня не определена"}`;
    return { accrual: { state: "unknown", words, link: input.link, amountMills: null }, payout: { state: "unknown", words, link: input.link, amountMills: null } };
  }
  const accrual: SaleChainLink = {
    state: "done",
    words: `начислено за ${date} по модели ${input.model} (${basisWords(effectiveBasis)})${input.sums.pay ? `: ${money(accrued)} за день` : ", за день целиком"}`,
    link: input.link,
    amountMills: input.sums.pay ? accrued : null,
  };
  const by = new Set(days.flatMap((one) => one.paidBy));
  const dates = [...new Set(input.pay.payouts.filter((one) => by.has(one.document)).map((one) => one.date))].sort();
  const when = dates.length === 0 ? "" : ` ${dates.map(dayWords).join(", ")}`;
  let payout: SaleChainLink;
  if (effectiveBasis === "hub") {
    const dayPay = unpaid <= 0
      ? `день по модели ${input.model} оплачен полностью${when}`
      : paid > 0
        ? `день по модели ${input.model} оплачен частично${when}, остальное к выплате${input.sums.pay ? `: ${money(unpaid)}` : ""}`
        : `день по модели ${input.model} к выплате${input.sums.pay ? `: ${money(unpaid)}` : ""}`;
    const lineWords = input.hubReport !== null
      ? `в версии ${input.hubReport.version} — ${hubStatusWords(input.hubReport.status)}`
      : "этой продажи нет в сданном отчёте";
    const state: SaleChainLink["state"] = input.hubReport === null
      ? "wait"
      : input.hubReport.status === "disputed"
        ? "open"
        : input.hubReport.status === "zero"
          ? "none"
          : unpaid <= 0 ? "done" : "wait";
    payout = { state, words: `${lineWords}; ${dayPay}`, link: input.link, amountMills: input.sums.pay && paid > 0 ? paid : null };
  } else if (unpaid <= 0) {
    const whenNote = dates.length === 0 ? "" : ` (${dates.map(dayWords).join(", ")})`;
    payout = { state: "unknown", words: `день оплачен, включение этой продажи не подтверждено${whenNote}`, link: input.link, amountMills: input.sums.pay && paid > 0 ? paid : null };
  } else if (paid > 0) {
    payout = { state: "wait", words: `день оплачен частично${when}, остальное к выплате${input.sums.pay ? `: ${money(unpaid)}` : ""}; включение этой продажи не подтверждено`, link: input.link, amountMills: input.sums.pay ? paid : null };
  } else {
    payout = { state: "wait", words: `день к выплате${input.sums.pay ? `: ${money(unpaid)}` : ""}; включение этой продажи не подтверждено`, link: input.link, amountMills: null };
  }
  return { accrual, payout };
}

/** «Начисление» and «Выплата» of another person for a reader who sees no pay but their own (a team lead). */
const OWNER_ONLY: SaleChainLink = { state: "none", words: "видит только владелец", link: null, amountMills: null };

/** A link of the test realm's sale: the ledger is never asked about the test team (sandbox/realm.ts). */
export const TEST_REALM_NO_MONEY: SaleChainLink = { state: "none", words: "в тестовой команде денег нет", link: null, amountMills: null };

// ── The read ─────────────────────────────────────────────────────────────────

function unknownWords(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/not connected/u.test(message)) return "ledger не подключён";
  if (/no payout tab/u.test(message)) return "в ledger нет вкладки этого человека";
  return "ledger не ответил";
}

/** `saleChain`, `agentSaleChain`: a sale's chain as the reader may see it; another sale is 404. */
export async function readSaleChain(
  app: ChainApp,
  viewer: ChainViewer,
  query: { saleId?: number | undefined; pageLabel?: string | undefined; transactionRef?: string | undefined },
  options: {
    fetchImpl?: typeof fetch;
    now?: Date;
    /** A person's session: the sale must be of their realm (else 404), and a test realm's sale asks the ledger nothing. */
    realmOf?: AuthPrincipal;
  } = {},
): Promise<SaleChainResponse> {
  const { db } = app;
  const now = options.now ?? new Date();
  const id = query.saleId ?? (query.pageLabel !== undefined && query.transactionRef !== undefined
    ? await findSaleIdByPlatformRef(db, { pageLabel: query.pageLabel, transactionRef: query.transactionRef })
    : null);
  if (id === null) throw notFound();
  if (options.realmOf !== undefined) await requireSalesOfRealm(app, options.realmOf, [id]);
  const testRealm = options.realmOf !== undefined && realmOf(options.realmOf) === "test";
  const sale = (await listHandinSalesByIds(db, [id]))[0];
  if (sale === undefined) throw notFound();

  // Who may see it: the owner every sale; the others a sale of their pages; a chatter only one of theirs.
  const people = sale.home === null ? [] : [...new Set(sale.home.shares.map((share) => share.userId))];
  const reports = await listCurrentReportsOfSales(db, [sale.transactionId]);
  const claims = (await listSaleClaims(db, { transactionIds: [sale.transactionId] })).filter((claim) => claim.state !== "withdrawn");
  let ownLogins: number[] = [];
  if (viewer.kind !== "owner" && !viewer.pageIds.includes(sale.pageId)) throw notFound();
  if (viewer.kind === "chatter" || viewer.kind === "team_lead") {
    if (viewer.userId !== undefined) {
      const person = (await listHandinPeopleOfUsers(db, [viewer.userId])).get(viewer.userId);
      ownLogins = [...new Set([viewer.userId, ...(person?.userIds ?? [])])];
    }
    const mine = (id2: number | null) => id2 !== null && ownLogins.includes(id2);
    const hasOwnLineOrClaim = reports.some((report) => mine(report.userId))
      || claims.some((claim) => mine(claim.claimantUserId) || mine(claim.sideUserId));
    // Nobody's sales are hidden from chatters and team leads (H8), unless they already have their own handed-in line
    // or non-withdrawn claim referencing this sale.
    if (isTeamHiddenSaleHome(sale.home?.home)) {
      if (!hasOwnLineOrClaim) throw notFound();
    } else if (viewer.kind === "chatter") {
      const involved = people.some(mine)
        || hasOwnLineOrClaim
        || await shiftOfUsersHoldsSale(db, { userIds: ownLogins, pageLabel: sale.pageLabel, at: sale.occurredAt });
      if (!involved) throw notFound();
    }
  }

  const decision = (await listActiveSaleDecisions(db, [sale.transactionId])).get(sale.transactionId) ?? null;
  const names = await listHandinNames(db, [...people, ...claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((one): one is number => one !== null)),
    ...(decision?.shares.map((share) => share.userId) ?? [])]);
  const home = homeLinkOf({ sale, names, decision, claims, ownerReads: viewer.kind === "owner" });

  // The people the home gives a share: a chatter only their own.
  const shown = viewer.kind === "chatter" ? people.filter((userId) => ownLogins.includes(userId)) : people;
  const codes = await listHandinPeopleOfUsers(db, shown);
  const ownPay = viewer.kind === "chatter" ? await findOwnPayPerson(db, viewer.userId) : null;
  const reportsByDate = new Map<string, TeamLedgerReportsResponse | Error>();
  const readReports = async (date: string) => {
    if (!reportsByDate.has(date)) {
      try {
        reportsByDate.set(date, await readTeamLedgerReports(app, { from: date, to: date }, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now }));
      } catch (error) {
        reportsByDate.set(date, error instanceof Error ? error : new Error(String(error)));
      }
    }
    return reportsByDate.get(date)!;
  };

  let allModels: HubModel[] | null = null;
  const out: SaleChainResponse["people"] = [];
  for (const userId of shown) {
    const share = sale.home!.shares.find((one) => one.userId === userId)!;
    const own = viewer.kind === "chatter";
    const sums: ChainSums = {
      share: true,
      hubLine: true,
      post: viewer.kind === "owner" || own,
      pay: viewer.kind === "owner" || (own && ownPay?.seesOwnPaySince != null),
    };
    const shift = share.shiftId === null ? null : await findHandinShift(db, share.shiftId);
    const person = codes.get(userId) ?? null;
    const logins = person?.userIds ?? [userId];
    // Отчёт: Hub's handed-in version holding the sale first, else the ledger's report of the day.
    const handedIn = reports.filter((report) => logins.includes(report.userId)).at(-1) ?? null;
    const reportDate = chainReportDateOf({ handedIn, decision, logins, shift, occurredAt: sale.occurredAt });
    let report: SaleChainLink;
    let model: string | null = null;
    let basis: string | null = null;
    let reportsUnknown: string | null = null;
    const postLink = viewer.kind === "owner" ? `/workboard/money/reports` : own ? "/workboard/shifts/mine" : null;
    // Read the ledger's report day on Hub-basis days too (skipping team leads who read no pay, and the test realm)
    // so `payLinksOf` gets the exact model and `pages[].basis` for the sale's page.
    const needReports = !testRealm && person !== null && (handedIn === null || viewer.kind !== "team_lead");
    const read = needReports ? await readReports(reportDate) : null;
    let reportDay: TeamLedgerReportDay | null = null;
    if (read instanceof Error) {
      reportsUnknown = unknownWords(read);
    } else if (read !== null && person !== null) {
      ({ day: reportDay, model, basis } = reportPageMetaOf(read, { personCode: person.code, reportDate, pageLabel: sale.pageLabel }));
    }
    if (handedIn !== null) {
      report = hubReportLinkOf({ report: handedIn, transactionId: sale.transactionId, own, sums });
    } else if (testRealm) {
      report = TEST_REALM_NO_MONEY;
    } else if (person === null) {
      report = { state: "unknown", words: "неизвестно: вход не связан с человеком в реестре, ledger его не знает", link: null, amountMills: null };
    } else if (read instanceof Error) {
      report = { state: "unknown", words: `неизвестно: ${reportsUnknown}`, link: postLink, amountMills: null };
    } else {
      report = postReportLinkOf({ day: reportDay, posts: read!.posts, pageLabel: sale.pageLabel, reportDate, sums, link: postLink });
    }

    // Начисление, Выплата: the ledger's day of the person; read up to a month on, so the payout that paid it is in.
    // Another person's pay is the owner's to see (an agent with read:money its states): a team lead's read asks nothing.
    let accrual = OWNER_ONLY;
    let payout = OWNER_ONLY;
    if (testRealm) {
      accrual = TEST_REALM_NO_MONEY;
      payout = TEST_REALM_NO_MONEY;
    } else if (viewer.kind !== "team_lead") {
      let pay: TeamLedgerPayoutPersonResponse | null = null;
      let why: string | null = null;
      if (person === null) {
        why = "вход не связан с человеком в реестре";
      } else {
        const today = moscowToday(now);
        const monthOn = new Date(Date.parse(`${reportDate}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
        const until = today < monthOn ? today : monthOn;
        const payTo = until < reportDate ? reportDate : until;
        try {
          pay = await readTeamLedgerPayoutPerson(app, { person: person.code, from: reportDate, to: payTo }, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now });
        } catch (error) {
          why = unknownWords(error);
        }
      }
      if (pay !== null && model === null && reportsUnknown === null
        && pay.days.some((one) => one.date === reportDate && (one.source === "sheet" || one.source === "facts"))) {
        allModels ??= await listAdminModels(db);
        model = nonReportDayModelOf({
          days: pay.days, reportDate, saleModel: { slug: sale.modelSlug, name: sale.modelName }, models: allModels,
        });
      }
      const payLink = viewer.kind === "owner" && person !== null ? `/workboard/money/debts?person=${encodeURIComponent(person.code)}` : own ? "/workboard/money/mine" : null;
      ({ accrual, payout } = payLinksOf({
        pay, unknown: why, reportDate, model, basis, hubReport: hubReportEvidenceOf(handedIn, sale.transactionId), reportsUnknown, sums, link: payLink,
      }));
    }
    out.push({
      userId,
      name: names.get(userId) ?? person?.displayName ?? `#${userId}`,
      shareMills: sums.share ? sale.home!.shares.filter((one) => one.userId === userId).reduce((sum, one) => sum + one.mills, 0) : null,
      reportDate,
      shift: shiftLinkOf({ shift, workRef: share.workRef, own, transactionId: sale.transactionId, kind: sale.home!.home }),
      report,
      accrual,
      payout,
    });
  }

  let note: string | null = null;
  if (sale.home === null || people.length === 0) {
    switch (sale.home?.home) {
      case "pot": note = "общак: делится в ledger между участниками общака, по человеку здесь не показан"; break;
      case "nobody": note = "ничья: ни в чей отчёт не входит, пока её не заявят"; break;
      case "waiting": note = "PPV ждёт смены отправителя: цепочка продолжится после неё"; break;
      case "decide": note = "пока владелец не решит, продажа ни в чей отчёт не входит"; break;
      // Before the rule, «Чья» says it already.
      default: note = null;
    }
  } else if (viewer.kind === "chatter" && shown.length === 0) {
    note = "продажа не ваша по правилу: отчёты и деньги других людей вам не видны";
  }

  return {
    sale: {
      transactionId: sale.transactionId,
      pageLabel: sale.pageLabel,
      platform: sale.platform,
      kind: sale.kind,
      occurredAt: sale.occurredAt.toISOString(),
      netMills: sale.netMills,
      fan: sale.fan,
    },
    home,
    people: out,
    note,
    serverNow: now.toISOString(),
  };
}
