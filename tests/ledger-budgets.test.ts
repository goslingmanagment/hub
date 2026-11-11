import { describe, expect, it } from "vitest";

import { readLedgerBudgets } from "../apps/runtime/src/services/ledger-budgets.ts";

/**
 * The owner's «Бюджеты» from the agency ledger: its month cards, the owner's journal lines, the plans and who was paid
 * for traffic, read through the ledger's SQL with Hub's read key. Money leaves in the cents the ledger itself prints; a
 * month the ledger could not count is «неизвестно», never zeros; a changed answer is a 503, never a wrong sum.
 */

function app(key: string | null = "test-read-key", warnings: unknown[] = []) {
  return {
    config: { ledgerUrl: "https://ledger.test", ledgerReadKey: key },
    logger: { warn: (details: unknown) => warnings.push(details), info() {} },
  } as never;
}

function card(overrides: Record<string, unknown> = {}) {
  const totals = { net: 30_000.5, earned: 20_000.257, arrived: 18_000, transit: 1_900.257, stuck: 100, decision: 12_000.004, hold: 0, page: 0, riding: 1_900.257 };
  const lines = [
    { model: "Mia", channel: "Fansly", net: 20_000, earned: 13_500.257, arrived: 13_500.257, hold: 0 },
    { model: "Mia", channel: "OF", net: 9_500.5, earned: 6_000 },
    { model: "Nova", channel: "вне платформ", net: 500, earned: 500 },
    { model: "Ivy", channel: "Fansly", net: 0, earned: 0 },
  ];
  const expenses = {
    // The ledger's floats: 3786.586 prints as 3 786.59, 2594.6476 as 2 594.65; all of the chatters' pay is 6878.9336.
    chat: { Mia: 3_786.586, Nova: 2_594.6476, Ivy: 0 },
    extra: [[326, 0.6, "anna"], [328, 497.1, "boris"]],
    cats: { "AI и разработка": 1_200.5, "Инструменты": 228.27083333333331, "Возврат расхода": -70.46 },
    total: 8_237.25,
    notes: null,
  };
  return { totals, lines, expenses, notes: ["nova-2 не подключена к хабу — не видим"], pages: { "mia-1": 20_000, "mia-of": 9_500.5, "": 3 }, ...overrides };
}

type Row = unknown[];
function cardRow(month: string, body: ReturnType<typeof card>, status = "ok", reason = ""): Row {
  const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));
  return [month, "2026-11-12T00:20:46+03:00", status, reason, json(body.totals), json(body.lines), json(body.expenses), json(body.notes), json(body.pages)];
}

const ANSWERS: Record<string, Row[]> = {
  cards: [cardRow("2026-09", card()), cardRow("2026-10", card()), cardRow("2026-11", card())],
  periods: [["2026-09", "2026-10-14T19:22:53+03:00"]],
  settings: [
    ["category_caps", JSON.stringify({ "AI и разработка": 1000, "Трафик": 800 })],
    ["owner_salary_rate", JSON.stringify({ "2026-01-01": 2500, "2026-10-01": 3500, "2026-11-01": 4000 })],
    ["model_names", JSON.stringify({ Mia: "Мия", Nova: "Нова" })],
  ],
  plans: [["2026-11", "mia-1", 470], ["2026-11", "mia-of", 50.5]],
  commitments: [
    ["reinvest", "Рост Мии в ноябре", "", 2_500_000_000, "once", "2026-11-30"],
    ["reinvest", "Старый кап", "", 700_000_000, "once", "2026-06-30"],
    // What the ledger expects to pay regularly: the plan of a source. One is paid already, one not yet.
    ["contractor", "clip sam", "Подрядчик", 209_000_000, "month", "2026-11-30"],
    ["contractor", "Insta Crew", "Трафик", 30_000_000, "week", "2026-12-01"],
    // Not traffic and not a contractor: no row of the table.
    ["subscription", "Some AI", "AI и разработка", 200_000_000, "month", "2026-12-03"],
  ],
  owner: [
    ["2026-10-08", "expense", "Owner зарплата", 3_000_000_000, "{}"],
    // Paid on the last day of October for November: all of it leaves October.
    ["2026-10-31", "expense", "Owner зарплата", 608_272_500, JSON.stringify({ "за": [{ "месяц": "2026-11", "сумма": 608.2725 }] })],
    ["2026-11-04", "expense", "Owner зарплата", 602_050_000, "{}"],
    ["2026-10-20", "expense", "Owner draw", 5_000_000_000, "{}"],
    ["2026-10-15", "income", "Owner вливание", 100_000_000, "{}"],
    ["2026-09-26", "expense", "Owner вливание", 3_000_000_000, "{}"],
    // In a month before the books were whole: the owner's lines are his there too.
    ["2026-07-30", "income", "Owner вливание", 3_000_000_000, "{}"],
    ["2026-07-26", "expense", "Owner draw", 633_312_200, "{}"],
  ],
  // July: before the ledger's books were whole. What its journal has, by the date of payment.
  early: [
    ["2026-07", "income", "Платформы", "Mia", 11_130_000_000],
    ["2026-07", "income", "Owner вливание", "—", 3_000_000_000],
    ["2026-07", "income", "Возврат расхода", "—", 94_005_000],
    ["2026-07", "expense", "Чаттер зарплата", "Mia", 4_000_000_000],
    ["2026-07", "expense", "Чаттер зарплата", "Mia, Nova", 2_583_000_000],
    ["2026-07", "expense", "Инструменты", "—", 866_714_900],
    ["2026-07", "expense", "Owner draw", "—", 633_312_200],
    // A card's month never comes from the journal, whatever its lines are marked.
    ["2026-09", "income", "Платформы", "Mia", 1_000_000],
  ],
  promotion: [
    ["2026-09", "Трафик", "Reddit Co", "Mia", 290_000_000, 1],
    ["2026-10", "Подрядчик", "Clip Sam", "Mia", 77_004_900, 1],
    ["2026-10", "Подрядчик", "Clip Sam", "Nova", 132_000_000, 1],
    ["2026-11", "SFS", "Shout Crew", "—", 49_990_000, 2],
    ["2026-07", "Трафик", "Reddit Co", "Mia", 700_000_000, 1],
  ],
};

function queryOf(sql: string): string {
  if (sql.includes("FROM cards")) return "cards";
  if (sql.includes("FROM periods")) return "periods";
  if (sql.includes("FROM settings")) return "settings";
  if (sql.includes("FROM month_plans")) return "plans";
  if (sql.includes("FROM commitments")) return "commitments";
  if (sql.includes("incomplete = 1")) return "early";
  if (sql.includes("GROUP BY")) return "promotion";
  if (sql.includes("Owner зарплата")) return "owner";
  throw new Error(`unexpected statement: ${sql}`);
}

function ledger(answers: Record<string, Row[] | { status: number } | { body: unknown }> = ANSWERS, seen: string[] = []) {
  return (async (input: URL, init?: RequestInit) => {
    const name = queryOf((JSON.parse(String(init?.body)) as { sql: string }).sql);
    seen.push(`${init?.method} ${new URL(String(input)).pathname} ${name} ${new Headers(init?.headers).get("authorization")}`);
    const answer = answers[name] ?? [];
    if (!Array.isArray(answer) && "status" in answer) return new Response("{}", { status: answer.status });
    const body = Array.isArray(answer) ? { ok: true, columns: [], rows: answer, truncated: false, durationMs: 1 } : answer.body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

// 12 November, 10:00 in Moscow.
const now = new Date("2026-11-12T07:00:00Z");

describe("readLedgerBudgets", () => {
  it("reads the ledger's SQL with Hub's read key and gives every month in the cents the ledger prints", async () => {
    const seen: string[] = [];
    const result = await readLedgerBudgets(app(), { fetchImpl: ledger(ANSWERS, seen), now });

    expect(seen.sort()).toEqual(["cards", "commitments", "early", "owner", "periods", "plans", "promotion", "settings"].map((name) => `POST /v1/sql ${name} Bearer test-read-key`));
    expect(result.months.map((month) => [month.month, month.state, month.closedAt, month.daysInMonth])).toEqual([
      ["2026-07", "incomplete", null, 31],
      ["2026-09", "closed", "2026-10-14T16:22:53.000Z", 30],
      ["2026-10", "preliminary", null, 31],
      ["2026-11", "open", null, 30],
    ]);
    // The running month is counted to the ledger's cut (12 November, 00:20 in Moscow), a month that is over is whole.
    expect(result.months[3]!.elapsedShare).toBeCloseTo((11 + 20.75 / 60 / 24) / 30, 3);
    expect(result.months[2]!.elapsedShare).toBe(1);
    expect(result.ledgerAsOf).toBe("2026-11-11T21:20:46.000Z");

    const figures = result.months[2]!.figures!;
    expect(figures).toMatchObject({
      turnoverMills: 30_000_500, earnedMills: 20_000_260, arrivedMills: 18_000_000, transitMills: 1_900_260, stuckMills: 100_000,
      expensesMills: 8_237_250, decisionMills: 12_000_000,
      // The decision figure less October's rate, 3 500.
      leftMills: 8_500_000,
      notes: ["nova-2 не подключена к хабу — не видим"],
    });
    // The largest first; a source with nothing in the month is not a row; the models as the ledger names them for people.
    expect(figures.sources).toEqual([
      { model: "Мия", channel: "fansly", channelName: "Fansly", turnoverMills: 20_000_000, earnedMills: 13_500_260 },
      { model: "Мия", channel: "onlyfans", channelName: "OnlyFans", turnoverMills: 9_500_500, earnedMills: 6_000_000 },
      { model: "Нова", channel: "off_platform", channelName: "вне платформ", turnoverMills: 500_000, earnedMills: 500_000 },
    ]);
    expect(figures.pages).toEqual([{ pageLabel: "mia-1", turnoverMills: 20_000_000 }, { pageLabel: "mia-of", turnoverMills: 9_500_500 }]);
    expect(figures.articles).toEqual([
      {
        // The article is the whole sum rounded once (6878.9336), not its rounded parts added up (6878.94).
        key: "chatters", name: "Чаттеры", amountMills: 6_878_930, capMills: null,
        parts: [{ name: "Мия", amountMills: 3_786_590 }, { name: "Нова", amountMills: 2_594_650 }, { name: "Сверх таблиц", amountMills: 497_700 }],
      },
      { key: "AI и разработка", name: "AI и разработка", amountMills: 1_200_500, capMills: 1_000_000, parts: [] },
      { key: "Инструменты", name: "Инструменты", amountMills: 228_270, capMills: null, parts: [] },
      { key: "Возврат расхода", name: "Возврат расхода", amountMills: -70_460, capMills: null, parts: [] },
    ]);
    // An article with a limit and nothing spent stays out: the card has no such line.
    expect(figures.articles.some((article) => article.key === "Трафик")).toBe(false);
  });

  it("puts the owner's lines into the month they are for, and the plans into theirs", async () => {
    const result = await readLedgerBudgets(app(), { fetchImpl: ledger(), now });
    const [july, september, october, november] = result.months;

    // No CEO rate before the books were whole; what the owner put in and took out is in the month of payment.
    expect(july!.owner).toEqual({ salaryRateMills: null, salaryPaidMills: 0, drawMills: 633_310, injectionMills: 3_000_000 });
    expect(september!.owner).toEqual({ salaryRateMills: 2_500_000, salaryPaidMills: 0, drawMills: 0, injectionMills: -3_000_000 });
    expect(october!.owner).toEqual({ salaryRateMills: 3_500_000, salaryPaidMills: 3_000_000, drawMills: 5_000_000, injectionMills: 100_000 });
    // 608.2725 moved from October plus 602.05 paid in November: added exactly, rounded once.
    expect(november!.owner).toEqual({ salaryRateMills: 4_000_000, salaryPaidMills: 1_210_320, drawMills: 0, injectionMills: 0 });

    expect(october!.plan).toEqual({ turnoverMills: null, factMills: null, pages: [], reinvest: [] });
    expect(november!.plan).toEqual({
      turnoverMills: 15_615_000,
      // mia-1 and mia-of of the card, added before rounding.
      factMills: 29_500_500,
      pages: [{ pageLabel: "mia-1", perDayMills: 470_000, planMills: 14_100_000 }, { pageLabel: "mia-of", perDayMills: 50_500, planMills: 1_515_000 }],
      reinvest: [{ name: "Рост Мии в ноябре", capMills: 2_500_000 }],
    });
  });

  it("lays traffic and contractors out by source and month, a counterparty's models joined", async () => {
    const { promotion } = await readLedgerBudgets(app(), { fetchImpl: ledger(), now });

    // The months are all of the books', the early one too. A regular payment is the source's plan, whatever the case of
    // its name, and a week's payment is 52/12 of a month's; a source that is expected and not paid yet is there with zeros.
    expect(promotion.months).toEqual(["2026-07", "2026-09", "2026-10", "2026-11"]);
    expect(promotion.sources).toEqual([
      { kind: "traffic", category: "Трафик", counterparty: "Reddit Co", model: "Мия", byMonth: [700_000, 290_000, 0, 0], totalMills: 990_000, payments: 2, regular: null },
      { kind: "contractor", category: "Подрядчик", counterparty: "Clip Sam", model: "Мия, Нова", byMonth: [0, 0, 209_000, 0], totalMills: 209_000, payments: 2, regular: { amountMills: 209_000, period: "month", monthlyMills: 209_000 } },
      { kind: "traffic", category: "SFS", counterparty: "Shout Crew", model: "", byMonth: [0, 0, 0, 49_990], totalMills: 49_990, payments: 2, regular: null },
      { kind: "traffic", category: "Трафик", counterparty: "Insta Crew", model: "", byMonth: [0, 0, 0, 0], totalMills: 0, payments: 0, regular: { amountMills: 30_000, period: "week", monthlyMills: 130_000 } },
    ]);
    expect(promotion.totals).toEqual([
      { month: "2026-07", trafficMills: 700_000, contractorMills: 0 },
      { month: "2026-09", trafficMills: 290_000, contractorMills: 0 },
      { month: "2026-10", trafficMills: 0, contractorMills: 209_000 },
      { month: "2026-11", trafficMills: 49_990, contractorMills: 0 },
    ]);
  });

  it("says a month the ledger could not count is unknown, never zeros", async () => {
    const stale = cardRow("2026-10", card(), "unknown", "таблицы выплат не разобраны");
    const never = ["2026-11", "2026-11-12T00:20:46+03:00", "unknown", "", null, null, null, null, "{}"];
    const result = await readLedgerBudgets(app(), { fetchImpl: ledger({ ...ANSWERS, cards: [cardRow("2026-09", card()), stale, never] }), now });

    expect(result.months.map((month) => [month.month, month.figures === null, month.unknownReason])).toEqual([
      ["2026-07", false, null],
      ["2026-09", false, null],
      ["2026-10", true, "таблицы выплат не разобраны"],
      ["2026-11", true, "the ledger gave no reason"],
    ]);
    // What does not come from the card is still said.
    expect(result.months[2]!.owner.salaryRateMills).toBe(3_500_000);
    expect(result.months[3]!.plan).toMatchObject({ turnoverMills: 15_615_000, factMills: null });
  });

  it("shows a month before the books were whole as what the journal has, marked incomplete", async () => {
    const result = await readLedgerBudgets(app(), { fetchImpl: ledger(), now });
    const july = result.months[0]!;

    expect(july).toMatchObject({ month: "2026-07", state: "incomplete", elapsedShare: 1, unknownReason: null });
    expect(july.plan).toEqual({ turnoverMills: null, factMills: null, pages: [], reinvest: [] });
    // What came in stands for the turnover, the earned and the arrived; the owner's own lines are neither income nor expenses.
    expect(july.figures).toEqual({
      turnoverMills: 11_130_000, earnedMills: 11_130_000, arrivedMills: 11_130_000, transitMills: 0, stuckMills: 0,
      sources: [{ model: "Мия", channel: "other", channelName: "Платформы", turnoverMills: 11_130_000, earnedMills: 11_130_000 }],
      pages: [],
      // 6583.00 + 866.7149 − 94.005, added exactly and rounded once.
      expensesMills: 7_355_710,
      articles: [
        { key: "chatters", name: "Чаттеры", amountMills: 6_583_000, capMills: null, parts: [] },
        { key: "Инструменты", name: "Инструменты", amountMills: 866_710, capMills: null, parts: [] },
        { key: "Возврат расхода", name: "Возврат расхода", amountMills: -94_010, capMills: null, parts: [] },
      ],
      decisionMills: 3_774_290,
      // No CEO rate then: what is left is income less expenses.
      leftMills: 3_774_290,
      notes: [],
    });
  });

  it("answers 503 when the ledger is not connected, refuses, or answers in a shape Hub does not know", async () => {
    await expect(readLedgerBudgets(app(null), { fetchImpl: ledger(), now })).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("LEDGER_READ_KEY") });
    await expect(readLedgerBudgets(app(), { fetchImpl: ledger({ ...ANSWERS, owner: { status: 403 } }), now })).rejects.toMatchObject({ statusCode: 503 });
    // A cut answer is a part of the money.
    const cut = { body: { ok: true, columns: [], rows: ANSWERS.promotion, truncated: true } };
    await expect(readLedgerBudgets(app(), { fetchImpl: ledger({ ...ANSWERS, promotion: cut }), now })).rejects.toMatchObject({ statusCode: 503 });

    const warnings: unknown[] = [];
    const renamed = cardRow("2026-10", card({ totals: { net: 1, earned: 1, arrived: 1, in_transit: 0, stuck: 0, decision: 1 } }));
    await expect(readLedgerBudgets(app("test-read-key", warnings), { fetchImpl: ledger({ ...ANSWERS, cards: [renamed] }), now })).rejects.toMatchObject({ statusCode: 503 });
    expect(warnings).toHaveLength(1);
    await expect(readLedgerBudgets(app(), { fetchImpl: ledger({ ...ANSWERS, settings: [["owner_salary_rate", "не число"]] }), now })).rejects.toMatchObject({ statusCode: 503 });
  });
});
