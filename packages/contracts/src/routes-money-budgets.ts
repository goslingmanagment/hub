/**
 * Деньги → Бюджеты: the agency's budget by month, as the agency ledger keeps
 * it (owner, 2026-11-08: Hub keeps the facts, the ledger keeps the money).
 * Hub's server reads the ledger's GET /v1/budgets with its `budgets` key
 * (LEDGER_BUDGETS_KEY) on the owner's behalf and adds what only Hub knows:
 * each page's turnover of the month, for the ledger's page plans.
 *
 * - The facts are the journal's paid rows by their date: what came in and from
 *   where, what went out and on what (cash, as finance/closes.md keeps a
 *   budget's «Факт»). An advance for a later month is that month's.
 * - The plans are the owner's numbers per item; the CEO's salary without one
 *   is its rate of the month.
 * - Turnover is Hub's net of each page over the month's Moscow days, the
 *   measure of the ledger's page plans (dollars a day).
 *
 * Money is micro-USD (1 000 000 = $1), the ledger's unit: exact to its rows.
 * Owner session only. 503 — the ledger is not connected or did not answer.
 */
import { z } from "zod";

import { businessDate, errorResponseSchema, isoTimestamp, platformEnum } from "./primitives.ts";

const microUsd = z.number().int();
const monthKey = z.string().regex(/^\d{4}-\d{2}$/, "a month ГГГГ-ММ");

/**
 * What a journal row is in a budget:
 * - income: money came to the agency;
 * - expense: money went out of the business;
 * - refund: «Возврат расхода», makes the month's expenses smaller (not income);
 * - owner_in: «Owner вливание», the owner's money put in — financing, not income;
 * - owner_out: «Owner draw», profit the owner took — not an expense.
 */
export const MONEY_BUDGET_ROW_KINDS = ["income", "expense", "refund", "owner_in", "owner_out"] as const;

export const moneyBudgetRowSchema = z.object({
  /** The journal's row number. */
  num: z.number().int().positive(),
  /** The day it was paid, Moscow. */
  date: businessDate,
  kind: z.enum(MONEY_BUDGET_ROW_KINDS),
  /** The journal's category («Платформы», «Чаттер зарплата», «Трафик», …). */
  category: z.string(),
  counterparty: z.string(),
  /** The row's model as the ledger names it; "" — none. */
  model: z.string(),
  amountMicroUsd: microUsd,
  /** The traffic channel of a traffic row («Instagram», «SFS», …); null — not traffic. */
  channel: z.string().nullable(),
  note: z.string(),
  /** The amount is not final (the journal marks the row incomplete). */
  incomplete: z.boolean(),
  /** An advance for this month paid in an earlier one: that month, else null. */
  advanceFrom: monthKey.nullable(),
});

export const moneyBudgetPlanSchema = z.object({
  /** The item: a journal category, or «Доход» — the agency's income. */
  item: z.string(),
  planMicroUsd: microUsd,
  note: z.string(),
  /** plan — the owner's plan; rate — the CEO's salary rate of the month standing in for one. */
  source: z.string(),
  setAt: isoTimestamp.nullable(),
});

export const moneyBudgetPageSchema = z.object({
  pageLabel: z.string(),
  /** "" and null — a page of a plan Hub does not know. */
  modelName: z.string(),
  platform: platformEnum.nullable(),
  /** Hub's net of the page over the month's Moscow days (to now for the current month). */
  netMicroUsd: microUsd,
  /** The ledger's turnover plan of the page, a day; null — none. */
  planPerDayMicroUsd: microUsd.nullable(),
});

/** The month card's figures (finance/rules.md § Цифры месяца): before the CEO's salary. */
export const moneyBudgetResultSchema = z.object({
  turnoverMicroUsd: microUsd,
  earnedMicroUsd: microUsd,
  expensesMicroUsd: microUsd,
  /** Заработано − застряло − расходы, now; null — not counted. */
  decisionMicroUsd: microUsd.nullable(),
  /** The decision figure the month was closed with; null — open. */
  decisionAtCloseMicroUsd: microUsd.nullable(),
});

export const moneyBudgetMonthSchema = z.object({
  month: monthKey,
  days: z.number().int().positive(),
  /** Days of the month gone by, today counted: all of them for a past month. */
  elapsedDays: z.number().int().nonnegative(),
  /** Closed in the ledger. */
  closed: z.boolean(),
  /** After the ledger's full accounting began; before it the journal holds only part of the movements. */
  complete: z.boolean(),
  rows: z.array(moneyBudgetRowSchema),
  plans: z.array(moneyBudgetPlanSchema),
  /** Pages with turnover in the month or a plan, by turnover. */
  pages: z.array(moneyBudgetPageSchema),
  result: moneyBudgetResultSchema.nullable(),
});

export const moneyBudgetsResponseSchema = z.object({
  /** Oldest first, up to the current month. */
  months: z.array(moneyBudgetMonthSchema),
  currentMonth: monthKey,
  /** The first day of the ledger's full accounting; null — not said. */
  fullLedgerFrom: businessDate.nullable(),
  /** The models' names to show, by the ledger's code (rows' `model`). */
  modelNames: z.record(z.string(), z.string()),
  /** When the ledger answered. */
  generatedAt: isoTimestamp,
});

export const moneyBudgetPlansBodySchema = z.object({
  plans: z.array(z.object({
    month: monthKey,
    item: z.string().trim().min(1).max(64),
    /** The plan in whole cents as micro-USD; null removes the item's plan. */
    planMicroUsd: microUsd.nonnegative().refine((value) => value % 10_000 === 0, { message: "whole cents" }).nullable(),
    note: z.string().max(500).default(""),
  })).min(1).max(100),
});

export const moneyBudgetPlansResponseSchema = z.object({
  /** Plans written; one already as asked adds nothing. */
  written: z.number().int().nonnegative(),
  unchanged: z.number().int().nonnegative(),
});

export type MoneyBudgetRow = z.infer<typeof moneyBudgetRowSchema>;
export type MoneyBudgetRowKind = MoneyBudgetRow["kind"];
export type MoneyBudgetPlan = z.infer<typeof moneyBudgetPlanSchema>;
export type MoneyBudgetPage = z.infer<typeof moneyBudgetPageSchema>;
export type MoneyBudgetResult = z.infer<typeof moneyBudgetResultSchema>;
export type MoneyBudgetMonth = z.infer<typeof moneyBudgetMonthSchema>;
export type MoneyBudgetsResponse = z.infer<typeof moneyBudgetsResponseSchema>;
export type MoneyBudgetPlansBody = z.infer<typeof moneyBudgetPlansBodySchema>;
export type MoneyBudgetPlansResponse = z.infer<typeof moneyBudgetPlansResponseSchema>;

export const moneyBudgetsRouteSchemas = {
  adminMoneyBudgets: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "The agency's budget by month from the agency ledger: in and out by item, plans, traffic, page turnover",
    description: "Read from the ledger's GET /v1/budgets with Hub's budgets key; each page's turnover is Hub's own. "
      + "503 when the ledger is not connected or did not answer.",
    response: {
      200: moneyBudgetsResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
  adminMoneyBudgetPlansSet: {
    auth: { kind: "owner-session" },
    tags: ["admin"],
    summary: "Set or remove the owner's plans of budget items in the agency ledger",
    description: "Written to the ledger's POST /v1/budgets/plans with Hub's budgets key, append-only there. A plan, "
      + "never a movement of money. 400 — the ledger refused it; 503 — the ledger is not connected or did not answer.",
    body: moneyBudgetPlansBodySchema,
    response: {
      200: moneyBudgetPlansResponseSchema,
      400: errorResponseSchema,
      401: errorResponseSchema,
      403: errorResponseSchema,
      503: errorResponseSchema,
    },
  },
} as const;
