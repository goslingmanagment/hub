import { describe, expect, it } from "vitest";

import { pairReportLines, type PairLine, type PairSale } from "../apps/runtime/src/services/report-line-pairs.ts";

// Which line of a person's reports pays which of their sales (report-line-pairs.ts): by the line's reference — the
// platform's, or Hub's own id of the sale — and, for an amount added by hand in words, by the page, the amount to the
// cent and the sale's Moscow time in those words. Invented sales and amounts.

const msk = (at: string) => Date.parse(`${at.replace(" ", "T")}:00+03:00`);

let nextId = 100;
function sale(at: string, netMills: number, extra: Partial<PairSale> = {}): PairSale {
  nextId += 1;
  return { hubRef: String(nextId), platformRef: `pf-${nextId}`, pageLabel: "page-a", netMills, occurredAt: msk(at), ...extra };
}

function line(ref: string | null, netMills: number, extra: Partial<PairLine> = {}): PairLine {
  return { ref, pageLabel: "page-a", netMills, counted: true, what: "", ...extra };
}

const added = (netMills: number, what: string, extra: Partial<PairLine> = {}) => line(null, netMills, { what, ...extra });

describe("a line with a reference", () => {
  it("pays the sale of that platform reference, or of that Hub id", () => {
    const first = sale("2026-11-12 14:10", 16_000);
    const second = sale("2026-11-12 15:20", 24_000);
    const byPlatform = line(first.platformRef, 16_000);
    // An added line may carry Hub's own id of the sale instead of the platform's reference.
    const byHub = line(second.hubRef, 24_000, { what: "долёт" });
    const pairs = pairReportLines([first, second], [byPlatform, byHub]);
    expect(pairs.paidBy.get(first)).toBe(byPlatform);
    expect(pairs.paidBy.get(second)).toBe(byHub);
    expect(pairs.unpaid).toEqual([]);
    expect(pairs.loose).toEqual([]);
  });

  it("a reference that is none of the person's sales pays none, though the words would fit one", () => {
    const own = sale("2026-11-12 01:05", 15_990);
    const foreign = line("pf-someone-else", 15_990, { what: "долёт ппв 01:05" });
    const pairs = pairReportLines([own], [foreign]);
    expect(pairs.paidBy.size).toBe(0);
    expect(pairs.unpaid).toEqual([own]);
    expect(pairs.loose).toEqual([foreign]);
  });

  it("is read as Hub's id when one string is both a Hub id and a platform reference", () => {
    const byId = sale("2026-11-12 10:00", 8_000, { hubRef: "777", platformRef: "pf-a" });
    const byPlatform = sale("2026-11-12 11:00", 8_000, { hubRef: "778", platformRef: "777" });
    const one = line("777", 8_000);
    const pairs = pairReportLines([byPlatform, byId], [one]);
    expect(pairs.paidBy.get(byId)).toBe(one);
    expect(pairs.unpaid).toEqual([byPlatform]);
  });

  it("a second line of the same sale pays nothing: a sale is paid once, by the first line given", () => {
    const one = sale("2026-11-12 14:10", 16_000);
    const inReport = line(one.platformRef, 16_000);
    const again = line(one.hubRef, 16_000, { what: "долёт" });
    const pairs = pairReportLines([one], [inReport, again]);
    expect(pairs.paidBy.get(one)).toBe(inReport);
    expect(pairs.loose).toEqual([again]);
  });
});

describe("a line held out of the report's sum", () => {
  it("pays nothing and is not a loose line", () => {
    const one = sale("2026-11-12 14:10", 16_000);
    const held = line(one.platformRef, 16_000, { counted: false });
    const heldWords = added(16_000, "долёт 14:10", { counted: false });
    const pairs = pairReportLines([one], [held, heldWords]);
    expect(pairs.paidBy.size).toBe(0);
    expect(pairs.unpaid).toEqual([one]);
    expect(pairs.loose).toEqual([]);
  });
});

describe("an amount added by hand, without a reference", () => {
  it("pays the sale of the same page and amount whose Moscow time stands in its words", () => {
    const late = sale("2026-11-12 01:05", 15_990);
    const words = added(15_990, "долёт: ппв 01:05 мск, пришёл после среза");
    const pairs = pairReportLines([late], [words]);
    expect(pairs.paidBy.get(late)).toBe(words);
    expect(pairs.loose).toEqual([]);
  });

  it("not another page's sale, not another amount's, not without the time", () => {
    const one = sale("2026-11-12 01:05", 15_990);
    expect(pairReportLines([one], [added(15_990, "долёт 01:05", { pageLabel: "page-b" })]).paidBy.size).toBe(0);
    expect(pairReportLines([one], [added(20_000, "долёт 01:05")]).paidBy.size).toBe(0);
    expect(pairReportLines([one], [added(15_990, "мимо площадки, перевод на карту")]).paidBy.size).toBe(0);
    // The time is the sale's own minute, written whole: not another minute, not the tail of a longer number.
    expect(pairReportLines([one], [added(15_990, "долёт 01:06")]).paidBy.size).toBe(0);
    expect(pairReportLines([one], [added(15_990, "заказ 101:05")]).paidBy.size).toBe(0);
    expect(pairReportLines([one], [added(15_990, "долёт 01:052")]).paidBy.size).toBe(0);
    expect(pairReportLines([one], [added(15_990, "долёт 12.11 01:05:40")]).paidBy.size).toBe(1);
  });

  it("the amount is the same to the cent: a sale keeps its thousandths, the line is whole cents, cut or rounded", () => {
    const pays = (netMills: number, lineMills: number) => pairReportLines([sale("2026-11-12 01:05", netMills)], [added(lineMills, "долёт 01:05")]).paidBy.size === 1;
    expect(pays(7_992, 7_990)).toBe(true);
    expect(pays(7_992, 7_992)).toBe(true);
    // $7.996 prints as $7.99 where the thousandths are cut and as $8.00 where they are rounded: both are this sale.
    expect(pays(7_996, 7_990)).toBe(true);
    expect(pays(7_996, 8_000)).toBe(true);
    // A cent apart either way is another amount.
    expect(pays(7_992, 8_000)).toBe(false);
    expect(pays(7_992, 7_980)).toBe(false);
    expect(pays(7_984, 7_990)).toBe(false);
  });

  it("the same amount twice in a night: each line pays the sale of its own time", () => {
    const first = sale("2026-11-12 01:05", 12_000);
    const second = sale("2026-11-12 03:40", 12_000);
    const forSecond = added(12_000, "долёт ппв 03:40");
    const forFirst = added(12_000, "долёт ппв 01:05");
    const pairs = pairReportLines([first, second], [forSecond, forFirst]);
    expect(pairs.paidBy.get(first)).toBe(forFirst);
    expect(pairs.paidBy.get(second)).toBe(forSecond);
    expect(pairs.unpaid).toEqual([]);
  });

  it("of several sales that fit takes the earliest; the next such line the next; one more pays nothing", () => {
    // Two PPVs of one price bought in the same minute, a third the next evening at the same minute of the clock.
    const nextEvening = sale("2026-11-13 21:15", 9_990);
    const a = sale("2026-11-12 21:15", 9_990);
    const b = sale("2026-11-12 21:15", 9_990);
    const lines = [added(9_990, "долёт 21:15"), added(9_990, "долёт 21:15"), added(9_990, "долёт 21:15"), added(9_990, "долёт 21:15")];
    const pairs = pairReportLines([nextEvening, a, b], lines);
    expect(pairs.paidBy.get(a)).toBe(lines[0]);
    expect(pairs.paidBy.get(b)).toBe(lines[1]);
    expect(pairs.paidBy.get(nextEvening)).toBe(lines[2]);
    expect(pairs.loose).toEqual([lines[3]]);
  });

  it("words that name two times pay the earliest sale that fits, once", () => {
    const early = sale("2026-11-12 01:05", 12_000);
    const late = sale("2026-11-12 03:40", 12_000);
    const both = added(12_000, "ппв 03:40, оплата кастома от 01:05");
    const pairs = pairReportLines([late, early], [both]);
    expect(pairs.paidBy.get(early)).toBe(both);
    expect(pairs.unpaid).toEqual([late]);
  });

  it("never takes a sale a line with a reference pays, whatever the order of the lines", () => {
    const named = sale("2026-11-12 01:05", 12_000);
    const other = sale("2026-11-12 01:05", 12_000);
    const words = added(12_000, "долёт 01:05");
    const byRef = line(named.platformRef, 12_000);
    const pairs = pairReportLines([named, other], [words, byRef]);
    expect(pairs.paidBy.get(named)).toBe(byRef);
    expect(pairs.paidBy.get(other)).toBe(words);
    // With the one sale only, the words have nothing left to pay.
    const alone = pairReportLines([named], [words, byRef]);
    expect(alone.paidBy.get(named)).toBe(byRef);
    expect(alone.loose).toEqual([words]);
  });

  it("reads the clock in Moscow, whatever the instant's own zone", () => {
    const one: PairSale = { hubRef: "1", platformRef: null, pageLabel: "page-a", netMills: 5_000, occurredAt: Date.parse("2026-11-11T22:30:00Z") };
    expect(pairReportLines([one], [added(5_000, "тип 01:30")]).paidBy.size).toBe(1);
    expect(pairReportLines([one], [added(5_000, "тип 22:30")]).paidBy.size).toBe(0);
  });
});
