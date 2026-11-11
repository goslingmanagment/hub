/**
 * The owner's «Бюджеты»: every month of the agency as the agency ledger counts
 * it — what was earned and from where, what it went on by article, what is
 * left, the plans the ledger keeps (the turnover plan, the articles' limits,
 * the CEO's rate, the reinvest caps), and what traffic and contractors cost by
 * source. Hub keeps the facts, the ledger keeps the money (owner, 2026-11-08):
 * Hub's server reads the ledger's month cards and journal with a `read` key
 * (LEDGER_READ_KEY) on the owner's behalf and passes them on in mills, every
 * sum in the whole cents the ledger itself prints. Owner session only. 503 — the ledger is not connected or did not
 * answer; nothing is written anywhere.
 */
import { z } from "zod";

import { errorResponseSchema, isoTimestamp, mills } from "./primitives.ts";

/** A calendar month of Moscow time: `2026-11`. */
export const budgetMonthKey = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

/** Where a month's money came from: a model on a channel. */
export const budgetIncomeSourceSchema = z.object({
  /** The model as the ledger names her for people. */
  model: z.string(),
  /** `other` — a channel Hub does not know; `channelName` says what the ledger wrote. */
  channel: z.enum(["fansly", "onlyfans", "off_platform", "other"]),
  channelName: z.string(),
  /** The pages' money after the platform's fee, plus what came past the platforms. */
  turnoverMills: mills,
  /** The agency's part of it. */
  earnedMills: mills,
});

/** One article of a month's expenses. */
export const budgetArticleSchema = z.object({
  /** `chatters` — the chatters' pay; any other — the ledger's category as it is written. */
  key: z.string(),
  name: z.string(),
  amountMills: mills,
  /** The article's limit for a month (the ledger's `category_caps`); null — it has none. */
  capMills: mills.nullable(),
  /** What the article is made of, where the ledger says: the chatters' pay by model and above the sheets. */
  parts: z.array(z.object({ name: z.string(), amountMills: mills })),
});

/** A month's figures as the ledger's month card has them now. */
export const budgetFiguresSchema = z.object({
  turnoverMills: mills,
  earnedMills: mills,
  /** Of the earned: already on the agency's accounts. */
  arrivedMills: mills,
  /** Of the earned: on its way (on hold, on a page, in a transfer). */
  transitMills: mills,
  /** Of the earned: stuck on a page under its payout minimum. Not in the decision figure. */
  stuckMills: mills,
  sources: z.array(budgetIncomeSourceSchema),
  /** The month's turnover of each page (what the turnover plan is measured by), the largest first. */
  pages: z.array(z.object({ pageLabel: z.string(), turnoverMills: mills })),
  /** The month's expenses without the CEO's pay: the sum of `articles`, to the ledger's cent. */
  expensesMills: mills,
  /** The largest first; a refund of an expense is its own article, below zero. */
  articles: z.array(budgetArticleSchema),
  /** Earned − stuck − expenses: what the month made before the CEO's pay. */
  decisionMills: mills,
  /** `decisionMills` less the CEO's rate of the month; null — the ledger has no rate for it. */
  leftMills: mills.nullable(),
  /** What the ledger says it does not see («ari-2 не подключена к хабу»). */
  notes: z.array(z.string()),
});

export const budgetMonthSchema = z.object({
  month: budgetMonthKey,
  /** `open` — the running month; `preliminary` — over, not closed yet; `closed` — closed by the ledger. */
  state: z.enum(["open", "preliminary", "closed"]),
  closedAt: isoTimestamp.nullable(),
  daysInMonth: z.number().int().min(28).max(31),
  /** How much of the month had passed at the ledger's cut: 0–1; 1 for a month that is over. */
  elapsedShare: z.number().min(0).max(1),
  /** null — the ledger could not count the month; `unknownReason` says why. Never a zero. */
  figures: budgetFiguresSchema.nullable(),
  unknownReason: z.string().nullable(),
  /** The owner's own lines of the journal, by the month they are for. */
  owner: z.object({
    /** The CEO's rate in force on the month's first day; null — none set. */
    salaryRateMills: mills.nullable(),
    /** Paid as the CEO's pay for this month. */
    salaryPaidMills: mills,
    /** Taken out above the pay (a share of profit, not an expense). */
    drawMills: mills,
    /** Put in by the owner, less what was returned (financing, not income). */
    injectionMills: mills,
  }),
  plan: z.object({
    /** The month's turnover plan: the pages' daily plans times the month's days; null — no plan. */
    turnoverMills: mills.nullable(),
    /** What the planned pages turned over in the month, added as the ledger adds and rounded once; null — no plan, or the ledger did not count the month. */
    factMills: mills.nullable(),
    /** The same by page, the largest first. */
    pages: z.array(z.object({ pageLabel: z.string(), perDayMills: mills, planMills: mills })),
    /** What the owner allowed for growth and ends in this month. */
    reinvest: z.array(z.object({ name: z.string(), capMills: mills })),
  }),
});

/** Who was paid for traffic or as a contractor, month by month (by the date of payment). */
export const budgetPromotionSourceSchema = z.object({
  /** `traffic` — the ledger's traffic articles (Трафик, SFS, YouTube); `contractor` — «Подрядчик». */
  kind: z.enum(["traffic", "contractor"]),
  /** The ledger's category as it is written. */
  category: z.string(),
  counterparty: z.string(),
  /** The model the payments are for, as the ledger names her; "" — none. */
  model: z.string(),
  /** One sum per month of `promotion.months`, in its order; 0 — nothing paid. */
  byMonth: z.array(mills),
  /** Over every month of `promotion.months`. */
  totalMills: mills,
  payments: z.number().int().nonnegative(),
  /** What the ledger expects to pay the source regularly (its commitments): the plan of the source. `period` is the
   *  ledger's word: `week`, `month`, `90d`, `once`. null — nothing regular is agreed. */
  regular: z.object({ amountMills: mills, period: z.string() }).nullable(),
});

export const adminBudgetsResponseSchema = z.object({
  /** Every month the ledger counts, the oldest first. Empty — it has none yet. */
  months: z.array(budgetMonthSchema),
  promotion: z.object({
    /** The months of `months`, in the same order. */
    months: z.array(budgetMonthKey),
    /** The largest total first; a source the ledger expects to pay and has not paid yet is here with zeros. */
    sources: z.array(budgetPromotionSourceSchema),
    /** Per month of `months`: the traffic articles' and the contractors' sums. */
    totals: z.array(z.object({ month: budgetMonthKey, trafficMills: mills, contractorMills: mills })),
  }),
  /** The moment the ledger's figures are counted for; null — no month yet. */
  ledgerAsOf: isoTimestamp.nullable(),
  serverNow: isoTimestamp,
});

export type AdminBudgetsResponse = z.infer<typeof adminBudgetsResponseSchema>;
export type BudgetMonth = z.infer<typeof budgetMonthSchema>;
export type BudgetFigures = z.infer<typeof budgetFiguresSchema>;
export type BudgetArticle = z.infer<typeof budgetArticleSchema>;
export type BudgetIncomeSource = z.infer<typeof budgetIncomeSourceSchema>;
export type BudgetPromotionSource = z.infer<typeof budgetPromotionSourceSchema>;

export const budgetsRouteSchemas = {
  adminBudgets: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The agency's budgets by month from the agency ledger: earned, spent by article, left, the plans, traffic by source",
    description: "Read from the ledger's month cards, journal, plans and settings (POST /v1/sql) with Hub's read key. "
      + "A month the ledger could not count has `figures` null and a reason, never zeros. "
      + "503 when the ledger is not connected or did not answer.",
    response: {
      200: adminBudgetsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
