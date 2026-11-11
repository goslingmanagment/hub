import { describe, expect, it } from "vitest";
import type { MoneyBudgetMonth, MoneyBudgetRow } from "@agency_hub_core/contracts";

import { formatUsd, monthView, parseUsd } from "../apps/dashboard/src/pages/money/budgets/budgetsModel.ts";

/** Деньги → Бюджеты: every sum on the screen is the sum of the rows it opens, and the month's profit is the
 *  ledger's figure less the CEO's plan, as the closes count it. */

let num = 0;
function row(kind: MoneyBudgetRow["kind"], category: string, dollars: number, extra: Partial<MoneyBudgetRow> = {}): MoneyBudgetRow {
  num += 1;
  return {
    num, date: "2026-10-05", kind, category, counterparty: "Кто-то", model: "", amountMicroUsd: Math.round(dollars * 1_000_000),
    channel: null, note: "", incomplete: false, advanceFrom: null, ...extra,
  };
}

const october: MoneyBudgetMonth = {
  month: "2026-10", days: 31, elapsedDays: 31, closed: false, complete: true,
  rows: [
    row("income", "Платформы", 1000, { model: "Mia" }),
    row("income", "Платформы", 500.5, { model: "Mia" }),
    row("income", "Платформы", 300, { model: "Nova" }),
    row("income", "Custom", 80, { model: "Mia" }),
    row("expense", "Чаттер зарплата", 400),
    row("expense", "Owner зарплата", 600, { advanceFrom: "2026-09" }),
    row("expense", "Трафик", 290, { channel: "Instagram", model: "Mia" }),
    row("expense", "Подрядчик", 30, { channel: "SFS", model: "Mia" }),
    row("expense", "Подрядчик", 50),
    row("expense", "Доля модели", 45),
    row("refund", "Возврат расхода", 20),
    row("owner_out", "Owner draw", 700),
    row("owner_in", "Owner вливание", 100),
  ],
  plans: [
    { item: "Доход", planMicroUsd: 1_500_000_000, note: "", source: "plan", setAt: null },
    { item: "Чаттер зарплата", planMicroUsd: 350_000_000, note: "", source: "plan", setAt: null },
    { item: "Owner зарплата", planMicroUsd: 500_000_000, note: "ставка", source: "rate", setAt: null },
    { item: "Подрядчик", planMicroUsd: 100_000_000, note: "", source: "plan", setAt: null },
    { item: "Прочее", planMicroUsd: 10_000_000, note: "", source: "plan", setAt: null },
  ],
  pages: [
    { pageLabel: "mia-1", modelName: "Mia Hart", platform: "fansly", netMicroUsd: 3_100_000_000, planPerDayMicroUsd: 100_000_000 },
    { pageLabel: "nova-1", modelName: "Nova Lane", platform: "fansly", netMicroUsd: 900_000_000, planPerDayMicroUsd: null },
  ],
  result: { turnoverMicroUsd: 4_000_000_000, earnedMicroUsd: 1_600_000_000, expensesMicroUsd: 800_000_000, decisionMicroUsd: 790_000_000, decisionAtCloseMicroUsd: null },
};

const usd = (micro: number) => micro / 1_000_000;

describe("monthView", () => {
  const view = monthView(october, { currentMonth: "2026-11", modelNames: { Mia: "Mia Hart", Nova: "Nova Lane" } });

  it("adds in and out up from the rows: refunds make expenses smaller, the owner's money is neither", () => {
    expect(usd(view.income)).toBe(1880.5);
    expect(usd(view.spent)).toBe(1395);
    expect(usd(view.cash)).toBe(485.5);
    expect([usd(view.ownerIn), usd(view.ownerOut)]).toEqual([100, 700]);
    expect(view.incomeLines.map((line) => [line.label, usd(line.amount)])).toEqual([["Mia Hart", 1500.5], ["Nova Lane", 300], ["Кастомы", 80]]);
  });

  it("is the decision figure less the CEO's plan, and says what was spent past the plan", () => {
    expect(usd(view.profit!)).toBe(290);
    expect(usd(view.planSpent!)).toBe(960);
    // Трафик 290 and Доля модели 45 have no plan; Прочее has a plan and no spending.
    expect(usd(view.unplanned)).toBe(335);
    const items = Object.fromEntries(view.itemLines.map((line) => [line.item, [usd(line.amount), line.plan === null ? null : usd(line.plan)]]));
    expect(items).toEqual({
      "Owner зарплата": [600, 500], "Чаттер зарплата": [400, 350], "Трафик": [290, null], "Подрядчик": [80, 100], "Доля модели": [45, null], "Прочее": [0, 10],
    });
  });

  it("counts traffic by channel, contractors whose work is traffic in", () => {
    expect(usd(view.traffic)).toBe(320);
    expect(view.trafficLines.map((line) => [line.label, usd(line.amount), line.models])).toEqual([["Instagram", 290, ["Mia Hart"]], ["SFS", 30, ["Mia Hart"]]]);
  });

  it("reads the page plans for the whole month and for the days gone by", () => {
    expect(usd(view.turnover)).toBe(4000);
    expect(usd(view.turnoverPlanMonth!)).toBe(3100);
    expect(view.pages.find((page) => page.pageLabel === "nova-1")?.planMonth).toBeNull();
  });
});

describe("money in and out of the owner's words", () => {
  it("formats whole dollars or cents, a minus as «−»", () => {
    expect(formatUsd(1_234_500_000)).toBe("$1,235");
    expect(formatUsd(1_234_500_000, { cents: true })).toBe("$1,234.50");
    expect(formatUsd(-856_000_000)).toBe("−$856");
    expect(formatUsd(6_817_000_000, { sign: true })).toBe("+$6,817");
  });

  it("reads a typed plan in whole cents, a decimal comma or grouped thousands", () => {
    expect(parseUsd("1200")).toBe(1_200_000_000);
    expect(parseUsd("1234,5")).toBe(1_234_500_000);
    expect(parseUsd("$1,234.56")).toBe(1_234_560_000);
    expect(parseUsd("12.345")).toBeNull();
    expect(parseUsd("abc")).toBeNull();
  });
});
