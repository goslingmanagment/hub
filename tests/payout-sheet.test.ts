import { describe, expect, it } from "vitest";

import { daysOf, pivotOf, sheetCell, sheetText } from "../apps/dashboard/src/pages/team/payoutSheet.ts";

// The payout sheet the owner pastes into the payout table: money, so its format
// is pinned. The expectations were taken from the code before it moved out of
// TeamShiftReportsPage.tsx: Fansly to the cent, OnlyFans whole dollars, no «$»,
// tabs, a block per chatter, the days as YYYY-MM-DD.

const ROWS = [
  { username: "alex.k", pageLabel: "mia-1", platform: "fansly", shiftDate: "2026-10-28", creditedMills: 39_990 },
  { username: "alex.k", pageLabel: "mia-1", platform: "fansly", shiftDate: "2026-10-28", creditedMills: 5_010 },
  { username: "alex.k", pageLabel: "mia-of", platform: "onlyfans", shiftDate: "2026-10-30", creditedMills: 24_500 },
  { username: "kate.v", pageLabel: "mia-3", platform: "fansly", shiftDate: "2026-10-29", creditedMills: 119_990 },
];

describe("payout sheet", () => {
  it("writes a cell as the payout table wants it", () => {
    expect(sheetCell("fansly", 39_990)).toBe("39.99");
    expect(sheetCell("fansly", 5)).toBe("0.01");
    expect(sheetCell("onlyfans", 24_500)).toBe("25");
    expect(sheetCell("onlyfans", 24_499)).toBe("24");
  });

  it("adds a chatter's sales of one page and day", () => {
    const pivot = pivotOf(ROWS);
    expect(pivot.map((row) => [row.username, row.pageLabel, [...row.cells.entries()]])).toEqual([
      ["alex.k", "mia-1", [["2026-10-28", 45_000]]],
      ["alex.k", "mia-of", [["2026-10-30", 24_500]]],
      ["kate.v", "mia-3", [["2026-10-29", 119_990]]],
    ]);
  });

  it("copies the same text byte for byte", () => {
    const days = daysOf("2026-10-28", "2026-10-30");
    expect(days).toEqual(["2026-10-28", "2026-10-29", "2026-10-30"]);
    expect(sheetText(pivotOf(ROWS), days)).toBe(
      "alex.k\t2026-10-28\t2026-10-29\t2026-10-30\n"
      + "mia-1\t45.00\t\t\n"
      + "mia-of\t\t\t25\n"
      + "\n"
      + "kate.v\t2026-10-28\t2026-10-29\t2026-10-30\n"
      + "mia-3\t\t119.99\t",
    );
  });

  it("never makes more than 31 columns", () => {
    expect(daysOf("2026-10-01", "2026-12-01")).toHaveLength(31);
  });
});
