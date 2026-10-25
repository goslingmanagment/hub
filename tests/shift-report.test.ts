import { describe, expect, it } from "vitest";

import {
  claimOf,
  creditsOfSale,
  disputePeopleOf,
  exportCellsOf,
  judgeMarks,
  payoutCellOf,
  saleDayOf,
  type ExportSale,
} from "../apps/runtime/src/services/shift-report.ts";

// The draft shift report's money rules (week-4.md §2): what a mark claims,
// when marks agree, who is credited what, and that a sale is paid once.

const NIKITA = 27;
const VANYA = 30;
const GRISHA = 17;
type Mark = ExportSale["marks"][number];
const mark = (userId: number, kind: Mark["mark"], shareWithUserId: number | null = null, amountMills: number | null = null): Mark => ({
  userId, username: { [NIKITA]: "nikita", [VANYA]: "vanya", [GRISHA]: "grisha" }[userId] ?? String(userId),
  mark: kind, shareWithUserId, shareWith: shareWithUserId === null ? null : String(shareWithUserId), amountMills,
});

describe("shift report money", () => {
  it("claims «моё» whole or by the chatter's amount (never above the net), «делим» a half, «не моё» nothing", () => {
    expect(claimOf(mark(NIKITA, "mine"), 80_000)).toBe(80_000);
    expect(claimOf(mark(NIKITA, "mine", null, 75_000), 80_000)).toBe(75_000);
    expect(claimOf(mark(NIKITA, "mine", null, 500_000), 80_000)).toBe(80_000);
    expect(claimOf(mark(NIKITA, "share", VANYA), 20_001) + claimOf(mark(VANYA, "share", NIKITA), 20_001)).toBe(20_001);
    expect(claimOf(mark(NIKITA, "not_mine", null, 5_000), 20_000)).toBe(0);
  });

  it("agrees only on one «моё» or two «делим» naming each other; everything else is the owner's dispute", () => {
    expect(judgeMarks([mark(NIKITA, "mine"), mark(VANYA, "not_mine")])).toEqual({ kind: "mine", userId: NIKITA });
    expect(judgeMarks([mark(NIKITA, "share", VANYA), mark(VANYA, "share", NIKITA)])).toEqual({ kind: "share", userIds: [NIKITA, VANYA] });
    expect(judgeMarks([mark(NIKITA, "not_mine")])).toEqual({ kind: "nobody" });
    expect(judgeMarks([mark(NIKITA, "mine"), mark(VANYA, "mine")])).toEqual({ kind: "dispute", reason: "two_mine" });
    expect(judgeMarks([mark(NIKITA, "share", VANYA)])).toEqual({ kind: "dispute", reason: "share_not_agreed" });
    // A↔B «делим» and C «моё» would credit 150%: a dispute, never agreed.
    expect(judgeMarks([mark(NIKITA, "share", VANYA), mark(VANYA, "share", NIKITA), mark(GRISHA, "mine")]))
      .toEqual({ kind: "dispute", reason: "conflicting" });
    expect(judgeMarks([mark(NIKITA, "mine"), mark(VANYA, "share", NIKITA)])).toEqual({ kind: "dispute", reason: "conflicting" });
  });

  it("credits an agreed «делим» in two exact halves once either partner confirmed — the partner out of shift too", () => {
    const shared = { netMills: 100_001, active: true, marks: [mark(NIKITA, "share", VANYA), mark(VANYA, "share", NIKITA)], resolution: null };
    expect(creditsOfSale({ ...shared, confirmedBy: new Set([NIKITA]) }).credits).toEqual([{ userId: NIKITA, mills: 50_001 }, { userId: VANYA, mills: 50_000 }]);
    expect(creditsOfSale({ ...shared, confirmedBy: new Set() }).credits).toEqual([]);
    // «моё» credits only the chatter who confirmed it; a refunded sale credits nobody.
    const mine = { netMills: 40_000, active: true, marks: [mark(NIKITA, "mine")], resolution: null };
    expect(creditsOfSale({ ...mine, confirmedBy: new Set([VANYA]) }).credits).toEqual([]);
    expect(creditsOfSale({ ...mine, confirmedBy: new Set([NIKITA]) }).credits).toEqual([{ userId: NIKITA, mills: 40_000 }]);
    expect(creditsOfSale({ ...mine, active: false, confirmedBy: new Set([NIKITA]) })).toEqual({ open: false, credits: [] });
    // The owner's split sums to the net exactly.
    expect(creditsOfSale({
      netMills: 100_001, active: true, marks: [mark(NIKITA, "mine"), mark(VANYA, "mine")], confirmedBy: new Set([NIKITA]),
      resolution: [{ userId: NIKITA, percent: 33 }, { userId: VANYA, percent: 67 }],
    }).credits.reduce((sum, credit) => sum + credit.mills, 0)).toBe(100_001);
  });

  it("pays a decided dispute once across exports whose windows split the shifts holding it", () => {
    // Никита's shift began 2026-11-01 23:00 MSK, Ваня's 2026-11-02 00:00; the tip at 00:30 MSK, both «моё», the owner split it.
    // Its day is the earliest confirmed shift's: 11-01 — only the export of that day has it.
    const sale: ExportSale = {
      transactionId: 1, pageLabel: "ari-1", platform: "fansly", netMills: 100_000, active: true, occurredAt: new Date("2026-11-01T21:30:00Z"),
      marks: [mark(NIKITA, "mine"), mark(VANYA, "mine")], resolution: [{ userId: NIKITA, percent: 50 }, { userId: VANYA, percent: 50 }],
      saleDay: "2026-11-01", confirmedBy: new Map([[NIKITA, "nikita"], [VANYA, "vanya"]]),
    };
    const { cells, disputedOpen } = exportCellsOf([sale]);
    expect(disputedOpen).toBe(0);
    expect(cells).toEqual([
      { username: "nikita", pageLabel: "ari-1", platform: "fansly", shiftDate: "2026-11-01", creditedMills: 50_000 },
      { username: "vanya", pageLabel: "ari-1", platform: "fansly", shiftDate: "2026-11-01", creditedMills: 50_000 },
    ]);
    expect(cells.reduce((sum, cell) => sum + cell.creditedMills, 0)).toBe(sale.netMills);
  });

  it("leaves an open dispute out, counted, and lists a chatter's own amount below Hub's net", () => {
    const base = { pageLabel: "ari-1", platform: "fansly", active: true, occurredAt: new Date("2026-11-01T21:30:00Z"), saleDay: "2026-11-01", resolution: null };
    const { cells, disputedOpen, ownAmounts } = exportCellsOf([
      { ...base, transactionId: 1, netMills: 30_000, marks: [mark(NIKITA, "mine"), mark(VANYA, "mine")], confirmedBy: new Map([[NIKITA, "nikita"]]) },
      { ...base, transactionId: 2, netMills: 10_000, marks: [mark(NIKITA, "mine", null, 9_000)], confirmedBy: new Map([[NIKITA, "nikita"]]) },
    ]);
    expect(disputedOpen).toBe(1);
    expect(cells).toEqual([{ username: "nikita", pageLabel: "ari-1", platform: "fansly", shiftDate: "2026-11-01", creditedMills: 9_000 }]);
    expect(ownAmounts).toEqual([expect.objectContaining({ username: "nikita", saleRef: "2", netMills: 10_000, amountMills: 9_000 })]);
  });

  it("rounds a cell to the cent on Fansly and to the dollar on OnlyFans", () => {
    expect(payoutCellOf("fansly", 12_344)).toBe(12_340);
    expect(payoutCellOf("fansly", 12_345)).toBe(12_350);
    expect(payoutCellOf("onlyfans", 12_499)).toBe(12_000);
    expect(payoutCellOf("onlyfans", 12_500)).toBe(13_000);
  });

  it("puts a sale on the day the earliest shift holding it started — anyone's, confirmed or not — else on its own day", () => {
    const at = (iso: string) => new Date(iso).getTime();
    // Никита 24.10 23:56 – 25.10 12:53 MSK on ari-1; Ваня 05:46–08:33 inside it; a tip at 06:30.
    const nikita = { startedAt: at("2026-10-24T20:56:00Z"), endedAt: at("2026-10-25T09:53:00Z"), pages: new Map([["ari-1", 1]]) };
    const vanya = { startedAt: at("2026-10-25T02:46:00Z"), endedAt: at("2026-10-25T05:33:00Z"), pages: new Map([["ari-1", 1]]) };
    const tip = { pageLabel: "ari-1", at: at("2026-10-25T03:30:00Z") };
    expect(saleDayOf(tip, [vanya, nikita])).toBe("2026-10-24");
    expect(saleDayOf(tip, [nikita, vanya])).toBe("2026-10-24");
    // A shift on another page holds nothing here; no shift — the sale's own Moscow day.
    expect(saleDayOf({ pageLabel: "lora-1", at: tip.at }, [nikita, vanya])).toBe("2026-10-25");
    expect(saleDayOf({ pageLabel: "ari-1", at: at("2026-10-25T21:30:00Z") }, [nikita, vanya])).toBe("2026-10-26");
  });

  it("lets the owner split a «делим» dispute with the teammate who has not marked the sale yet", () => {
    expect(disputePeopleOf({ marks: [mark(NIKITA, "share", VANYA)] }))
      .toEqual([{ userId: NIKITA, username: "nikita" }, { userId: VANYA, username: String(VANYA) }]);
  });
});
