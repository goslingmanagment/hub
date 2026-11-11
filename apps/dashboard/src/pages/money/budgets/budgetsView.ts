import type { AdminBudgetsResponse, BudgetMonth } from "@agency_hub_core/contracts";

/**
 * What «Бюджеты» say about a month without touching its money: names, shares, the place of the month among the
 * others. Sums come from the hub as they are; here they are only compared (a share is a number for the eye).
 */

const LONG = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const SHORT = ["янв.", "февр.", "март", "апр.", "май", "июнь", "июль", "авг.", "сент.", "окт.", "нояб.", "дек."];

function parts(month: string): { year: string; index: number } {
  return { year: month.slice(0, 4), index: Number(month.slice(5, 7)) - 1 };
}

/** «Ноябрь 2026». */
export function monthLong(month: string): string {
  const { year, index } = parts(month);
  return `${LONG[index] ?? month} ${year}`;
}

/** «нояб.»; with the year where a row of months crosses it: «янв. 2027». */
export function monthShort(month: string, withYear = false): string {
  const { year, index } = parts(month);
  return withYear ? `${SHORT[index] ?? month} ${year}` : SHORT[index] ?? month;
}

/** A row of months names the year on its first month and on every January. */
export function monthAxisLabel(month: string, months: readonly string[]): string {
  return monthShort(month, month === months[0] || month.endsWith("-01"));
}

/** A part of a whole in percent for the eye; null — nothing to compare with. */
export function shareOf(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

/** The running month's day at the ledger's cut: 12 of 30. */
export function runningDay(month: BudgetMonth): number {
  return Math.min(month.daysInMonth, Math.floor(month.elapsedShare * month.daysInMonth) + 1);
}

/** The month the address asks for, else the newest one. */
export function pickMonth(data: AdminBudgetsResponse, asked: string | null): { month: BudgetMonth; index: number } | null {
  const index = data.months.findIndex((month) => month.month === asked);
  const found = index >= 0 ? index : data.months.length - 1;
  const month = data.months[found];
  return month ? { month, index: found } : null;
}

/** The six months a table shows around the chosen one: the newest ones unless an older month is chosen. */
export function monthWindow(count: number, chosen: number, size = 6): { from: number; to: number } {
  const from = Math.max(0, Math.min(count - size, chosen - (size - 3)));
  return { from, to: Math.min(count, from + size) };
}

/** The expense articles of a row of months, each once, the heaviest over the row first (the weight is for the order only). */
export function articleRows(months: readonly BudgetMonth[]): Array<{ key: string; name: string }> {
  const rows = new Map<string, { key: string; name: string; weight: number }>();
  for (const month of months) {
    for (const article of month.figures?.articles ?? []) {
      const row = rows.get(article.key) ?? { key: article.key, name: article.name, weight: 0 };
      row.weight += article.amountMills;
      rows.set(article.key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.weight - a.weight).map(({ key, name }) => ({ key, name }));
}
