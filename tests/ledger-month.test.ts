import { MOSCOW_TIME_ZONE, resolvePeriodBounds } from "@agency_hub_core/shared";
import { monthCheck } from "../apps/dashboard/src/pages/money/month/check.ts";
import { monthCut, monthWindow } from "../apps/dashboard/src/pages/money/month/window.ts";
import { describe, expect, it } from "vitest";

import { hubModelNameOf, monthCardOf, monthDays, readTeamLedgerMonth } from "../apps/runtime/src/services/ledger-month.ts";

// Деньги → Месяц: the ledger's month card on Hub's screen to the cent (its money through payMillsOf), and the honest
// states of a ledger that does not serve the month yet or does not answer.

// The ledger's money is integer micro-dollars (ledger#85), as /v1/payouts/person's. Invented amounts.
const card = {
  ok: true, month: "2026-11", status: "proven", reason: null, asOf: "2026-11-12T15:00:00Z", computedAt: "2026-11-12T15:05:00Z",
  pagesNet: 12_539_230_000, offPlatform: 410_000_000, turnover: 12_949_230_000, earned: 5_471_480_000, arrived: 3_009_310_000,
  riding: 1_094_300_000, hold: 437_720_000, stuck: 109_430_000, onPage: 820_720_000,
  models: [{ model: "Mia Hart", pagesNet: 9_780_600_000, offPlatform: 410_000_000, earned: 4_267_750_000, arrived: 2_347_260_000, riding: 853_550_000 }],
  notes: ["a page without a route: not in the figure"],
};

const app = (fetchImpl: typeof fetch) => ({
  db: undefined as never,
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

  it("rounds the ledger's micro-dollars to its whole cents, half to even", () => {
    expect(monthCardOf({ ...card, pagesNet: 12_539_225_000 }, "2026-11").pagesNetMills).toBe(12_539_220);
    expect(monthCardOf({ ...card, pagesNet: 12_539_235_000 }, "2026-11").pagesNetMills).toBe(12_539_240);
  });

  it("a month never computed is unknown with its reason and no money, never a zero", () => {
    const never = { ...card, status: "unknown", reason: "the month was never computed", models: [],
      pagesNet: null, offPlatform: null, turnover: null, earned: null, arrived: null, riding: null, hold: null, stuck: null, onPage: null };
    expect(monthCardOf(never, "2026-11")).toMatchObject({ status: "unknown", reason: "the month was never computed", pagesNetMills: null, earnedMills: null, models: [] });
  });

  it("a failed check keeps the figures beside its reason", () => {
    expect(monthCardOf({ ...card, status: "unknown", reason: "a check failed" }, "2026-11")).toMatchObject({ status: "unknown", reason: "a check failed", pagesNetMills: 12_539_230 });
  });

  it("refuses an answer of another month or without its money", () => {
    expect(() => monthCardOf(card, "2026-10")).toThrow(/another month/);
    expect(() => monthCardOf({ ...card, earned: undefined }, "2026-11")).toThrow(/shape/);
    expect(() => monthCardOf({ ...card, earned: 5_471.48 }, "2026-11")).toThrow(/shape/);
  });

  it("an older ledger without the read is «not served», not an error; a ledger that does not answer is a 503", async () => {
    const { fetchImpl, ...ctx } = app(answer(404));
    await expect(readTeamLedgerMonth(ctx, { month: "2026-11" }, { fetchImpl, models: [] })).resolves.toMatchObject({ served: false, card: null, from: "2026-11-01", to: "2026-11-30" });
    const down = app(answer(500));
    await expect(readTeamLedgerMonth(down, { month: "2026-11" }, { fetchImpl: down.fetchImpl, models: [] })).rejects.toThrow(/answered GET/);
    const ok = app(answer(200, card));
    await expect(readTeamLedgerMonth(ok, { month: "2026-11" }, { fetchImpl: ok.fetchImpl, models: [] })).resolves.toMatchObject({ served: true, card: { pagesNetMills: 12_539_230 } });
  });

  it("Hub's own income of the month is asked up to the next month's first day: the read's upper bound is exclusive", () => {
    expect(monthWindow("2026-10")).toEqual({ from: "2026-10-01", to: "2026-11-01" });
    expect(monthWindow("2026-12")).toEqual({ from: "2026-12-01", to: "2027-01-01" });
    // The last day of the month is inside the window the read resolves, the next month's first instant is not.
    const bounds = resolvePeriodBounds("custom", new Date("2026-11-12T12:00:00Z"), monthWindow("2026-10"), MOSCOW_TIME_ZONE);
    expect(bounds.from?.toISOString()).toBe("2026-09-30T21:00:00.000Z");
    expect(bounds.to?.toISOString()).toBe("2026-10-31T21:00:00.000Z");
  });

  it("a month is its Moscow days", () => {
    expect(monthDays("2026-02")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(monthDays("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
  });

  it("names a model by Hub's model record, the one name Главная shows; a model Hub has not keeps the ledger's word", () => {
    const models = [{ slug: "Mia", name: "Mia Hart" }, { slug: "Nova", name: "Nova Lane" }, { slug: "Ivvy", name: "Ivvy Rose" }];
    expect(hubModelNameOf("Mia", models)).toBe("Mia Hart");
    expect(hubModelNameOf("nova lane", models)).toBe("Nova Lane");
    // A payout sheet spelling the name with one letter where the record doubles it is the same model.
    expect(hubModelNameOf("Ivy", models)).toBe("Ivvy Rose");
    expect(hubModelNameOf("Zara", models)).toBe("Zara");
    // Two records that read the same so: neither is guessed.
    expect(hubModelNameOf("Ivy", [...models, { slug: "Iivy", name: "Iivy Two" }])).toBe("Ivy");
    const shown = monthCardOf({ ...card, models: [{ ...card.models[0]!, model: "Mia" }] }, "2026-11", { models });
    expect(shown.models[0]).toMatchObject({ model: "Mia Hart" });
  });
});

describe("«Доход страниц» against Главная", () => {
  // The ledger's card is of its cut (`asOf`): what occurred before it. Hub's own income is set beside it over the
  // same stretch of the month, so a difference is a difference whether the month goes on or is over.
  const cut = "2026-11-12T15:31:00.000Z";

  it("the card's cut inside the month is where Hub's income is asked up to; a card of the whole month has none", () => {
    expect(monthCut("2026-11", cut)).toBe(cut);
    // November in Moscow ends at 2026-11-30T21:00Z: its last instant is inside, the next month's first is not.
    expect(monthCut("2026-11", "2026-11-30T20:59:59.999Z")).toBe("2026-11-30T20:59:59.999Z");
    expect(monthCut("2026-11", "2026-11-30T21:00:00.000Z")).toBeNull();
    expect(monthCut("2026-10", cut)).toBeNull();
    expect(monthCut("2026-11", null)).toBeNull();
    expect(monthCut("2026-11", "not a date")).toBeNull();
  });

  it("equal to the cent is equal: of the whole month, or so far when the card is of a cut inside it", () => {
    expect(monthCheck({ pagesNetMills: 1_000_004, hubMills: 1_000_001, cut: null })).toEqual({ kind: "equal" });
    expect(monthCheck({ pagesNetMills: 1_000_004, hubMills: 1_000_001, cut })).toEqual({ kind: "equal_so_far", cut });
  });

  it("a ledger short of Hub's income as of its own cut is a difference in the month going on too, never «the hour of lag»", () => {
    // A page that fell out of the ledger's sync: by the cut Hub had 1 000.00, the ledger 900.00.
    expect(monthCheck({ pagesNetMills: 900_000, hubMills: 1_000_000, cut })).toEqual({ kind: "differs", deltaMills: -100_000, cut });
    expect(monthCheck({ pagesNetMills: 1_100_000, hubMills: 1_000_000, cut })).toEqual({ kind: "differs", deltaMills: 100_000, cut });
    // A month that is over, as before.
    expect(monthCheck({ pagesNetMills: 900_000, hubMills: 1_000_000, cut: null })).toEqual({ kind: "differs", deltaMills: -100_000, cut: null });
  });

  it("Hub's income up to the cut is the month's window with the cut as its end moment", () => {
    expect(monthWindow("2026-11", cut)).toEqual({ from: "2026-11-01", to: "2026-12-01", until: cut });
    expect(monthWindow("2026-11", null)).toEqual({ from: "2026-11-01", to: "2026-12-01" });
  });
});
