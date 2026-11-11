/**
 * Деньги → Бюджеты: a month of the ledger's answer as the screen reads it. Pure
 * sums over the ledger's rows, so every number on the screen is the sum of the
 * rows its line opens: what came in by source, what went out by item against
 * its plan, traffic by channel, the pages' turnover against their plan.
 *
 * - Пришло: income rows (not the owner's money put in, not refunds).
 * - Ушло: expense rows less refunds («Возврат расхода» makes expenses smaller).
 * - Прибыль: the month's result by the ledger's rules, as the closes count it since
 *   September 2026: the decision figure (at close for a closed month) less the
 *   CEO's salary plan. Кассой: пришло − ушло. The owner's draw is no expense.
 */
import type { MoneyBudgetMonth, MoneyBudgetPage, MoneyBudgetRow, MoneyBudgetsResponse } from "@agency_hub_core/contracts";

/** The plan of the agency's income: an item with no category of its own. */
export const INCOME_ITEM = "Доход";

/** The short names of the ledger's categories; another category is shown as the ledger names it. */
const ITEM_LABELS: Readonly<Record<string, string>> = {
  "Чаттер зарплата": "Чаттеры",
  "Owner зарплата": "Зарплата CEO",
  "КМ зарплата": "КМ",
  "AI и разработка": "ИИ и разработка",
  "Подрядчик": "Подрядчики",
  "Custom": "Кастомы",
  "Платформы": "Платформы",
};

export function itemLabel(item: string): string {
  return ITEM_LABELS[item] ?? item;
}

/** The items a new month's budget offers, in the closes' order. */
export const BUDGET_ITEMS: readonly string[] = [
  "Чаттер зарплата", "Owner зарплата", "КМ зарплата", "Трафик", "Подрядчик", "AI и разработка",
  "Инструменты", "Комиссии", "Доля модели", "Прочее",
];

export interface MoneyLine {
  key: string;
  label: string;
  /** A quiet word beside the label. */
  sub: string;
  amount: number;
  rows: MoneyBudgetRow[];
}

export interface ItemLine extends MoneyLine {
  /** The ledger's item: the plan is written under it. */
  item: string;
  plan: number | null;
  planNote: string;
  /** plan — the owner's; rate — the CEO's rate standing in. */
  planSource: string | null;
}

export interface TrafficLine extends MoneyLine {
  /** The models the channel was paid for. */
  models: string[];
}

export interface PageLine {
  pageLabel: string;
  modelName: string;
  platform: MoneyBudgetPage["platform"];
  net: number;
  /** The page's plan for the whole month; null — none. */
  planMonth: number | null;
  /** The plan for the days gone by. */
  planToDate: number | null;
}

export interface MonthView {
  month: string;
  /** «Ноябрь 2026». */
  label: string;
  /** «нояб.». */
  short: string;
  days: number;
  elapsed: number;
  current: boolean;
  closed: boolean;
  complete: boolean;
  income: number;
  incomeLines: MoneyLine[];
  /** The plan of «Доход», on the ledger's «заработано» basis. */
  incomePlan: number | null;
  earned: number | null;
  /** Went out, refunds taken off. */
  spent: number;
  refunds: number;
  refundRows: MoneyBudgetRow[];
  itemLines: ItemLine[];
  /** The sum of the plans of the items that have one; null — no plan at all. */
  planSpent: number | null;
  /** Spent on items without a plan, when the month has one. */
  unplanned: number;
  /** The owner's plans (not a rate standing in): the month has a budget written. */
  hasOwnPlans: boolean;
  /** The month's result: decision figure − the CEO's salary plan; null — the ledger has no figure. */
  profit: number | null;
  /** The CEO's salary plan taken off the decision figure; null — none. */
  ceoPlan: number | null;
  /** Пришло − ушло. */
  cash: number;
  ownerIn: number;
  ownerOut: number;
  ownerRows: MoneyBudgetRow[];
  traffic: number;
  trafficLines: TrafficLine[];
  turnover: number;
  turnoverPlanMonth: number | null;
  turnoverPlanToDate: number | null;
  pages: PageLine[];
  decision: number | null;
  decisionAtClose: number | null;
}

const sum = (rows: readonly MoneyBudgetRow[]) => rows.reduce((total, row) => total + row.amountMicroUsd, 0);

function monthDate(month: string): Date {
  return new Date(`${month}-15T12:00:00Z`);
}

export function monthLabel(month: string): string {
  const name = new Intl.DateTimeFormat("ru-RU", { month: "long", timeZone: "UTC" }).format(monthDate(month));
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${month.slice(0, 4)}`;
}

/** «нояб.», «май», «июль»: Intl puts the dot only where it shortens. */
export function monthShort(month: string): string {
  return new Intl.DateTimeFormat("ru-RU", { month: "short", timeZone: "UTC" }).format(monthDate(month));
}

/** The month before `month`. */
export function previousMonth(month: string): string {
  const [year, mm] = month.split("-").map(Number) as [number, number];
  return mm === 1 ? `${year - 1}-12` : `${year}-${String(mm - 1).padStart(2, "0")}`;
}

function modelName(code: string, names: Readonly<Record<string, string>>): string {
  if (!code) return "";
  return code.split(",").map((part) => names[part.trim()] ?? part.trim()).join(", ");
}

function byAmount<T extends { amount: number; label: string }>(left: T, right: T): number {
  return right.amount - left.amount || left.label.localeCompare(right.label, "ru");
}

function group<T extends MoneyLine>(rows: readonly MoneyBudgetRow[], keyOf: (row: MoneyBudgetRow) => { key: string; label: string; sub: string }, make: (base: MoneyLine) => T): T[] {
  const lines = new Map<string, MoneyLine>();
  for (const row of rows) {
    const { key, label, sub } = keyOf(row);
    const line = lines.get(key) ?? { key, label, sub, amount: 0, rows: [] };
    line.amount += row.amountMicroUsd;
    line.rows.push(row);
    lines.set(key, line);
  }
  return [...lines.values()].map(make).sort(byAmount);
}

export function monthView(month: MoneyBudgetMonth, data: Pick<MoneyBudgetsResponse, "currentMonth" | "modelNames">): MonthView {
  const names = data.modelNames;
  const of = (kind: MoneyBudgetRow["kind"]) => month.rows.filter((row) => row.kind === kind);
  const incomeRows = of("income");
  const expenseRows = of("expense");
  const refundRows = of("refund");
  const ownerRows = [...of("owner_in"), ...of("owner_out")].sort((left, right) => left.date.localeCompare(right.date) || left.num - right.num);

  const incomeLines = group(incomeRows, (row) => row.category === "Платформы"
    ? { key: `platform:${row.model}`, label: modelName(row.model, names) || "Платформы", sub: "платформы" }
    : { key: `item:${row.category}`, label: itemLabel(row.category), sub: row.category === "Custom" ? "мимо платформ" : "" }, (line) => line);

  const plans = new Map(month.plans.map((plan) => [plan.item, plan]));
  const facts = new Map<string, MoneyBudgetRow[]>();
  for (const row of expenseRows) facts.set(row.category, [...(facts.get(row.category) ?? []), row]);
  const items = new Set([...facts.keys(), ...month.plans.map((plan) => plan.item).filter((item) => item !== INCOME_ITEM)]);
  const itemLines: ItemLine[] = [...items].map((item) => {
    const rows = facts.get(item) ?? [];
    const plan = plans.get(item);
    return {
      key: item, item, label: itemLabel(item), sub: "", amount: sum(rows), rows,
      plan: plan?.planMicroUsd ?? null, planNote: plan?.note ?? "", planSource: plan?.source ?? null,
    };
  }).sort((left, right) => right.amount - left.amount || (right.plan ?? 0) - (left.plan ?? 0) || left.label.localeCompare(right.label, "ru"));
  const planned = itemLines.filter((line) => line.plan !== null);

  const trafficLines = group(expenseRows.filter((row) => row.channel !== null), (row) => ({ key: row.channel!, label: row.channel!, sub: "" }), (line) => ({
    ...line,
    models: [...new Set(line.rows.map((row) => modelName(row.model, names)).filter(Boolean))].sort(),
  }));

  const perDayPlan = month.pages.reduce((total, page) => total + (page.planPerDayMicroUsd ?? 0), 0);
  const hasPagePlan = month.pages.some((page) => page.planPerDayMicroUsd !== null);
  const pages: PageLine[] = month.pages.map((page) => ({
    pageLabel: page.pageLabel,
    modelName: page.modelName,
    platform: page.platform,
    net: page.netMicroUsd,
    planMonth: page.planPerDayMicroUsd === null ? null : page.planPerDayMicroUsd * month.days,
    planToDate: page.planPerDayMicroUsd === null ? null : page.planPerDayMicroUsd * month.elapsedDays,
  }));

  const income = sum(incomeRows);
  const refunds = sum(refundRows);
  const spent = sum(expenseRows) - refunds;
  const incomePlan = plans.get(INCOME_ITEM)?.planMicroUsd ?? null;
  const decision = month.result?.decisionAtCloseMicroUsd ?? month.result?.decisionMicroUsd ?? null;
  const ceoPlan = plans.get("Owner зарплата")?.planMicroUsd ?? null;
  return {
    month: month.month,
    label: monthLabel(month.month),
    short: monthShort(month.month),
    days: month.days,
    elapsed: month.elapsedDays,
    current: month.month === data.currentMonth,
    closed: month.closed,
    complete: month.complete,
    income,
    incomeLines,
    incomePlan,
    earned: month.result?.earnedMicroUsd ?? null,
    spent,
    refunds,
    refundRows,
    itemLines,
    planSpent: planned.length > 0 ? planned.reduce((total, line) => total + (line.plan ?? 0), 0) : null,
    unplanned: planned.length > 0 ? itemLines.filter((line) => line.plan === null).reduce((total, line) => total + line.amount, 0) : 0,
    hasOwnPlans: month.plans.some((plan) => plan.source === "plan"),
    profit: decision === null ? null : decision - (ceoPlan ?? 0),
    ceoPlan,
    cash: income - spent,
    ownerIn: sum(of("owner_in")),
    ownerOut: sum(of("owner_out")),
    ownerRows,
    traffic: trafficLines.reduce((total, line) => total + line.amount, 0),
    trafficLines,
    turnover: month.pages.reduce((total, page) => total + page.netMicroUsd, 0),
    turnoverPlanMonth: hasPagePlan ? perDayPlan * month.days : null,
    turnoverPlanToDate: hasPagePlan ? perDayPlan * month.elapsedDays : null,
    pages,
    decision: month.result?.decisionMicroUsd ?? null,
    decisionAtClose: month.result?.decisionAtCloseMicroUsd ?? null,
  };
}

/** Every month of the answer, oldest first. */
export function monthViews(data: MoneyBudgetsResponse): MonthView[] {
  return data.months.map((month) => monthView(month, data));
}

/** Micro-USD as dollars: whole by default, cents when asked. «−» for a minus. */
export function formatUsd(microUsd: number, options: { cents?: boolean; sign?: boolean } = {}): string {
  const cents = options.cents ?? false;
  const value = cents ? Math.round(microUsd / 10_000) / 100 : Math.round(microUsd / 1_000_000);
  const text = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
  }).format(Math.abs(value));
  if (value < 0) return `−${text}`;
  if (options.sign && value > 0) return `+${text}`;
  return text;
}

/** «$1,234.5» typed by the owner → micro-USD in whole cents; null — not a sum. */
export function parseUsd(text: string): number | null {
  let clean = text.replace(/[\s$\u00a0]/g, "");
  // «1234,5» is a decimal comma; «1,234.50» groups thousands.
  clean = /^\d+,\d{1,2}$/.test(clean) ? clean.replace(",", ".") : clean.replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.split(".") as [string, string?];
  return (Number(whole) * 100 + Number(fraction.padEnd(2, "0"))) * 10_000;
}
