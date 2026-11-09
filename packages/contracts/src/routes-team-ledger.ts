/**
 * The chatters' pay as the agency ledger counts it (ledger release 2, H2):
 * what each person accrued and was paid in a window of Moscow days, and what
 * the agency owes them now. Hub keeps the facts, the ledger keeps the money
 * (owner, 2026-11-08): Hub's server reads the ledger's GET /v1/payouts with a
 * `payouts` key (LEDGER_PAYOUTS_KEY) on the owner's behalf and passes it on,
 * micro-dollars turned into mills. Owner session only: a person's pay is the
 * owner's. 503 — the ledger is not connected or did not answer.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, intId, isoTimestamp, mills } from "./primitives.ts";

/** The ledger's widest window of one read (ledger MaxPayoutDays). */
export const TEAM_LEDGER_PAYOUTS_MAX_DAYS = 62;

export const teamLedgerPayoutsQuerySchema = z.object({
  /** Moscow dates, both included. */
  from: businessDate,
  to: businessDate,
});

export const teamLedgerPayoutPersonSchema = z.object({
  /** The ledger's code of the person. */
  slug: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  /** The ledger's status of the person (active, left, …). */
  status: z.string(),
  /** The Hub user the person is (their username is the slug, the name or an alias); null — none. */
  hubUser: z.object({ userId: intId, username: z.string() }).nullable(),
  /** The window's accrued days, one per tab and day. */
  days: z.array(z.object({
    date: businessDate,
    /** The tab's model. */
    model: z.string(),
    amountMills: mills,
    worked: z.boolean(),
    /** Where the day came from: «sheet» — the payout sheet. */
    source: z.string(),
  })),
  /** Accrued over the window's days. */
  accruedMills: mills,
  /** Paid out on the window's days. */
  paidMills: mills,
  /** What the agency owes the person now: plus — owes, minus — paid ahead. */
  balanceMills: mills,
  /** «К выплате» of the person's payout tabs now; null — not known. */
  toPayMills: mills.nullable(),
  /** The oldest day still unpaid now; null — nothing owed. */
  oldestUnpaidDate: businessDate.nullable(),
  /** What is left unpaid now, oldest first. opening: the debt from before `accrualFrom` in one sum. */
  unpaidDays: z.array(z.object({
    date: businessDate,
    kind: z.string(),
    model: z.string().nullable(),
    unpaidMills: mills,
  })),
});

export const teamLedgerPayoutsResponseSchema = z.object({
  from: businessDate,
  to: businessDate,
  /** Days before it are in the opening debt, not one by one. */
  accrualFrom: businessDate,
  /** When the ledger answered. */
  generatedAt: isoTimestamp,
  people: z.array(teamLedgerPayoutPersonSchema),
  checks: z.object({
    /** The sheets were last collected, or the debts last rebuilt, too long ago. */
    stale: z.boolean(),
    lastSheetsCollectAt: isoTimestamp.nullable(),
    lastRebuildAt: isoTimestamp.nullable(),
  }),
  serverNow: isoTimestamp,
});

export type TeamLedgerPayoutsResponse = z.infer<typeof teamLedgerPayoutsResponseSchema>;
export type TeamLedgerPayoutPerson = z.infer<typeof teamLedgerPayoutPersonSchema>;

export const teamLedgerRouteSchemas = {
  teamLedgerPayouts: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The chatters' pay as the agency ledger counts it: accrued, paid, owed now",
    description: "Read from the ledger's GET /v1/payouts with Hub's payouts key. The days are Moscow days, at most 62. "
      + "503 when the ledger is not connected or did not answer.",
    querystring: teamLedgerPayoutsQuerySchema,
    response: {
      200: teamLedgerPayoutsResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
