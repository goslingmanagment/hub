import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { millsFromCents, millsToNumber } from "@agency_hub_core/shared";

import { demoError, intBetween, queryString, rng, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_CHATTERS, DEMO_USERS } from "../world.ts";
import { DAY, addDays, mskDay } from "./team-world.ts";

/**
 * Выплаты from the agency ledger (`teamLedgerPayouts`) in the invented agency:
 * every chatter works most days on their model's tab; the agency pays on
 * Mondays everything up to the Sunday before. Two people fall behind (one
 * unpaid for two weeks, one with a debt from before the ledger's start), one
 * person of the sheets has no Hub user, and one tab's «К выплате» differs from
 * the ledger's count — so every state of the screen shows.
 */

type Answer = KernelOperationResponse<"teamLedgerPayouts">;
type Person = Answer["people"][number];

const BUSINESS_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The ledger's day-by-day accruals start here; the debt from before is one opening sum. */
const HISTORY_DAYS = 70;

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
  })),
  // A person of the payout sheets who has no Hub login.
  { slug: "vika", name: "Вика", aliases: [], status: "active", model: "Mia", skippedPaydays: 0, openingCents: 0, sheetDriftCents: 0, unentered: { days: 2, cents: 5_310, unknown: 1 } },
];

const cents = (value: number) => millsToNumber(millsFromCents(value));

function weekday(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function personOf(person: LedgerPerson, from: string, to: string, today: string, accrualFrom: string): Person {
  const left = person.status === "left";
  // Every day from the ledger's start to today: worked or not, the amount of a worked day.
  const days: Array<{ date: string; cents: number }> = [];
  for (let day = accrualFrom; day <= today; day = addDays(day, 1)) {
    const random = rng(`ledger:${person.slug}:${day}`);
    const works = !left || day < addDays(today, -30);
    if (works && random() < 0.72) days.push({ date: day, cents: intBetween(random, 1_800, 9_400) });
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
  // The opening debt is never paid in this agency: it waits for the owner.
  const unpaid = [
    ...(person.openingCents > 0 ? [{ date: accrualFrom, kind: "opening", model: null, unpaidMills: cents(person.openingCents) }] : []),
    ...days.filter((day) => day.date > paidUntil).map((day) => ({ date: day.date, kind: "day", model: person.model, unpaidMills: cents(day.cents) })),
  ];
  const balanceCents = person.openingCents + days.filter((day) => day.date > paidUntil).reduce((sum, day) => sum + day.cents, 0);
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
    days: windowDays.map((day) => ({ date: day.date, model: person.model, amountMills: cents(day.cents), worked: true, source: "sheet" })),
    accruedMills: cents(windowDays.reduce((sum, day) => sum + day.cents, 0)),
    paidMills: cents(payouts.filter((payout) => payout.date >= from && payout.date <= to).reduce((sum, payout) => sum + payout.cents, 0)),
    balanceMills: cents(balanceCents),
    toPayMills: cents(balanceCents + person.sheetDriftCents),
    oldestUnpaidDate: unpaid[0]?.date ?? null,
    unpaidDays: unpaid,
    unentered: { days: person.unentered.days, shareMills: cents(person.unentered.cents), unknown: person.unentered.unknown },
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
    people: PEOPLE.map((person) => personOf(person, from, to, today, accrualFrom)),
    checks: {
      stale: false,
      lastSheetsCollectAt: new Date(now - 22 * 60_000).toISOString(),
      lastRebuildAt: new Date(now - 37 * 60_000).toISOString(),
    },
    serverNow: request.now.toISOString(),
  };
}

export const teamLedgerHandlers: DemoHandlers = { teamLedgerPayouts };
