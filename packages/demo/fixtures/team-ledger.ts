import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsFromCents, millsPercentOf, millsToNumber, millsToWholeCents } from "@agency_hub_core/shared";

import { demoError, intBetween, queryString, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, DEMO_USERS } from "../world.ts";
import { demoReportPay } from "./team-reports.ts";
import { DAY, addDays, mskDay } from "./team-world.ts";

/**
 * Выплаты from the agency ledger (`teamLedgerPayouts`) in the invented agency:
 * every chatter works most days on their model's tab; the agency pays on
 * Mondays everything up to the Sunday before. Two people fall behind (one
 * unpaid for two weeks, one with a debt from before the ledger's start), one
 * person of the sheets has no Hub user, and one tab's «К выплате» differs from
 * the ledger's count — so every state of the screen shows. The days come from
 * the payout sheets, then (FACTS_FROM_DAYS back) from Hub's facts, then
 * (REPORTS_FROM_DAYS back) from the posted shift reports of team-reports.ts at
 * the tab's rate; one paid day whose post changed since waits for the owner.
 * The switch falls between the posts the ledger could not parse: the stranger's
 * (two or three days back) is after it and waits in «Решения», kate.v's and
 * olya.m's (a week and more back) are before it — history the sheets paid.
 */

type Answer = KernelOperationResponse<"teamLedgerPayouts">;
type Person = Answer["people"][number];

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The ledger's day-by-day accruals start here; the debt from before is one opening sum. */
const HISTORY_DAYS = 70;
/** Days back the accruals switched to Hub's facts, then to the posted reports. */
const FACTS_FROM_DAYS = 16;
const REPORTS_FROM_DAYS = 5;
/** The tab's rate on the posted report, percent. */
const RATE_PERCENT = 25;

interface LedgerPerson {
  slug: string;
  name: string;
  aliases: string[];
  status: string;
  model: string;
  /** Mondays this person was not paid on (counted back: 0 — the last one). */
  skippedPaydays: number;
  openingCents: number;
  /** «К выплате» of the tab minus the ledger's debt. */
  sheetDriftCents: number;
  /** «Не занесено»: empty days of the tab with Hub's money in the shift, their share in cents, days Hub did not prove. */
  unentered: { days: number; cents: number; unknown: number };
  /** A bonus the owner posted on the debt, days back, unpaid yet: a manual posting with its memo. */
  bonus?: { daysAgo: number; cents: number; memo: string };
}

function modelOf(pages: readonly string[]): string {
  const page = pages[0] ?? "mia-1";
  const name = page.split("-")[0] ?? "mia";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const PEOPLE: readonly LedgerPerson[] = [
  ...DEMO_CHATTERS.map((user): LedgerPerson => ({
    slug: user.username,
    name: user.name,
    aliases: [user.username],
    status: user.active ? "active" : "left",
    model: modelOf(user.pages),
    skippedPaydays: user.username === "den.s" ? 2 : 0,
    openingCents: user.username === "ivan.p" ? 4_250 : 0,
    sheetDriftCents: user.username === "kate.v" ? 1_250 : 0,
    unentered: user.username === "olya.m" ? { days: 3, cents: 9_640, unknown: 0 } : { days: 0, cents: 0, unknown: 0 },
    ...(user.username === "kate.v" ? { bonus: { daysAgo: 3, cents: 1_500, memo: "премия за кастом" } } : {}),
  })),
  // A person of the payout sheets who has no Hub login.
  { slug: "vika", name: "Вика", aliases: [], status: "active", model: "Mia", skippedPaydays: 0, openingCents: 0, sheetDriftCents: 0, unentered: { days: 2, cents: 5_310, unknown: 1 } },
];

const cents = (value: number) => millsToNumber(millsFromCents(value));

function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** A person's whole book in the invented agency: every accrued day, the Monday payouts, what they paid up to. */
function bookOf(person: LedgerPerson, today: string, accrualFrom: string, now: Date) {
  const left = person.status === "left";
  const user = DEMO_USERS.find((one) => one.username === person.slug);
  const reportsFrom = addDays(today, -REPORTS_FROM_DAYS);
  const factsFrom = addDays(today, -FACTS_FROM_DAYS);
  // A chatter of Hub is paid by their posted reports from the switch; someone without a login stays on the sheet.
  const reports = user && user.role === "chatter" && !left ? demoReportPay(user, now) : null;
  // Every day from the ledger's start to today: worked or not, the amount of a worked day.
  const days: Array<{ date: string; cents: number; source: string }> = [];
  for (let day = accrualFrom; day <= today; day = addDays(day, 1)) {
    if (reports !== null && day >= reportsFrom) {
      const pay = reports.get(day);
      // A paid day stays as it was paid; its post's later change waits (`pendingChanges`).
      if (pay) days.push({ date: day, cents: millsToWholeCents(millsPercentOf(pay.paidAsMills ?? pay.postedMills, RATE_PERCENT)), source: "reports" });
      continue;
    }
    const random = rng(`ledger:${person.slug}:${day}`);
    const works = !left || day < addDays(today, -30);
    if (works && random() < 0.72) days.push({ date: day, cents: intBetween(random, 1_800, 9_400), source: reports !== null && day >= factsFrom ? "facts" : "sheet" });
  }
  // Paydays: the Mondays after the start; each pays what is unpaid up to the Sunday before.
  const mondays: string[] = [];
  for (let day = addDays(accrualFrom, 1); day <= today; day = addDays(day, 1)) if (weekday(day) === 1) mondays.push(day);
  const paidMondays = mondays.slice(0, Math.max(0, mondays.length - person.skippedPaydays));
  let paidUntil = addDays(accrualFrom, -1);
  const payouts: Array<{ date: string; cents: number }> = [];
  for (const monday of paidMondays) {
    const until = addDays(monday, -1);
    const due = days.filter((day) => day.date > paidUntil && day.date <= until).reduce((sum, day) => sum + day.cents, 0);
    if (due > 0) payouts.push({ date: monday, cents: due });
    paidUntil = until;
  }
  const bonus = person.bonus ? { date: addDays(today, -person.bonus.daysAgo), cents: person.bonus.cents, memo: person.bonus.memo } : null;
  return { days, payouts, paidUntil, reports, bonus };
}

function personOf(person: LedgerPerson, from: string, to: string, today: string, accrualFrom: string, now: Date): Person {
  const { days, payouts, paidUntil, reports, bonus } = bookOf(person, today, accrualFrom, now);
  // The opening debt is never paid in this agency: it waits for the owner.
  const unpaid = [
    ...(person.openingCents > 0 ? [{ date: accrualFrom, kind: "opening", model: null, unpaidMills: cents(person.openingCents) }] : []),
    ...days.filter((day) => day.date > paidUntil).map((day) => ({ date: day.date, kind: "day", model: person.model, unpaidMills: cents(day.cents) })),
    ...(bonus ? [{ date: bonus.date, kind: "other", model: null, unpaidMills: cents(bonus.cents) }] : []),
  ].sort((left, right) => left.date.localeCompare(right.date));
  const balanceCents = person.openingCents + (bonus?.cents ?? 0) + days.filter((day) => day.date > paidUntil).reduce((sum, day) => sum + day.cents, 0);
  const windowDays = days.filter((day) => day.date >= from && day.date <= to);
  return {
    slug: person.slug,
    name: person.name,
    aliases: person.aliases,
    status: person.status,
    hubUser: (() => {
      const user = DEMO_USERS.find((one) => one.username === person.slug);
      return user ? { userId: user.id, username: user.username } : null;
    })(),
    days: windowDays.map((day) => ({ date: day.date, model: person.model, amountMills: cents(day.cents), worked: true, source: day.source })),
    accruedMills: cents(windowDays.reduce((sum, day) => sum + day.cents, 0)),
    paidMills: cents(payouts.filter((payout) => payout.date >= from && payout.date <= to).reduce((sum, payout) => sum + payout.cents, 0)),
    balanceMills: cents(balanceCents),
    toPayMills: cents(balanceCents + person.sheetDriftCents),
    oldestUnpaidDate: unpaid[0]?.date ?? null,
    unpaidDays: unpaid,
    unentered: { days: person.unentered.days, shareMills: cents(person.unentered.cents), unknown: person.unentered.unknown },
    pendingChanges: reports === null ? [] : [...reports]
      .filter(([day, pay]) => pay.paidAsMills !== null && day <= paidUntil)
      .map(([day, pay], index) => ({
        id: 9_000 + index,
        day,
        model: person.model,
        postedMills: cents(millsToWholeCents(millsPercentOf(pay.paidAsMills!, RATE_PERCENT))),
        newMills: cents(millsToWholeCents(millsPercentOf(pay.postedMills, RATE_PERCENT))),
        reason: pay.reason ?? "",
      })),
  };
}

function teamLedgerPayouts(request: DemoRequest): Answer | ReturnType<typeof demoError> {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Выплаты из ledger видит только владелец.");
  const from = queryString(request, "from") ?? "";
  const to = queryString(request, "to") ?? "";
  if (!BUSINESS_DATE.test(from) || !BUSINESS_DATE.test(to) || to < from) return demoError(400, "Bad Request", "from и to — даты YYYY-MM-DD.");
  if ((Date.parse(to) - Date.parse(from)) / DAY + 1 > 62) return demoError(400, "Bad Request", "Окно — до 62 дней.");
  const now = request.now.getTime();
  const today = mskDay(now);
  const accrualFrom = addDays(today, -HISTORY_DAYS);
  return {
    from,
    to,
    accrualFrom,
    generatedAt: new Date(now - 4_000).toISOString(),
    factsFrom: addDays(today, -FACTS_FROM_DAYS),
    reportsFrom: addDays(today, -REPORTS_FROM_DAYS),
    // As today: the payout sheets price the days and the posts are the reports. `terms-hub` — the ledger takes the
    // terms from Hub's registry from a week ago (the line on «График и условия» is gone).
    termsHubFrom: request.scenario === "terms-hub" ? addDays(today, -7) : null,
    basisHubFrom: null,
    people: PEOPLE.map((person) => personOf(person, from, to, today, accrualFrom, request.now)),
    checks: {
      // The sheets collector stopped four hours ago: the ledger's own word is «stale», yet the debts are fresh, so only
      // «в таблице» is old.
      stale: true,
      lastSheetsCollectAt: new Date(now - 4 * 60 * 60_000).toISOString(),
      lastRebuildAt: new Date(now - 37 * 60_000).toISOString(),
      debtsStale: false,
      sheetsStale: true,
    },
    serverNow: request.now.toISOString(),
  };
}

type PersonPay = KernelOperationResponse<"teamLedgerPayoutPerson">;

/**
 * One person's pay in a window (`teamLedgerPayoutPerson`; the chatter's «Мои деньги» reads the same book): each day
 * with its state by the Monday payouts, the bonus with its memo, the payouts. The journal rows count from 400.
 */
export function demoPersonPay(slug: string, from: string, to: string, now: Date): PersonPay | null {
  const card = PEOPLE.find((one) => one.slug === slug);
  if (!card) return null;
  const today = mskDay(now.getTime());
  const accrualFrom = addDays(today, -HISTORY_DAYS);
  const { days, payouts, paidUntil, bonus } = bookOf(card, today, accrualFrom, now);
  const person = personOf(card, from, to, today, accrualFrom, now);
  const documents = payouts.map((payout, index) => ({ ...payout, document: 400 + index }));
  const paidBy = (date: string) => documents.find((payout) => addDays(payout.date, -7) < date && date < payout.date)?.document;
  const last = documents.at(-1) ?? null;
  return {
    slug,
    name: card.name,
    from,
    to,
    accrualFrom,
    factsFrom: addDays(today, -FACTS_FROM_DAYS),
    reportsFrom: addDays(today, -REPORTS_FROM_DAYS),
    generatedAt: new Date(now.getTime() - 4_000).toISOString(),
    accruedMills: person.accruedMills,
    paidMills: person.paidMills,
    balanceMills: person.balanceMills,
    oldestUnpaidDate: person.oldestUnpaidDate,
    lastPayout: last === null ? null : { date: last.date, document: last.document, amountMills: cents(last.cents) },
    days: days.filter((day) => day.date >= from && day.date <= to).map((day) => {
      const paid = day.date <= paidUntil;
      const by = paid ? paidBy(day.date) : undefined;
      return {
        date: day.date,
        model: card.model,
        amountMills: cents(day.cents),
        worked: true,
        source: day.source,
        state: paid ? "paid" as const : "to_pay" as const,
        paidMills: paid ? cents(day.cents) : 0,
        unpaidMills: paid ? 0 : cents(day.cents),
        paidBy: by === undefined ? [] : [by],
      };
    }),
    adjustments: bonus && bonus.date >= from && bonus.date <= to ? [{ date: bonus.date, amountMills: cents(bonus.cents), memo: bonus.memo, document: 470 }] : [],
    payouts: documents.filter((payout) => payout.date >= from && payout.date <= to).map((payout) => ({ date: payout.date, document: payout.document, amountMills: cents(payout.cents) })),
    checks: { stale: false, lastRebuildAt: new Date(now.getTime() - 37 * 60_000).toISOString() },
    serverNow: now.toISOString(),
  };
}

function teamLedgerPayoutPerson(request: DemoRequest): PersonPay | ReturnType<typeof demoError> {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Выплаты из ledger видит только владелец.");
  const from = queryString(request, "from") ?? "";
  const to = queryString(request, "to") ?? "";
  if (!BUSINESS_DATE.test(from) || !BUSINESS_DATE.test(to) || to < from) return demoError(400, "Bad Request", "from и to — даты YYYY-MM-DD.");
  if ((Date.parse(to) - Date.parse(from)) / DAY + 1 > 62) return demoError(400, "Bad Request", "Окно — до 62 дней.");
  const pay = demoPersonPay(queryString(request, "person") ?? "", from, to, request.now);
  return pay ?? demoError(404, "Not Found", "У человека нет вкладки выплат в ledger.");
}

/** One person's payout brief (ledger L5) in the invented agency: the unpaid days as the message's lines. */
function teamLedgerPayoutPrepare(request: DemoRequest): KernelOperationResponse<"teamLedgerPayoutPrepare"> | ReturnType<typeof demoError> {
  if (request.role !== "owner") return demoError(403, "Forbidden", "Выплаты из ledger видит только владелец.");
  const slug = queryString(request, "person") ?? "";
  const card = PEOPLE.find((one) => one.slug === slug);
  if (!card) return demoError(404, "Not Found", "У человека нет вкладки выплат в ledger.");
  const now = request.now.getTime();
  const today = mskDay(now);
  const person = personOf(card, addDays(today, -6), today, today, addDays(today, -HISTORY_DAYS), request.now);
  const generatedAt = new Date(now - 4_000).toISOString();
  if (person.balanceMills <= 0) {
    return { slug, name: card.name, generatedAt, amountMills: person.balanceMills, nothing: person.balanceMills < 0 ? "выплачено вперёд: платить нечего" : "долга нет: платить нечего", toPayMills: person.toPayMills, period: null, lines: [], flags: [], blockers: 0, suggestion: null, message: null, placeholder: null };
  }
  const dollars = (mills: number) => (mills / 1000).toFixed(2).replace(/\.00$/, "");
  const days = person.unpaidDays.filter((day) => day.kind === "day");
  const opening = person.unpaidDays.find((day) => day.kind === "opening");
  const bonus = person.unpaidDays.find((day) => day.kind === "other");
  const ddmm = (date: string) => `${date.slice(8)}.${date.slice(5, 7)}`;
  const lines = [
    ...(opening ? [{ kind: "opening", model: null, text: `старый долг: +${dollars(opening.unpaidMills)} — дни до ${ddmm(opening.date)}`, shownMills: opening.unpaidMills, from: opening.date, to: opening.date }] : []),
    ...(days.length > 0 ? [{
      kind: "week",
      model: card.model,
      text: `${days[0]!.date.slice(8)}–${days[days.length - 1]!.date.slice(8)}.${days[days.length - 1]!.date.slice(5, 7)}: ${days.map((day) => dollars(day.unpaidMills * 4)).join("+")} = ${dollars(days.reduce((sum, day) => sum + day.unpaidMills * 4, 0))} × 25% = ${dollars(days.reduce((sum, day) => sum + day.unpaidMills, 0))}`,
      shownMills: days.reduce((sum, day) => sum + day.unpaidMills, 0),
      from: days[0]!.date,
      to: days[days.length - 1]!.date,
    }] : []),
    ...(bonus ? [{ kind: "other", model: null, text: `поправка ${ddmm(bonus.date)}: +${dollars(bonus.unpaidMills)} — {за что}`, shownMills: bonus.unpaidMills, from: bonus.date, to: bonus.date }] : []),
  ];
  const flags = [
    ...(card.unentered.days > 0 ? [{ kind: "unentered", blocker: true, text: `не занесено ${card.unentered.days} дн. (${card.model}): хаб видит продажи в смене, в таблице пусто` }] : []),
    ...(card.sheetDriftCents !== 0 ? [{ kind: "to_pay", blocker: true, text: `долг ≠ «К выплате» вкладки на ${dollars(card.sheetDriftCents * 10)} — сначала понять, откуда` }] : []),
    ...(card.unentered.unknown > 0 ? [{ kind: "unentered_unknown", blocker: false, text: "не занесено? 1 день: хаб не доказал продажи" }] : []),
    ...(bonus && card.bonus ? [{ kind: "manual", blocker: false, text: `ручная проводка на долг ${ddmm(bonus.date)}: +${dollars(bonus.unpaidMills)} («${card.bonus.memo}») — в сообщении впиши, за что` }] : []),
  ];
  const transfer = Math.ceil(person.balanceMills / 1000) * 1000;
  const from = person.unpaidDays[0]?.date ?? today;
  const message = ["закинул зп, {перевод} usdt", `период ${from.slice(8)}.${from.slice(5, 7)}–${today.slice(8)}.${today.slice(5, 7)}`, "", card.model.toLowerCase(),
    ...lines.map((line) => line.text), "", `итого ${dollars(person.balanceMills)} → {перевод}`, "", "чекни что дошло"].join("\n");
  return {
    slug,
    name: card.name,
    generatedAt,
    amountMills: person.balanceMills,
    nothing: null,
    toPayMills: person.toPayMills,
    period: { from, to: today },
    lines,
    flags,
    blockers: flags.filter((flag) => flag.blocker).length,
    suggestion: { transferMills: transfer, aboveTableMills: transfer - person.balanceMills, note: transfer === person.balanceMills ? "сумма ровная" : `до доллара вверх на ${dollars(transfer - person.balanceMills)}: в журнал отдельной строкой {сверх таблицы}` },
    message,
    placeholder: "{перевод}",
  };
}

export const teamLedgerHandlers: DemoHandlers = { teamLedgerPayouts, teamLedgerPayoutPrepare, teamLedgerPayoutPerson };
