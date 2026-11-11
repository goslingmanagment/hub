import { z } from "zod";

import {
  MONEY_BUDGET_ROW_KINDS,
  type MoneyBudgetMonth,
  type MoneyBudgetPage,
  type MoneyBudgetPlansBody,
  type MoneyBudgetPlansResponse,
  type MoneyBudgetsResponse,
} from "@agency_hub_core/contracts";
import { millsToMicroUsd, toBusinessDate, type Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ServiceUnavailableError } from "./errors.ts";
import { getPageNetForDays } from "./reporting.ts";

/**
 * Деньги → Бюджеты from the agency ledger: Hub's server reads the ledger's
 * GET /v1/budgets with its `budgets` key (LEDGER_BUDGETS_KEY) and adds each
 * page's turnover of the month from Hub's own revenue, for the ledger's page
 * plans; the owner's plans go to POST /v1/budgets/plans with the same key.
 * Our own service on the same host, not a platform: no egress proxy, no retry
 * (the owner presses «Обновить»). The ledger's answer is checked field by
 * field: a changed shape is a 503, never a wrong sum on the screen.
 */

const LEDGER_TIMEOUT_MS = 20_000;
const MONTH = /^\d{4}-\d{2}$/;

const micros = z.number().int();
/** Go writes an empty slice as null. */
const list = <T extends z.ZodTypeAny>(item: T) => z.array(item).nullable().transform((value): Array<z.output<T>> => value ?? []);

const ledgerBudgetsSchema = z.object({
  from: z.string().regex(MONTH),
  to: z.string().regex(MONTH),
  fullLedgerFrom: z.string(),
  generatedAt: z.string(),
  // A ledger before the models' names answers without them: the codes are shown.
  modelNames: z.record(z.string(), z.string()).nullable().optional(),
  months: list(z.object({
    month: z.string().regex(MONTH),
    days: z.number().int().positive(),
    closed: z.boolean(),
    complete: z.boolean(),
    rows: list(z.object({
      num: z.number().int().positive(),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      kind: z.enum(MONEY_BUDGET_ROW_KINDS),
      category: z.string(),
      counterparty: z.string(),
      model: z.string(),
      amountMicros: micros,
      channel: z.string().optional(),
      note: z.string(),
      incomplete: z.boolean().optional(),
      advanceFrom: z.string().regex(MONTH).optional(),
    })),
    plans: list(z.object({
      item: z.string(),
      planMicros: micros,
      note: z.string(),
      source: z.string(),
      setAt: z.string().optional(),
    })),
    pagePlans: list(z.object({ page: z.string(), perDayMicros: micros })),
    result: z.object({
      turnoverMicros: micros,
      earnedMicros: micros,
      expensesMicros: micros,
      decisionMicros: micros.nullable(),
      decisionAtCloseMicros: micros.nullable(),
    }).nullable(),
  })),
});

type LedgerApp = Pick<AppContext, "config" | "logger">;

/** One call of the ledger with Hub's budgets key: the answer's JSON, or a 503 (not connected, no answer, refused);
 *  the ledger's 400 on a write is the owner's 400 with its words. */
async function ledgerCall(
  app: LedgerApp,
  method: "GET" | "POST",
  path: string,
  options: { fetchImpl?: typeof fetch | undefined; body?: unknown },
): Promise<unknown> {
  const key = app.config.ledgerBudgetsKey ?? null;
  if (key === null) throw new ServiceUnavailableError("The ledger is not connected: LEDGER_BUDGETS_KEY is not set");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const url = new URL(path, app.config.ledgerUrl ?? "https://ledger.gosling-agency.ru");
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        "user-agent": "agency-hub/money-budgets",
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(LEDGER_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ServiceUnavailableError(`The ledger did not answer ${method} ${path} (${error instanceof Error ? error.name : "error"})`);
  }
  if (!response.ok) {
    if (response.status === 400 && method === "POST") {
      const body = await response.json().catch(() => null) as { error?: unknown } | null;
      throw new BadRequestError(typeof body?.error === "string" ? `The ledger refused: ${body.error}` : "The ledger refused the plan");
    }
    await response.body?.cancel().catch(() => undefined);
    throw new ServiceUnavailableError(`The ledger answered ${method} ${path} with ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new ServiceUnavailableError(`The ledger's ${method} ${path} answered with no JSON`);
  }
}

/** The month after `month` (ГГГГ-ММ). */
export function nextMonth(month: string): string {
  const [year, mm] = month.split("-").map(Number) as [number, number];
  return mm === 12 ? `${year + 1}-01` : `${year}-${String(mm + 1).padStart(2, "0")}`;
}

/** Days of `month` gone by on Moscow day `today`, today counted. */
export function elapsedDays(month: string, days: number, today: string): number {
  const current = today.slice(0, 7);
  if (month < current) return days;
  if (month > current) return 0;
  return Math.min(days, Number(today.slice(8, 10)));
}

type PageNet = { pageLabel: string; modelName: string; platform: Platform; netMills: bigint };

/** A month's pages: those with turnover or a plan, the ledger's plan joined by Hub's page label; by turnover. */
export function monthPages(net: readonly PageNet[], plans: ReadonlyArray<{ page: string; perDayMicros: number }>): MoneyBudgetPage[] {
  const planByPage = new Map(plans.map((plan) => [plan.page, plan.perDayMicros]));
  const pages: MoneyBudgetPage[] = net
    .filter((page) => page.netMills !== 0n || planByPage.has(page.pageLabel))
    .map((page) => ({
      pageLabel: page.pageLabel,
      modelName: page.modelName,
      platform: page.platform,
      netMicroUsd: millsToMicroUsd(page.netMills),
      planPerDayMicroUsd: planByPage.get(page.pageLabel) ?? null,
    }));
  const known = new Set(net.map((page) => page.pageLabel));
  for (const plan of plans) {
    if (!known.has(plan.page)) {
      pages.push({ pageLabel: plan.page, modelName: "", platform: null, netMicroUsd: 0, planPerDayMicroUsd: plan.perDayMicros });
    }
  }
  return pages.sort((left, right) => right.netMicroUsd - left.netMicroUsd || left.pageLabel.localeCompare(right.pageLabel));
}

export async function readMoneyBudgets(
  app: Pick<AppContext, "db" | "config" | "logger">,
  options: { fetchImpl?: typeof fetch; now?: Date; pageNet?: typeof getPageNetForDays } = {},
): Promise<MoneyBudgetsResponse> {
  const now = options.now ?? new Date();
  const today = toBusinessDate(now);
  const body = await ledgerCall(app, "GET", `/v1/budgets?to=${today.slice(0, 7)}`, { fetchImpl: options.fetchImpl });
  const parsed = ledgerBudgetsSchema.safeParse(body);
  if (!parsed.success) {
    app.logger.warn({ issues: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`) }, "ledger budgets: unexpected answer");
    throw new ServiceUnavailableError("The ledger's GET /v1/budgets answered in a shape Hub does not know");
  }
  const ledger = parsed.data;
  const pageNet = options.pageNet ?? getPageNetForDays;
  const nets = await Promise.all(ledger.months.map((month) => pageNet(app as AppContext, `${month.month}-01`, `${nextMonth(month.month)}-01`, now)));

  const months: MoneyBudgetMonth[] = ledger.months.map((month, index) => ({
    month: month.month,
    days: month.days,
    elapsedDays: elapsedDays(month.month, month.days, today),
    closed: month.closed,
    complete: month.complete,
    rows: month.rows.map((row) => ({
      num: row.num,
      date: row.date,
      kind: row.kind,
      category: row.category,
      counterparty: row.counterparty,
      model: row.model,
      amountMicroUsd: row.amountMicros,
      channel: row.channel ? row.channel : null,
      note: row.note,
      incomplete: row.incomplete ?? false,
      advanceFrom: row.advanceFrom ?? null,
    })),
    plans: month.plans.map((plan) => ({
      item: plan.item,
      planMicroUsd: plan.planMicros,
      note: plan.note,
      source: plan.source,
      setAt: plan.setAt ?? null,
    })),
    pages: monthPages(nets[index] ?? [], month.pagePlans),
    result: month.result === null ? null : {
      turnoverMicroUsd: month.result.turnoverMicros,
      earnedMicroUsd: month.result.earnedMicros,
      expensesMicroUsd: month.result.expensesMicros,
      decisionMicroUsd: month.result.decisionMicros,
      decisionAtCloseMicroUsd: month.result.decisionAtCloseMicros,
    },
  }));

  return {
    months,
    currentMonth: today.slice(0, 7),
    fullLedgerFrom: /^\d{4}-\d{2}-\d{2}$/.test(ledger.fullLedgerFrom) ? ledger.fullLedgerFrom : null,
    modelNames: ledger.modelNames ?? {},
    generatedAt: ledger.generatedAt,
  };
}

/** Micro-USD in whole cents as the ledger's dollars: "1234.50". */
export function dollarsOf(microUsd: number): string {
  const cents = Math.round(microUsd / 10_000);
  return `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export async function setMoneyBudgetPlans(
  app: Pick<AppContext, "config" | "logger">,
  body: MoneyBudgetPlansBody,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<MoneyBudgetPlansResponse> {
  const answer = await ledgerCall(app, "POST", "/v1/budgets/plans", {
    fetchImpl: options.fetchImpl,
    body: {
      source: "console",
      plans: body.plans.map((plan) => ({
        month: plan.month,
        item: plan.item.trim(),
        amount: plan.planMicroUsd === null ? "-" : dollarsOf(plan.planMicroUsd),
        note: plan.note.trim(),
      })),
    },
  });
  const parsed = z.object({ written: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative() }).safeParse(answer);
  if (!parsed.success) throw new ServiceUnavailableError("The ledger's POST /v1/budgets/plans answered in a shape Hub does not know");
  return parsed.data;
}
