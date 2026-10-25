import { describe, expect, it } from "vitest";

import type { ExportCreditRow, SaleCreditState } from "@agency_hub_core/db";

import {
  claimOf,
  disputePeopleOf,
  dueCreditsOf,
  exportCellsOf,
  judgeMarks,
  payoutCellOf,
} from "../apps/runtime/src/services/shift-report.ts";

// The draft shift report's money rules (week-4.md §2): what a mark claims,
// when marks agree, who is owed what and on which day.

const NIKITA = 27;
const VANYA = 30;
const GRISHA = 17;
type Mark = SaleCreditState["marks"][number];
const mark = (userId: number, kind: Mark["mark"], shareWithUserId: number | null = null, amountMills: number | null = null): Mark => ({
  userId, username: { [NIKITA]: "nikita", [VANYA]: "vanya", [GRISHA]: "grisha" }[userId] ?? String(userId), transactionId: 1,
  mark: kind, shareWithUserId, shareWithUsername: shareWithUserId === null ? null : String(shareWithUserId), amountMills, note: null,
});
const saleOf = (input: Partial<SaleCreditState> & Pick<SaleCreditState, "marks">): SaleCreditState => ({
  netMills: 100_001, occurredAt: new Date("2026-10-25T03:30:00Z"), lines: [], credits: [], resolution: null, ...input,
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

  it("owes «моё» to its chatter once their report holds it, on their shift's day; an agreed «делим» both halves on the first line's day", () => {
    const mine = saleOf({ netMills: 40_000, marks: [mark(NIKITA, "mine"), mark(VANYA, "not_mine")] });
    expect(dueCreditsOf(mine)).toEqual([]);
    expect(dueCreditsOf({ ...mine, lines: [{ userId: VANYA, payDay: "2026-10-25" }] })).toEqual([]);
    expect(dueCreditsOf({ ...mine, lines: [{ userId: NIKITA, payDay: "2026-10-24" }] }))
      .toEqual([{ userId: NIKITA, mills: 40_000, payDay: "2026-10-24", source: "report", ownAmount: false }]);
    // The chatter's own amount below the net is marked for the owner.
    expect(dueCreditsOf(saleOf({ netMills: 10_000, marks: [mark(NIKITA, "mine", null, 9_000)], lines: [{ userId: NIKITA, payDay: "2026-10-24" }] })))
      .toEqual([{ userId: NIKITA, mills: 9_000, payDay: "2026-10-24", source: "report", ownAmount: true }]);

    const shared = saleOf({ marks: [mark(NIKITA, "share", VANYA), mark(VANYA, "share", NIKITA)] });
    expect(dueCreditsOf(shared)).toEqual([]);
    // Ваня's line alone (Никита agreed from «С тобой делят») owes both halves on Ваня's day; with both lines — the earlier day.
    expect(dueCreditsOf({ ...shared, lines: [{ userId: VANYA, payDay: "2026-10-25" }] })).toEqual([
      { userId: NIKITA, mills: 50_001, payDay: "2026-10-25", source: "share", ownAmount: false },
      { userId: VANYA, mills: 50_000, payDay: "2026-10-25", source: "report", ownAmount: false },
    ]);
    expect(dueCreditsOf({ ...shared, lines: [{ userId: VANYA, payDay: "2026-10-25" }, { userId: NIKITA, payDay: "2026-10-24" }] })
      .map((credit) => credit.payDay)).toEqual(["2026-10-24", "2026-10-24"]);
    // A dispute owes nothing until the owner splits it.
    expect(dueCreditsOf(saleOf({ marks: [mark(NIKITA, "mine"), mark(VANYA, "mine")], lines: [{ userId: NIKITA, payDay: "2026-10-24" }] }))).toEqual([]);
  });

  it("owes the owner's split exactly the net, on the sale's first written day — else its first line's — else its own Moscow day", () => {
    const disputed = saleOf({ marks: [mark(NIKITA, "mine"), mark(VANYA, "mine")], resolution: [{ userId: NIKITA, percent: 33 }, { userId: VANYA, percent: 67 }] });
    const split = dueCreditsOf({ ...disputed, credits: [{ userId: NIKITA, payDay: "2026-10-23", live: false }], lines: [{ userId: VANYA, payDay: "2026-10-22" }] });
    expect(split.reduce((sum, credit) => sum + credit.mills, 0)).toBe(100_001);
    expect(split.map((credit) => [credit.payDay, credit.source])).toEqual([["2026-10-23", "resolution"], ["2026-10-23", "resolution"]]);
    expect(dueCreditsOf({ ...disputed, lines: [{ userId: VANYA, payDay: "2026-10-22" }] })[0]!.payDay).toBe("2026-10-22");
    // 03:30 UTC is 06:30 in Moscow.
    expect(dueCreditsOf(disputed)[0]!.payDay).toBe("2026-10-25");
  });

  it("sums written credits per chatter, page and day, rounded as the payout sheet counts", () => {
    const credit = (username: string, payDay: string, creditedMills: number, ownAmount = false): ExportCreditRow => ({
      transactionId: creditedMills, username, pageLabel: "ari-1", platform: "fansly", payDay, creditedMills, netMills: 10_000, ownAmount,
      occurredAt: new Date("2026-10-25T03:30:00Z"),
    });
    const { cells, ownAmounts } = exportCellsOf([credit("nikita", "2026-10-24", 50_000), credit("nikita", "2026-10-24", 9_000, true), credit("vanya", "2026-10-25", 50_005)]);
    expect(cells).toEqual([
      { username: "nikita", pageLabel: "ari-1", platform: "fansly", shiftDate: "2026-10-24", creditedMills: 59_000 },
      { username: "vanya", pageLabel: "ari-1", platform: "fansly", shiftDate: "2026-10-25", creditedMills: 50_010 },
    ]);
    expect(ownAmounts).toEqual([expect.objectContaining({ username: "nikita", netMills: 10_000, amountMills: 9_000 })]);
  });

  it("rounds a cell to the cent on Fansly and to the dollar on OnlyFans", () => {
    expect(payoutCellOf("fansly", 12_344)).toBe(12_340);
    expect(payoutCellOf("fansly", 12_345)).toBe(12_350);
    expect(payoutCellOf("onlyfans", 12_499)).toBe(12_000);
    expect(payoutCellOf("onlyfans", 12_500)).toBe(13_000);
  });

  it("lets the owner split a «делим» dispute with the teammate who has not marked the sale yet", () => {
    expect(disputePeopleOf({ marks: [{ ...mark(NIKITA, "share", VANYA), shareWith: null }] }))
      .toEqual([{ userId: NIKITA, username: "nikita" }, { userId: VANYA, username: String(VANYA) }]);
  });
});
