import { describe, expect, it } from "vitest";

import { monthCardOf, monthDays, readTeamLedgerMonth } from "../apps/runtime/src/services/ledger-month.ts";

// Деньги → Месяц: the ledger's month card on Hub's screen to the cent (its money through payMillsOf), and the honest
// states of a ledger that does not serve the month yet or does not answer.

const card = {
  month: "2026-11", status: "proven", reason: null, asOf: "2026-11-12T15:00:00Z", computedAt: "2026-11-12T15:05:00Z",
  pagesNet: 12_539.23, offPlatform: 410, turnover: 12_949.23, earned: 5_471.48, arrived: 3_009.31, riding: 1_094.3,
  hold: 437.72, stuck: 109.43, onPage: 820.72,
  models: [{ model: "Mia Hart", pagesNet: 9_780.6, offPlatform: 410, earned: 4_267.75, arrived: 2_347.26, riding: 853.55 }],
  notes: ["a page without a route: not in the figure"],
};

const app = (fetchImpl: typeof fetch) => ({
  config: { ledgerPayoutsKey: "test-key", ledgerUrl: "http://ledger.test" } as never,
  logger: { warn: () => undefined } as never,
  fetchImpl,
});

const answer = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("the ledger's month card on Hub", () => {
  it("keeps the ledger's money to the cent, in mills", () => {
    const shown = monthCardOf(card, "2026-11");
    expect(shown).toMatchObject({
      status: "proven", pagesNetMills: 12_539_230, offPlatformMills: 410_000, turnoverMills: 12_949_230, earnedMills: 5_471_480,
      arrivedMills: 3_009_310, ridingMills: 1_094_300, holdMills: 437_720, stuckMills: 109_430, onPageMills: 820_720,
    });
    expect(shown.models[0]).toMatchObject({ model: "Mia Hart", pagesNetMills: 9_780_600, earnedMills: 4_267_750 });
  });

  it("takes micro-dollars too, rounded to the ledger's whole cents half to even", () => {
    const micros = { ...card, pagesNet: undefined, pagesNetMicros: 12_539_225_000, models: [] };
    expect(monthCardOf(micros, "2026-11").pagesNetMills).toBe(12_539_220);
    expect(monthCardOf({ ...micros, pagesNetMicros: 12_539_235_000 }, "2026-11").pagesNetMills).toBe(12_539_240);
  });

  it("refuses an answer of another month or without its money", () => {
    expect(() => monthCardOf(card, "2026-10")).toThrow(/another month/);
    expect(() => monthCardOf({ ...card, earned: undefined }, "2026-11")).toThrow(/earned/);
  });

  it("an older ledger without the read is «not served», not an error; a ledger that does not answer is a 503", async () => {
    const { fetchImpl, ...ctx } = app(answer(404));
    await expect(readTeamLedgerMonth(ctx, { month: "2026-11" }, { fetchImpl })).resolves.toMatchObject({ served: false, card: null, from: "2026-11-01", to: "2026-11-30" });
    const down = app(answer(500));
    await expect(readTeamLedgerMonth(down, { month: "2026-11" }, { fetchImpl: down.fetchImpl })).rejects.toThrow(/answered GET/);
    const ok = app(answer(200, card));
    await expect(readTeamLedgerMonth(ok, { month: "2026-11" }, { fetchImpl: ok.fetchImpl })).resolves.toMatchObject({ served: true, card: { pagesNetMills: 12_539_230 } });
  });

  it("a month is its Moscow days", () => {
    expect(monthDays("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthDays("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });
});
