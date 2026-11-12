import { z } from "zod";

import type { AccountPayQuery, AccountPayResponse, LedgerDayState, TeamLedgerPayoutPersonResponse } from "@agency_hub_core/contracts";
import { ACCOUNT_PAY_MAX_DAYS } from "@agency_hub_core/contracts";
import { findOwnPayPerson } from "@agency_hub_core/db";
import { previousBusinessDate } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireSessionUser, type AuthPrincipal } from "./auth.ts";
import { NotFoundError, ServiceUnavailableError } from "./errors.ts";
import { checkWindow, ledgerGet, list, micros, payMillsOf } from "./ledger-payouts.ts";

/**
 * One person's pay as the agency ledger keeps it (ledger #80, GET /v1/payouts/person, the `payouts` scope only): the
 * days accrued in a window, each with its state by the payouts, the manual postings on the debt with their memo, the
 * payouts, the last payout and the debt now. No pay terms are in the answer (no rate, no fix, no revenue). Two doors:
 *   - the owner's «Выплаты» panel of a person (`teamLedgerPayoutPerson`, owner session, any person);
 *   - the chatter's «Мои деньги» (`accountPay`): the person is the session user's, found through the people
 *     registry, and only while their switch «видит свои деньги» is on. Nothing in the request names the person.
 * Read-only; the ledger's answer is checked field by field, and an answer of another person than the one asked is a
 * 503, never someone else's numbers on the screen.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const day = z.string().regex(DAY);

const payout = z.object({ date: day, document: z.number().int().nonnegative(), amountMicros: micros });

const ledgerPersonPaySchema = z.object({
  person: z.string(),
  name: z.string(),
  from: day,
  to: day,
  accrualFrom: day,
  // "" — not switched.
  factsFrom: z.string(),
  reportsFrom: z.string(),
  generatedAt: z.string(),
  accruedMicros: micros,
  paidMicros: micros,
  balanceMicros: micros,
  oldestUnpaidDate: day.nullable(),
  lastPayout: payout.nullable(),
  days: list(z.object({
    date: day,
    model: z.string(),
    amountMicros: micros,
    worked: z.boolean(),
    source: z.string(),
    posts: list(z.number().int()),
    state: z.string(),
    paidMicros: micros,
    unpaidMicros: micros,
    paidBy: list(z.number().int()),
  })),
  adjustments: list(z.object({ date: day, amountMicros: micros, memo: z.string(), document: z.number().int().nullable() })),
  payouts: list(payout),
  checks: z.object({ stale: z.boolean(), lastRebuildAt: z.string().nullable() }),
});

type LedgerPersonPay = z.infer<typeof ledgerPersonPaySchema>;

const stateOf = (value: string): LedgerDayState => (value === "paid" || value === "to_pay" ? value : "none");
const dayOrNull = (value: string) => (DAY.test(value) ? value : null);

/**
 * The ledger's GET /v1/payouts/person for one code, parsed; undefined — the ledger has no payout tab of the person
 * (its 404). Throws 503 when the ledger is away, answers in another shape, or answers of someone else.
 */
async function readLedgerPersonPay(
  app: Pick<AppContext, "config" | "logger">,
  slug: string,
  window: { from: string; to: string },
  options: { fetchImpl?: typeof fetch; client: string },
): Promise<LedgerPersonPay | undefined> {
  const body = await ledgerGet(app, "/v1/payouts/person", { person: slug, from: window.from, to: window.to }, {
    client: options.client,
    absentOn: [404],
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  if (body === undefined) return undefined;
  const parsed = ledgerPersonPaySchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger person pay: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts/person answered in a shape Hub does not know");
  }
  if (parsed.data.person !== slug) {
    app.logger.warn({ asked: slug }, "ledger person pay: the answer is of another person, dropped");
    throw new ServiceUnavailableError("The ledger's GET /v1/payouts/person answered of another person");
  }
  return parsed.data;
}

/** The owner's: one person's pay in a window, every day by model with its source, state and the payouts that paid it. */
export async function readTeamLedgerPayoutPerson(
  app: Pick<AppContext, "config" | "logger">,
  query: { person: string; from: string; to: string },
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<TeamLedgerPayoutPersonResponse> {
  checkWindow(query.from, query.to);
  const pay = await readLedgerPersonPay(app, query.person, query, { client: "workboard-payouts", ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (pay === undefined) throw new NotFoundError("The ledger has no payout tab of this person");
  return {
    slug: pay.person,
    name: pay.name,
    from: pay.from,
    to: pay.to,
    accrualFrom: pay.accrualFrom,
    factsFrom: dayOrNull(pay.factsFrom),
    reportsFrom: dayOrNull(pay.reportsFrom),
    generatedAt: pay.generatedAt,
    accruedMills: payMillsOf(pay.accruedMicros),
    paidMills: payMillsOf(pay.paidMicros),
    balanceMills: payMillsOf(pay.balanceMicros),
    oldestUnpaidDate: pay.oldestUnpaidDate,
    lastPayout: pay.lastPayout === null ? null : { date: pay.lastPayout.date, document: pay.lastPayout.document, amountMills: payMillsOf(pay.lastPayout.amountMicros) },
    days: pay.days.map((one) => ({
      date: one.date,
      model: one.model,
      amountMills: payMillsOf(one.amountMicros),
      worked: one.worked,
      source: one.source,
      state: stateOf(one.state),
      paidMills: payMillsOf(one.paidMicros),
      unpaidMills: payMillsOf(one.unpaidMicros),
      paidBy: one.paidBy,
    })),
    adjustments: pay.adjustments.map((one) => ({ date: one.date, amountMills: payMillsOf(one.amountMicros), memo: one.memo, document: one.document })),
    payouts: pay.payouts.map((one) => ({ date: one.date, document: one.document, amountMills: payMillsOf(one.amountMicros) })),
    checks: pay.checks,
    serverNow: (options.now ?? new Date()).toISOString(),
  };
}

/**
 * The chatter's «Мои деньги»: the session user's person, through the registry; their switch off (or no person) — the
 * answer says so and carries no sums. On, the ledger's read of that person's code alone, the days added up by date
 * (every model of a day is one accrual on the screen) and nothing of the journal: no document numbers, no posts, no
 * memo, no model. The query names the window only; the ledger is read from the day before it (a night begun that
 * evening is dated by it), and the window's sums are added up in micro-dollars and rounded once, as the ledger does.
 */
export async function readAccountPay(
  app: Pick<AppContext, "db" | "config" | "logger">,
  principal: AuthPrincipal,
  query: AccountPayQuery,
  options: { fetchImpl?: typeof fetch; now?: Date } = {},
): Promise<AccountPayResponse> {
  requireSessionUser(principal);
  checkWindow(query.from, query.to, ACCOUNT_PAY_MAX_DAYS);
  const serverNow = (options.now ?? new Date()).toISOString();
  const off: AccountPayResponse = { enabled: false, from: query.from, to: query.to, pay: null, serverNow };
  const person = await findOwnPayPerson(app.db, principal.user.id);
  if (person === null || person.seesOwnPaySince === null) return off;

  const read = { from: previousBusinessDate(query.from), to: query.to };
  const pay = await readLedgerPersonPay(app, person.code, read, { client: "account-pay", ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}) });
  if (pay === undefined) return { ...off, enabled: true };
  const inWindow = (date: string) => date >= query.from && date <= query.to;

  const byDate = new Map<string, { amount: number; paid: number; unpaid: number }>();
  for (const one of pay.days) {
    const sum = byDate.get(one.date) ?? { amount: 0, paid: 0, unpaid: 0 };
    sum.amount += one.amountMicros;
    sum.paid += one.paidMicros;
    sum.unpaid += one.unpaidMicros;
    byDate.set(one.date, sum);
  }
  const days = [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, sum]) => ({
      date,
      amountMills: payMillsOf(sum.amount),
      state: (sum.unpaid > 0 ? "to_pay" : sum.paid > 0 ? "paid" : "none") as LedgerDayState,
      paidMills: payMillsOf(sum.paid),
      unpaidMills: payMillsOf(sum.unpaid),
    }));
  return {
    enabled: true,
    from: query.from,
    to: query.to,
    pay: {
      accruedMills: payMillsOf(pay.days.filter((one) => inWindow(one.date)).reduce((sum, one) => sum + one.amountMicros, 0)),
      paidMills: payMillsOf(pay.payouts.filter((one) => inWindow(one.date)).reduce((sum, one) => sum + one.amountMicros, 0)),
      balanceMills: payMillsOf(pay.balanceMicros),
      oldestUnpaidDate: pay.oldestUnpaidDate,
      lastPayout: pay.lastPayout === null ? null : { date: pay.lastPayout.date, amountMills: payMillsOf(pay.lastPayout.amountMicros) },
      days,
      reportsFrom: dayOrNull(pay.reportsFrom),
      stale: pay.checks.stale,
      generatedAt: pay.generatedAt,
    },
    serverNow,
  };
}
