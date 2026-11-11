import { describe, expect, it } from "vitest";

import { dollarsOf, elapsedDays, readMoneyBudgets, setMoneyBudgetPlans } from "../apps/runtime/src/services/ledger-budgets.ts";

/** The budget from the agency ledger: its micro-dollars passed on exactly, Hub's page turnover joined to the
 *  page plans, never a wrong sum on a changed answer, the owner's plan written in whole cents. */

function app(key: string | null = "test-budgets-key") {
  return {
    db: {},
    config: { ledgerUrl: "https://ledger.test", ledgerBudgetsKey: key },
    logger: { warn: () => undefined },
  } as never;
}

function ledgerAnswer(overrides: Record<string, unknown> = {}) {
  return {
    from: "2026-10",
    to: "2026-11",
    fullLedgerFrom: "2026-08-01",
    generatedAt: "2026-11-12T10:00:00+03:00",
    modelNames: { Mia: "Мия" },
    months: [
      {
        month: "2026-10", days: 31, closed: false, complete: true,
        rows: [
          { num: 1, date: "2026-10-03", kind: "income", category: "Платформы", counterparty: "Модель", model: "Mia", amountMicros: 1_000_123_400, note: "" },
          { num: 2, date: "2026-10-04", kind: "expense", category: "Трафик", counterparty: "Студия", model: "Mia", amountMicros: 290_000_000, channel: "Instagram", note: "ведение" },
        ],
        plans: [{ item: "Трафик", planMicros: 300_000_000, note: "", source: "plan", setAt: "2026-10-01T10:00:00+03:00" }],
        pagePlans: null,
        result: { turnoverMicros: 5_000_000_000, earnedMicros: 3_400_000_000, expensesMicros: 1_200_000_000, decisionMicros: 2_190_000_000, decisionAtCloseMicros: null },
      },
      {
        month: "2026-11", days: 30, closed: false, complete: true,
        rows: [
          { num: 3, date: "2026-10-31", kind: "expense", category: "Owner зарплата", counterparty: "Владелец", model: "", amountMicros: 608_272_500, note: "аванс", advanceFrom: "2026-10" },
        ],
        plans: [{ item: "Owner зарплата", planMicros: 4_000_000_000, note: "ставка CEO с 2026-11-01", source: "rate" }],
        pagePlans: [{ page: "mia-1", perDayMicros: 120_000_000 }, { page: "gone-1", perDayMicros: 5_000_000 }],
        result: null,
      },
    ],
    ...overrides,
  };
}

function fetchReturning(status: number, body: unknown, seen: { url?: string; auth?: string | null; body?: unknown } = {}) {
  return (async (input: URL, init?: RequestInit) => {
    seen.url = String(input);
    seen.auth = new Headers(init?.headers).get("authorization");
    seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const pageNet = (async (_app: unknown, from: string) => from === "2026-11-01"
  ? [
    { pageLabel: "mia-1", modelName: "Mia", platform: "fansly", netMills: 1_234_567n },
    { pageLabel: "mia-2", modelName: "Mia", platform: "fansly", netMills: 0n },
    { pageLabel: "nova-of", modelName: "Nova", platform: "onlyfans", netMills: 2_000_000n },
  ]
  : []) as never;

describe("readMoneyBudgets", () => {
  it("passes the ledger's months on exactly and joins each page's turnover to its plan", async () => {
    const seen: { url?: string; auth?: string | null } = {};
    const result = await readMoneyBudgets(app(), { fetchImpl: fetchReturning(200, ledgerAnswer(), seen), now: new Date("2026-11-12T07:00:00Z"), pageNet });

    expect(seen.url).toBe("https://ledger.test/v1/budgets?to=2026-11");
    expect(seen.auth).toBe("Bearer test-budgets-key");
    expect(result.currentMonth).toBe("2026-11");
    expect(result.fullLedgerFrom).toBe("2026-08-01");
    expect(result.modelNames).toEqual({ Mia: "Мия" });
    const [october, november] = result.months;
    expect(october).toMatchObject({ month: "2026-10", elapsedDays: 31, pages: [] });
    expect(october!.rows.map((row) => [row.num, row.amountMicroUsd, row.channel])).toEqual([[1, 1_000_123_400, null], [2, 290_000_000, "Instagram"]]);
    expect(october!.result?.decisionMicroUsd).toBe(2_190_000_000);
    expect(november!.elapsedDays).toBe(12);
    expect(november!.rows[0]).toMatchObject({ amountMicroUsd: 608_272_500, advanceFrom: "2026-10", channel: null, incomplete: false });
    expect(november!.plans[0]).toMatchObject({ source: "rate", setAt: null });
    // A page with neither turnover nor plan is left out; a plan's page Hub does not know is kept, with no turnover.
    expect(november!.pages).toEqual([
      { pageLabel: "nova-of", modelName: "Nova", platform: "onlyfans", netMicroUsd: 2_000_000_000, planPerDayMicroUsd: null },
      { pageLabel: "mia-1", modelName: "Mia", platform: "fansly", netMicroUsd: 1_234_567_000, planPerDayMicroUsd: 120_000_000 },
      { pageLabel: "gone-1", modelName: "", platform: null, netMicroUsd: 0, planPerDayMicroUsd: 5_000_000 },
    ]);
  });

  it("is a 503, never a wrong sum, when the ledger is not connected, refuses or changed its answer", async () => {
    const now = new Date("2026-11-12T07:00:00Z");
    await expect(readMoneyBudgets(app(null), { now, pageNet })).rejects.toMatchObject({ statusCode: 503 });
    await expect(readMoneyBudgets(app(), { fetchImpl: fetchReturning(403, { error: "нет права" }), now, pageNet })).rejects.toMatchObject({ statusCode: 503 });
    const changed = ledgerAnswer();
    (changed.months[0]!.rows[0] as Record<string, unknown>).amountMicros = "1000.12";
    await expect(readMoneyBudgets(app(), { fetchImpl: fetchReturning(200, changed), now, pageNet })).rejects.toMatchObject({ statusCode: 503 });
  });
});

describe("setMoneyBudgetPlans", () => {
  it("writes whole cents as the ledger's dollars, a removal as «-», and passes the ledger's refusal on as a 400", async () => {
    const seen: { body?: unknown } = {};
    const result = await setMoneyBudgetPlans(app(), { plans: [
      { month: "2026-12", item: " Трафик ", planMicroUsd: 1_234_500_000, note: " тест " },
      { month: "2026-12", item: "Прочее", planMicroUsd: null, note: "" },
    ] }, { fetchImpl: fetchReturning(200, { written: 2, unchanged: 0 }, seen) });
    expect(result).toEqual({ written: 2, unchanged: 0 });
    expect(seen.body).toEqual({ source: "console", plans: [
      { month: "2026-12", item: "Трафик", amount: "1234.50", note: "тест" },
      { month: "2026-12", item: "Прочее", amount: "-", note: "" },
    ] });
    await expect(setMoneyBudgetPlans(app(), { plans: [{ month: "2026-12", item: "Трафик", planMicroUsd: 0, note: "" }] }, {
      fetchImpl: fetchReturning(400, { error: "plans[0].month: нужен месяц" }),
    })).rejects.toMatchObject({ statusCode: 400, message: "The ledger refused: plans[0].month: нужен месяц" });
  });

  it("counts days and dollars plainly", () => {
    expect(elapsedDays("2026-10", 31, "2026-11-12")).toBe(31);
    expect(elapsedDays("2026-11", 30, "2026-11-12")).toBe(12);
    expect(elapsedDays("2026-12", 31, "2026-11-12")).toBe(0);
    expect(dollarsOf(0)).toBe("0.00");
    expect(dollarsOf(50_000)).toBe("0.05");
    expect(dollarsOf(1_000_000_000)).toBe("1000.00");
  });
});
