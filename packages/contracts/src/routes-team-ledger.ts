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
  /** «Не занесено» now: the tab's empty days on which Hub shows money in the person's scheduled shift — pay the sheet
   *  has not got yet, so not in the debt. shareMills is an estimate at the tab's rate; unknown — days Hub did not prove. */
  unentered: z.object({ days: z.number().int().nonnegative(), shareMills: mills, unknown: z.number().int().nonnegative() }),
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

export const teamLedgerPayoutPrepareQuerySchema = z.object({
  /** The ledger's code of the person. */
  person: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
});

/** One person's payout brief (ledger L5 `payout prepare`): read-only, nothing is recorded or sent. */
export const teamLedgerPayoutPrepareResponseSchema = z.object({
  slug: z.string(),
  name: z.string(),
  generatedAt: isoTimestamp,
  /** What the agency owes now; ≤ 0 — nothing to pay (`nothing` says why). */
  amountMills: mills,
  nothing: z.string().nullable(),
  toPayMills: mills.nullable(),
  period: z.object({ from: businessDate, to: businessDate }).nullable(),
  /** The message's lines: a week of a tab «дд–дд.мм: a+b = база × ставка% = зп», an opening debt, a remainder. */
  lines: z.array(z.object({ kind: z.string(), model: z.string().nullable(), text: z.string(), shownMills: mills })),
  /** What the owner should know before paying; a blocker stops the payout until it is understood. */
  flags: z.array(z.object({ kind: z.string(), blocker: z.boolean(), text: z.string() })),
  blockers: z.number().int().nonnegative(),
  /** The transfer the owner usually makes (rounded to a dollar), what goes above the table, and a note. */
  suggestion: z.object({ transferMills: mills, aboveTableMills: mills, note: z.string() }).nullable(),
  /** The chatter's message; `placeholder` stands where the transferred amount goes after the transfer. */
  message: z.string().nullable(),
  placeholder: z.string().nullable(),
});

export type TeamLedgerPayoutsResponse = z.infer<typeof teamLedgerPayoutsResponseSchema>;
export type TeamLedgerPayoutPrepareResponse = z.infer<typeof teamLedgerPayoutPrepareResponseSchema>;
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
  teamLedgerPayoutPrepare: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "One person's payout brief from the agency ledger: the transfer, the lines, the blockers, the message",
    description: "Read from the ledger's GET /v1/payouts/prepare with Hub's payouts key. Read-only: nothing is recorded "
      + "or sent. 404 — the ledger has no payout tab of the person; 503 — the ledger is not connected or did not answer.",
    querystring: teamLedgerPayoutPrepareQuerySchema,
    response: {
      200: teamLedgerPayoutPrepareResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      404: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
