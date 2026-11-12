import type {
  SaleChainLink,
  SaleChainResponse,
  TeamLedgerPayoutPersonResponse,
  TeamLedgerReportDay,
  TeamLedgerReportsResponse,
} from "@agency_hub_core/contracts";
import { formatDateTime } from "@agency_hub_core/look";
import { formatUsdFromMills } from "@agency_hub_core/shared";
import {
  findHandinShift,
  findOwnPayPerson,
  findSaleIdByPlatformRef,
  listActiveSaleDecisions,
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
import { NotFoundError } from "./errors.ts";
import { readTeamLedgerPayoutPerson } from "./ledger-person-pay.ts";
import { readTeamLedgerReports } from "./ledger-team-reports.ts";
import { SALE_HOME_REASON_TEXT, SALE_RULE, type SaleHomeReason } from "./sale-rule.ts";
import { dayWords, shiftWords } from "./shift-handin-rules.ts";

/**
 * Цепочка продажи (ecosystem plan 2026-11-12, package T): from one sale, where its money is — whose it is (the home of
 * the one rule, the owner's decision or the agreement above it, an open claim), the shift the home names, the
 * person's report of that day (Hub's handed-in version holding the sale, else the ledger's post of the day), and the
 * ledger's accrual and payout of that person's day. Read only; nothing is computed anew: `sale_homes`, the shift rows,
 * the handed-in versions, and the ledger's reads «Выплаты → Отчёты» and the payout panel already make. A source that
 * does not answer is «неизвестно» with why, never a guess.
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
  | { kind: "team_lead"; pageIds: readonly number[] }
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
  silenceMs: number;
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
      : `спор открыт: ждёт ответа ${open.sideUserId === null ? "второй стороны" : nameOf(open.sideUserId)} до ${formatDateTime(new Date(open.createdAt.getTime() + input.silenceMs).toISOString())}`;
  }
  return {
    state,
    words,
    link: open !== undefined && input.ownerReads ? `/workboard/decisions?dispute=${sale.transactionId}#questions` : null,
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
  const path = input.own ? `/workboard/my/shifts/${shift.id}?sale=${input.transactionId}` : `/workboard/shifts/report/${shift.id}?sale=${input.transactionId}`;
  return { state: shift.state === "going" ? "wait" : "done", words: `смена ${shiftWords(shift.startedAt, shift.endedAt)}${shift.state === "going" ? ", идёт" : ""}`, link: path, amountMills: null };
}

/** The report's link from Hub's handed-in version holding the sale. Pure. */
export function hubReportLinkOf(input: { report: CurrentReport; transactionId: number; own: boolean; sums: ChainSums }): SaleChainLink {
  const line = input.report.lines.find((one) => one.transactionId === input.transactionId)!;
  const counted = line.amountMills > 0 ? `засчитано ${money(line.amountMills)}` : "в отчёте с нулём";
  const statement = line.statement === "not_mine" ? ", «не моё»" : line.statement === "share" ? ", «делим»" : line.statement === "mine" ? ", «моё»" : "";
  const path = input.own ? `/workboard/my/shifts/${input.report.shiftId}?sale=${input.transactionId}` : `/workboard/shifts/report/${input.report.shiftId}?sale=${input.transactionId}`;
  return {
    state: line.disputed ? "open" : "done",
    words: `сдан в системе: версия ${input.report.version}, ${formatDateTime(input.report.submittedAt.toISOString())}; ${input.sums.hubLine ? counted : line.amountMills > 0 ? "засчитана" : "не засчитана"}${statement}${line.disputed ? ", спорная" : ""}`,
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

/** «Начисление» and «Выплата» from the ledger's day of the person (the sale's model when the day has several). Pure. */
export function payLinksOf(input: {
  pay: Pick<TeamLedgerPayoutPersonResponse, "days" | "payouts" | "reportsFrom"> | null;
  /** Why the ledger is not read: not connected, did not answer, has no tab of the person. */
  unknown: string | null;
  reportDate: string;
  model: string | null;
  sums: ChainSums;
  link: string | null;
}): { accrual: SaleChainLink; payout: SaleChainLink } {
  if (input.pay === null) {
    const words = `неизвестно: ${input.unknown ?? "ledger не ответил"}`;
    return { accrual: { state: "unknown", words, link: input.link, amountMills: null }, payout: { state: "unknown", words, link: input.link, amountMills: null } };
  }
  const date = dayWords(input.reportDate);
  const ofDay = input.pay.days.filter((one) => one.date === input.reportDate);
  const ofModel = input.model === null ? [] : ofDay.filter((one) => one.model === input.model);
  const days = ofModel.length > 0 ? ofModel : ofDay;
  const accrued = days.reduce((sum, one) => sum + one.amountMills, 0);
  const paid = days.reduce((sum, one) => sum + one.paidMills, 0);
  const unpaid = days.reduce((sum, one) => sum + one.unpaidMills, 0);
  if (accrued <= 0) {
    const notYet = input.pay.reportsFrom !== null && input.reportDate >= input.pay.reportsFrom;
    return {
      accrual: { state: "wait", words: notYet ? `за ${date} пока не начислено: ledger начисляет по отчёту дня` : `за ${date} не начислено`, link: input.link, amountMills: null },
      payout: { state: "none", words: "платить пока нечего", link: input.link, amountMills: null },
    };
  }
  const accrual: SaleChainLink = {
    state: "done",
    words: `начислено за ${date}${input.sums.pay ? `: ${money(accrued)} за день` : ", за день целиком"}`,
    link: input.link,
    amountMills: input.sums.pay ? accrued : null,
  };
  const by = new Set(days.flatMap((one) => one.paidBy));
  const dates = [...new Set(input.pay.payouts.filter((one) => by.has(one.document)).map((one) => one.date))].sort();
  const when = dates.length === 0 ? "" : ` ${dates.map(dayWords).join(", ")}`;
  let payout: SaleChainLink;
  if (unpaid <= 0) payout = { state: "done", words: `оплачено${when}`, link: input.link, amountMills: input.sums.pay ? paid : null };
  else if (paid > 0) payout = { state: "wait", words: `оплачено частично${when}, остальное к выплате${input.sums.pay ? `: ${money(unpaid)}` : ""}`, link: input.link, amountMills: input.sums.pay ? paid : null };
  else payout = { state: "wait", words: `к выплате${input.sums.pay ? `: ${money(unpaid)}` : ""}`, link: input.link, amountMills: null };
  return { accrual, payout };
}

/** «Начисление» and «Выплата» of another person for a reader who sees no pay but their own (a team lead). */
const OWNER_ONLY: SaleChainLink = { state: "none", words: "видит только владелец", link: null, amountMills: null };

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
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<SaleChainResponse> {
  const { db } = app;
  const now = options.now ?? new Date();
  const id = query.saleId ?? (query.pageLabel !== undefined && query.transactionRef !== undefined
    ? await findSaleIdByPlatformRef(db, { pageLabel: query.pageLabel, transactionRef: query.transactionRef })
    : null);
  if (id === null) throw notFound();
  const sale = (await listHandinSalesByIds(db, [id]))[0];
  if (sale === undefined) throw notFound();

  // Who may see it: the owner every sale; the others a sale of their pages; a chatter only one of theirs.
  const people = sale.home === null ? [] : [...new Set(sale.home.shares.map((share) => share.userId))];
  const reports = await listCurrentReportsOfSales(db, [sale.transactionId]);
  const claims = (await listSaleClaims(db, { transactionIds: [sale.transactionId] })).filter((claim) => claim.state !== "withdrawn");
  let ownLogins: number[] = [];
  if (viewer.kind !== "owner" && !viewer.pageIds.includes(sale.pageId)) throw notFound();
  if (viewer.kind === "chatter") {
    const person = (await listHandinPeopleOfUsers(db, [viewer.userId])).get(viewer.userId);
    ownLogins = [...new Set([viewer.userId, ...(person?.userIds ?? [])])];
    const mine = (id2: number | null) => id2 !== null && ownLogins.includes(id2);
    const involved = people.some(mine)
      || reports.some((report) => mine(report.userId))
      || claims.some((claim) => mine(claim.claimantUserId) || mine(claim.sideUserId))
      || await shiftOfUsersHoldsSale(db, { userIds: ownLogins, pageLabel: sale.pageLabel, at: sale.occurredAt });
    if (!involved) throw notFound();
  }

  const decision = (await listActiveSaleDecisions(db, [sale.transactionId])).get(sale.transactionId) ?? null;
  const names = await listHandinNames(db, [...people, ...claims.flatMap((claim) => [claim.claimantUserId, claim.sideUserId].filter((one): one is number => one !== null)),
    ...(decision?.shares.map((share) => share.userId) ?? [])]);
  const home = homeLinkOf({ sale, names, decision, claims, ownerReads: viewer.kind === "owner", silenceMs: 24 * 3_600_000 });

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
    const reportDate = shift?.reportDate ?? new Date(sale.occurredAt.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
    const person = codes.get(userId) ?? null;
    const logins = person?.userIds ?? [userId];

    // Отчёт: Hub's handed-in version holding the sale first, else the ledger's report of the day.
    const handedIn = reports.filter((report) => logins.includes(report.userId)).at(-1) ?? null;
    let report: SaleChainLink;
    let model: string | null = null;
    const postLink = viewer.kind === "owner" ? `/workboard/payouts?view=reports` : own ? "/workboard/my/shifts" : null;
    if (handedIn !== null) {
      report = hubReportLinkOf({ report: handedIn, transactionId: sale.transactionId, own, sums });
    } else if (person === null) {
      report = { state: "unknown", words: "неизвестно: вход не связан с человеком в реестре, ledger его не знает", link: null, amountMills: null };
    } else {
      const read = await readReports(reportDate);
      if (read instanceof Error) {
        report = { state: "unknown", words: `неизвестно: ${unknownWords(read)}`, link: postLink, amountMills: null };
      } else {
        const day = read.reports.find((one) => one.person.slug === person.code && one.reportDate === reportDate) ?? null;
        model = day?.pages.find((one) => one.pageLabel === sale.pageLabel)?.model ?? null;
        report = postReportLinkOf({ day, posts: read.posts, pageLabel: sale.pageLabel, reportDate, sums, link: postLink });
      }
    }

    // Начисление, Выплата: the ledger's day of the person; read up to a month on, so the payout that paid it is in.
    // Another person's pay is the owner's to see (an agent with read:money its states): a team lead's read asks nothing.
    let accrual = OWNER_ONLY;
    let payout = OWNER_ONLY;
    if (viewer.kind !== "team_lead") {
      let pay: TeamLedgerPayoutPersonResponse | null = null;
      let why: string | null = null;
      if (person === null) {
        why = "вход не связан с человеком в реестре";
      } else {
        const today = new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);
        const monthOn = new Date(Date.parse(`${reportDate}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10);
        const until = today < monthOn ? today : monthOn;
        const payTo = until < reportDate ? reportDate : until;
        try {
          pay = await readTeamLedgerPayoutPerson(app, { person: person.code, from: reportDate, to: payTo }, { ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}), now });
        } catch (error) {
          why = unknownWords(error);
        }
      }
      const payLink = viewer.kind === "owner" && person !== null ? `/workboard/payouts?person=${encodeURIComponent(person.code)}` : own ? "/workboard/my/shifts" : null;
      ({ accrual, payout } = payLinksOf({ pay, unknown: why, reportDate, model, sums, link: payLink }));
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
