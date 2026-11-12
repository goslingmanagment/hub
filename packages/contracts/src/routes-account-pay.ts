/**
 * «Мои деньги» on «Мои смены» (ecosystem plan, package H1): what the agency ledger accrued to the caller in a window,
 * what it owes them now and when it last paid them, and each day's accrual with its state. Behind the person's switch
 * «видит свои деньги» (people registry right `sees_own_pay`): off — `enabled` false and nothing else, the screen as
 * before. Hub's server finds the caller's person through the registry (the session's user, never the query) and reads
 * the ledger's GET /v1/payouts/person for that person only. Sums, never terms: no rate, no fix per shift, no revenue a
 * day was priced from, nothing of anyone else. 503 — the switch is on and the ledger is not connected or did not answer.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, isoTimestamp, mills } from "./primitives.ts";
import { ledgerDayStateEnum } from "./routes-team-ledger.ts";

/** The widest window: the ledger's 62 days of one read, less the day before the window it also reads (for a night). */
export const ACCOUNT_PAY_MAX_DAYS = 61;

export const accountPayQuerySchema = z.object({
  /** Moscow dates (the days the ledger accrues by: a shift's report date), both included. */
  from: businessDate,
  to: businessDate,
});

export const accountPaySchema = z.object({
  /** The window's days added up (to the ledger's cent, once). */
  accruedMills: mills,
  /** The payouts dated in the window, added up. */
  paidMills: mills,
  /** «К выплате»: what the agency owes now (plus), or paid ahead (minus). */
  balanceMills: mills,
  /** The oldest day still unpaid now; null — nothing owed. */
  oldestUnpaidDate: businessDate.nullable(),
  /** The latest payout ever; null — none yet. */
  lastPayout: z.object({ date: businessDate, amountMills: mills }).nullable(),
  /**
   * One per date (every model of the day added up): the window's days and the day before it — a night begun that
   * evening is dated by it, and its row may still be in the window.
   */
  days: z.array(z.object({
    date: businessDate,
    amountMills: mills,
    /** paid — the payouts covered it; to_pay — some or all of it is still owed; none — it accrued nothing. */
    state: ledgerDayStateEnum,
    paidMills: mills,
    unpaidMills: mills,
  })),
  /** From this day on the days are accrued from the posted shift reports; null — not switched. */
  reportsFrom: businessDate.nullable(),
  /** The ledger did not rebuild the debts for 2 hours: the sums may lag. */
  stale: z.boolean(),
  generatedAt: isoTimestamp,
});

export const accountPayResponseSchema = z.object({
  /** The person's switch «видит свои деньги»: false — nothing to show, the screen stays as it was. */
  enabled: z.boolean(),
  from: businessDate,
  to: businessDate,
  /** null — the switch is off, or the ledger has no payouts of the person yet. */
  pay: accountPaySchema.nullable(),
  serverNow: isoTimestamp,
});

export type AccountPayQuery = z.infer<typeof accountPayQuerySchema>;
export type AccountPay = z.infer<typeof accountPaySchema>;
export type AccountPayResponse = z.infer<typeof accountPayResponseSchema>;

export const accountPayRouteSchemas = {
  accountPay: {
    auth: { kind: "any-session" },
    tags: ["client"],
    summary: "The caller's own pay from the agency ledger, behind the person's switch: accrued, to pay, paid, by day",
    description: "Workboard «Мои смены» → «Мои деньги»; read-only. The person is the session user's, found through the "
      + "people registry; the query names only the window (Moscow days, at most 61). The switch off — `enabled` false "
      + "and no sums. Sums only, no pay terms. 503 when the ledger is not connected or did not answer.",
    querystring: accountPayQuerySchema,
    response: {
      200: accountPayResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
