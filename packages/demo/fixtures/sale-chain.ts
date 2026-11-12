import type { SaleChainLink, SaleChainResponse } from "@agency_hub_core/contracts";
import { formatUsdFromMills } from "@agency_hub_core/shared";

import { demoError, hashString, queryString, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import { DEMO_USERS, demoPage, demoUserByRole, type DemoFan, type DemoUser } from "../world.ts";
import { DAY_MS, HOUR_MS, addDays, mskDay } from "./account-model.ts";
import { HISTORY_DAYS, ledgerRange } from "./money-ledger.ts";
import { fanTransactions, pagePopulation } from "./page-world.ts";
import { demoClaimsOfSale } from "./sale-claims.ts";
import { demoChainShifts, type DemoChainShift } from "./shift-reports.ts";
import { demoPersonPay } from "./team-ledger.ts";

/**
 * Цепочка продажи (ecosystem package T) in the demo: `saleChain` from the demo's own facts, the way Hub reads it.
 *  - A Workboard line (by Hub's id): whose it is from the shifts' lines of that sale (the rule's reason, a settled
 *    claim, an open one), each person's shift, their report (the handed-in version holding it, or the post of a day
 *    before the switch), and their day in the ledger's book (team-ledger.ts).
 *  - A console row (by the page and the platform's id): the shift that held the page at that moment, or nobody's;
 *    a sale before 2 Nov is the old way.
 * The rights are Hub's: the owner every sale with the pay sums; the chatter only a sale of their own shifts, their own
 * person, their sums (the scenario `pay-off` hides them); a team lead their pages, nobody's pay. Лена has no payout tab
 * in the book: her links say «неизвестно».
 *
 * Invented data only.
 */

type Chain = SaleChainResponse;
type Link = SaleChainLink;

const MSK = "Europe/Moscow";
const DAY_MONTH = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", timeZone: MSK });
const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: MSK });
const dayWords = (day: string) => DAY_MONTH.format(new Date(`${day}T12:00:00+03:00`));
const when = (at: number | string) => `${DAY_MONTH.format(new Date(at))}, ${CLOCK.format(new Date(at))}`;
const money = (mills: number) => formatUsdFromMills(mills);

/** The rule's first day (sale-rule.ts `SALE_RULE.since`). */
const RULE_SINCE = Date.parse("2026-11-02T00:00:00+03:00");
const SWITCH_DAYS = 5;
const SALE_KINDS = new Set(["subscription", "tip", "message_purchase", "post_purchase", "stream_tip"]);
const SETTLED = new Set(["agreed", "owner_split"]);

const REASONS: Readonly<Record<string, string>> = {
  holder: "страницу держала одна смена",
  last_writer: "держали несколько смен, последним фану писал он",
  ppv_sender: "PPV отправителя, его смена",
  no_holder: "страницу никто не держал",
  no_last_writer: "держали несколько смен, последним не писал никто из них",
  owner_split: "раздел владельца",
  owner_nobody: "владелец решил: никому",
  agreed: "по согласию: тот, чья она по правилу, согласился",
  sale_before_rule: "продажа до правила",
};

type Viewer = { kind: "owner" } | { kind: "team_lead"; user: DemoUser } | { kind: "chatter"; user: DemoUser };

interface Sale {
  transactionId: number;
  pageLabel: string;
  platform: string;
  kind: string;
  occurredAt: number;
  netMills: number;
  fan: Chain["sale"]["fan"];
}

interface Home {
  kind: "shift" | "nobody" | "decide" | "before_rule";
  reason: string;
  shares: Array<{ user: DemoUser; mills: number; shift: DemoChainShift | null }>;
}

const notFound = () => demoError(404, "Not Found", "No such sale");
const fanOf = (fan: Pick<DemoFan, "platformUserId" | "username" | "displayName"> | null, name?: string | null): Chain["sale"]["fan"] =>
  ({ fanRef: fan?.platformUserId ?? null, name: name ?? fan?.displayName ?? null, username: fan?.username ?? null });

function viewerOf(request: DemoRequest): Viewer {
  const user = demoUserByRole(request.role);
  return user.role === "owner" ? { kind: "owner" } : user.role === "team_lead" ? { kind: "team_lead", user } : { kind: "chatter", user };
}

/** Whose a sale of the shifts' lines is: the people the rule (or a settled claim) gives it, else why nobody's. */
function homeOfLines(entries: DemoChainShift[], sale: Sale, now: Date): Home {
  if (sale.occurredAt < RULE_SINCE) return { kind: "before_rule", reason: "sale_before_rule", shares: [] };
  const shares: Home["shares"] = [];
  for (const entry of entries) {
    const line = entry.line!;
    if (line.group !== "mine" || (line.added && !SETTLED.has(line.rule.reason)) || shares.some((one) => one.user.id === entry.owner.id)) continue;
    const mills = SETTLED.has(line.rule.reason) ? line.amountMills : line.rule.shareMills;
    if (mills > 0) shares.push({ user: entry.owner, mills, shift: entry });
  }
  if (shares.length > 0) return { kind: "shift", reason: shares[0]!.shift!.line!.rule.reason, shares };
  const lines = entries.map((entry) => entry.line!);
  if (lines.some((line) => line.rule.reason === "owner_nobody")) return { kind: "nobody", reason: "owner_nobody", shares: [] };
  if (lines.some((line) => line.rule.home === "decide")) return { kind: "decide", reason: "no_last_writer", shares: [] };
  const to = lines.map((line) => DEMO_USERS.find((user) => user.id === line.rule.toUserId)).find((user): user is DemoUser => user !== undefined);
  if (to === undefined) return { kind: "nobody", reason: "no_holder", shares: [] };
  const held = demoChainShifts(now, { pageLabel: sale.pageLabel, at: sale.occurredAt }).find((entry) => entry.owner.id === to.id) ?? null;
  return { kind: "shift", reason: lines[0]!.rule.reason, shares: [{ user: to, mills: sale.netMills, shift: held }] };
}

/** Whose a console row's sale is: the shift that held the page then (the last writer of several), else nobody's. */
function homeOfMoment(sale: Sale, now: Date): Home {
  if (sale.occurredAt < RULE_SINCE) return { kind: "before_rule", reason: "sale_before_rule", shares: [] };
  const held = demoChainShifts(now, { pageLabel: sale.pageLabel, at: sale.occurredAt });
  if (held.length === 0) return { kind: "nobody", reason: "no_holder", shares: [] };
  const one = held[hashString(String(sale.transactionId)) % held.length]!;
  return { kind: "shift", reason: held.length === 1 ? "holder" : "last_writer", shares: [{ user: one.owner, mills: sale.netMills, shift: one }] };
}

function homeLink(home: Home, sale: Sale, now: Date, viewer: Viewer): Chain["home"] {
  const reason = REASONS[home.reason] ?? home.reason;
  const who = home.shares.map((share) => (home.shares.length > 1 ? `${share.user.name} ${money(share.mills)}` : share.user.name)).join(", ");
  let state: Link["state"] = "done";
  let words = `${who}: ${reason}`;
  if (home.kind === "nobody") [state, words] = ["none", `ничья: ${reason}`];
  if (home.kind === "decide") [state, words] = ["open", `решает владелец: ${reason}`];
  if (home.kind === "before_rule") [state, words] = ["none", "продажа до правила (раньше 2 нояб.): считается по-старому, постами"];
  const claims = demoClaimsOfSale(now, sale.transactionId);
  let above: string | null = null;
  const decided = claims.find((claim) => claim.state === "decided");
  if (decided !== undefined) {
    const to = decided.outcome === "nobody" ? "никому" : decided.outcome === "half" ? `${decided.claimant.name} 50% и ${decided.side.name} 50%`
      : decided.outcome === "first" ? decided.claimant.name : decided.side.name;
    above = `решение владельца: ${to}`;
  } else if (claims.some((claim) => claim.state === "agreed")) {
    above = "по согласию сторон";
  }
  const open = claims.find((claim) => claim.state === "owner") ?? claims.find((claim) => claim.state === "asked");
  let dispute: string | null = null;
  if (open !== undefined) {
    state = "open";
    dispute = open.state === "owner" ? "спор открыт: решает владелец" : `спор открыт: ждёт ответа ${open.side.name} до ${when(open.createdAt + 24 * HOUR_MS)}`;
  }
  return {
    state, words, link: open !== undefined && viewer.kind === "owner" ? `/workboard/decisions?dispute=${sale.transactionId}#questions` : null,
    amountMills: null, kind: home.kind, reason, above, dispute,
  };
}

/** «Начисление» and «Выплата» from the person's day in the ledger's book, as Hub's `payLinksOf` reads it. */
function payLinks(user: DemoUser, reportDate: string, pay: boolean, link: string | null, now: Date): { accrual: Link; payout: Link } {
  // Up to a month on, as Hub reads it: the payout that paid the day is in.
  const until = [mskDay(now.getTime()), addDays(reportDate, 30)].sort()[0]!;
  const book = demoPersonPay(user.username, reportDate, until < reportDate ? reportDate : until, now);
  if (book === null) {
    const words = "неизвестно: в ledger нет вкладки этого человека";
    return { accrual: { state: "unknown", words, link, amountMills: null }, payout: { state: "unknown", words, link, amountMills: null } };
  }
  const date = dayWords(reportDate);
  const days = book.days.filter((one) => one.date === reportDate);
  const accrued = days.reduce((sum, one) => sum + one.amountMills, 0);
  const paid = days.reduce((sum, one) => sum + one.paidMills, 0);
  const unpaid = days.reduce((sum, one) => sum + one.unpaidMills, 0);
  if (accrued <= 0) {
    return {
      accrual: { state: "wait", words: `за ${date} пока не начислено: ledger начисляет по отчёту дня`, link, amountMills: null },
      payout: { state: "none", words: "платить пока нечего", link, amountMills: null },
    };
  }
  const by = new Set(days.flatMap((one) => one.paidBy));
  const dates = [...new Set(book.payouts.filter((one) => by.has(one.document)).map((one) => one.date))].sort();
  const on = dates.length === 0 ? "" : ` ${dates.map(dayWords).join(", ")}`;
  const accrual: Link = { state: "done", words: `начислено за ${date}${pay ? `: ${money(accrued)} за день` : ", за день целиком"}`, link, amountMills: pay ? accrued : null };
  if (unpaid <= 0) return { accrual, payout: { state: "done", words: `оплачено${on}`, link, amountMills: pay ? paid : null } };
  if (paid > 0) return { accrual, payout: { state: "wait", words: `оплачено частично${on}, остальное к выплате${pay ? `: ${money(unpaid)}` : ""}`, link, amountMills: pay ? paid : null } };
  return { accrual, payout: { state: "wait", words: `к выплате${pay ? `: ${money(unpaid)}` : ""}`, link, amountMills: null } };
}

function person(share: Home["shares"][number], sale: Sale, home: Home, viewer: Viewer, request: DemoRequest): Chain["people"][number] {
  const own = viewer.kind === "chatter";
  const sums = { post: viewer.kind === "owner" || own, pay: viewer.kind === "owner" || (own && request.scenario !== "pay-off") };
  const entry = share.shift;
  const reportDate = entry?.reportDate ?? mskDay(sale.occurredAt);
  const date = dayWords(reportDate);
  const reportPath = entry === null ? null : own ? `/workboard/my/shifts/${entry.id}?sale=${sale.transactionId}` : `/workboard/shifts/report/${entry.id}?sale=${sale.transactionId}`;
  const shift: Link = entry === null
    ? { state: "none", words: home.reason === "owner_split" ? "без смены: продажа отдана решением или заявкой" : "смены нет", link: null, amountMills: null }
    : {
      state: entry.shift.ongoing ? "wait" : "done",
      words: `смена ${DAY_MONTH.format(new Date(entry.shift.start))}, ${CLOCK.format(new Date(entry.shift.start))}–${CLOCK.format(new Date(entry.shift.end))}${entry.shift.ongoing ? ", идёт" : ""}`,
      link: reportPath, amountMills: null,
    };
  const postLink = viewer.kind === "owner" ? "/workboard/payouts?view=reports" : own ? "/workboard/my/shifts" : null;
  let report: Link;
  // A console row's sale names no line of the demo's shifts: the shift's version stands for the one holding it.
  const line = entry?.handed?.line ?? (entry !== null && entry.handed !== null && entry.line === null ? { amountMills: share.mills, statement: null, disputed: false } : null);
  if (entry !== null && entry.handed !== null && line !== null) {
    const counted = line.amountMills > 0 ? `засчитано ${money(line.amountMills)}` : "в отчёте с нулём";
    const said = line.statement === "not_mine" ? ", «не моё»" : line.statement === "share" ? ", «делим»" : line.statement === "mine" ? ", «моё»" : "";
    report = {
      state: line.disputed ? "open" : "done",
      words: `сдан: версия ${entry.handed.version}, ${when(entry.handed.submittedAt)}; ${counted}${said}${line.disputed ? ", спорная" : ""}`,
      link: reportPath, amountMills: line.amountMills,
    };
  } else if (entry !== null && entry.back > SWITCH_DAYS) {
    const page = entry.pages.find((one) => one.pageLabel === sale.pageLabel)?.amountMills ?? null;
    report = {
      state: "done",
      words: `пост за ${date} отправлен${sums.post && page !== null ? `: ${sale.pageLabel} ${money(page)}` : ""}; пост не перечисляет продажи по одной`,
      link: postLink, amountMills: sums.post ? page : null,
    };
  } else {
    report = { state: "wait", words: `отчёта за ${date} в ledger пока нет`, link: postLink, amountMills: null };
  }
  // Another person's pay is the owner's to see: a team lead reads neither its sums nor its states.
  if (viewer.kind === "team_lead") {
    const ownerOnly: Link = { state: "none", words: "видит только владелец", link: null, amountMills: null };
    return { userId: share.user.id, name: share.user.name, shareMills: share.mills, reportDate, shift, report, accrual: ownerOnly, payout: ownerOnly };
  }
  const payLink = viewer.kind === "owner" ? `/workboard/payouts?person=${encodeURIComponent(share.user.username)}` : own ? "/workboard/my/shifts" : null;
  return { userId: share.user.id, name: share.user.name, shareMills: share.mills, reportDate, shift, report, ...payLinks(share.user, reportDate, sums.pay, payLink, request.now) };
}

function chainOf(request: DemoRequest, viewer: Viewer, sale: Sale, home: Home, involved: boolean): Chain | DemoReply {
  if (viewer.kind !== "owner" && !viewer.user.pages.includes(sale.pageLabel)) return notFound();
  if (viewer.kind === "chatter" && !involved) return notFound();
  const shown = viewer.kind === "chatter" ? home.shares.filter((share) => share.user.id === viewer.user.id) : home.shares;
  let note: string | null = null;
  if (home.shares.length === 0) {
    note = home.kind === "nobody" ? "ничья: ни в чей отчёт не входит, пока её не заявят"
      : home.kind === "decide" ? "пока владелец не решит, продажа ни в чей отчёт не входит" : null;
  } else if (shown.length === 0) {
    note = "продажа не ваша по правилу: отчёты и деньги других людей вам не видны";
  }
  return {
    sale: { transactionId: sale.transactionId, pageLabel: sale.pageLabel, platform: sale.platform, kind: sale.kind, occurredAt: new Date(sale.occurredAt).toISOString(), netMills: sale.netMills, fan: sale.fan },
    home: homeLink(home, sale, request.now, viewer),
    people: shown.map((share) => person(share, sale, home, viewer, request)),
    note,
    serverNow: request.now.toISOString(),
  };
}

/** A console row's sale: the page's operations of the year, then its fans' histories. */
function consoleSale(now: Date, pageLabel: string, ref: string): Sale | null {
  const page = demoPage(pageLabel);
  if (page === undefined || page.platform === "telegram") return null;
  const transactionId = (hashString(`${pageLabel}:${ref}`) % 900_000_000) + 1;
  const tx = ledgerRange(page, now.getTime() - HISTORY_DAYS * DAY_MS, now.getTime() + 1, now).find((one) => one.id === ref);
  if (tx !== undefined) {
    return { transactionId, pageLabel, platform: page.platform, kind: tx.type, occurredAt: tx.occurredMs, netMills: tx.netMills, fan: fanOf(tx.fan) };
  }
  for (const item of pagePopulation(page)) {
    const found = fanTransactions(page, item.fan).find((one) => one.id === ref);
    if (found !== undefined) {
      return { transactionId, pageLabel, platform: page.platform, kind: found.type, occurredAt: now.getTime() - found.hoursAgo * HOUR_MS, netMills: found.netMills, fan: fanOf(item.fan) };
    }
  }
  return null;
}

export const saleChainHandlers: DemoHandlers = {
  saleChain: (request): Chain | DemoReply => {
    const viewer = viewerOf(request);
    const saleId = Number(queryString(request, "saleId") ?? Number.NaN);
    const pageLabel = queryString(request, "pageLabel");
    const ref = queryString(request, "transactionRef");
    if (Number.isSafeInteger(saleId) && saleId > 0) {
      const entries = demoChainShifts(request.now, { transactionId: saleId });
      const first = entries[0]?.line;
      if (first === undefined || first === null) return notFound();
      const sale: Sale = { transactionId: saleId, pageLabel: first.pageLabel, platform: first.platform, kind: first.kind, occurredAt: Date.parse(first.occurredAt), netMills: first.netMills, fan: first.fan };
      const me = viewer.kind === "chatter" ? viewer.user.id : null;
      const involved = entries.some((entry) => entry.owner.id === me)
        || demoClaimsOfSale(request.now, saleId).some((claim) => claim.claimant.id === me || claim.side.id === me)
        || (me !== null && demoChainShifts(request.now, { pageLabel: sale.pageLabel, at: sale.occurredAt }).some((entry) => entry.owner.id === me));
      return chainOf(request, viewer, sale, homeOfLines(entries, sale, request.now), involved);
    }
    if (pageLabel !== undefined && ref !== undefined) {
      const sale = consoleSale(request.now, pageLabel, ref);
      if (sale === null || !SALE_KINDS.has(sale.kind) || sale.netMills <= 0) return notFound();
      const home = homeOfMoment(sale, request.now);
      const me = viewer.kind === "chatter" ? viewer.user.id : null;
      const involved = demoChainShifts(request.now, { pageLabel: sale.pageLabel, at: sale.occurredAt }).some((entry) => entry.owner.id === me);
      return chainOf(request, viewer, sale, home, involved);
    }
    return demoError(400, "Bad Request", "name the sale: saleId, or pageLabel and transactionRef");
  },
};
