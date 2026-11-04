import type { TeamShiftExportResponse } from "@agency_hub_core/contracts";
import { millsToRoundedDollars } from "@agency_hub_core/shared";

/**
 * The payout sheet's text, byte for byte as the owner pastes it into the
 * chatter's tab of the payout table. Moved from TeamShiftReportsPage.tsx
 * without a change: tests/payout-sheet.test.ts pins it.
 */

export function moscowDay(offsetDays: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}

export function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`) && days.length < 31; at += 86_400_000) {
    days.push(new Date(at).toISOString().slice(0, 10));
  }
  return days;
}

/** A payout-sheet cell: Fansly to the cent, OnlyFans whole dollars, a dot for the decimals. */
export function sheetCell(platform: string, mills: number): string {
  return platform === "onlyfans" ? String(millsToRoundedDollars(mills)) : (mills / 1000).toFixed(2);
}

export interface PivotRow { username: string; pageLabel: string; platform: string; cells: Map<string, number> }

export function pivotOf(rows: TeamShiftExportResponse["rows"]): PivotRow[] {
  const byKey = new Map<string, PivotRow>();
  for (const row of rows) {
    const key = `${row.username}\u0000${row.pageLabel}`;
    const pivot = byKey.get(key) ?? { username: row.username, pageLabel: row.pageLabel, platform: row.platform, cells: new Map() };
    pivot.cells.set(row.shiftDate, (pivot.cells.get(row.shiftDate) ?? 0) + row.creditedMills);
    byKey.set(key, pivot);
  }
  return [...byKey.values()];
}

/** Tab-separated, one block per chatter: the page, then a column per day — pasted into the chatter's tab of the payout sheet. */
export function sheetText(pivot: readonly PivotRow[], days: readonly string[]): string {
  const blocks: string[] = [];
  for (const username of [...new Set(pivot.map((row) => row.username))]) {
    const lines = [[username, ...days].join("\t")];
    for (const row of pivot.filter((one) => one.username === username)) {
      lines.push([row.pageLabel, ...days.map((day) => (row.cells.has(day) ? sheetCell(row.platform, row.cells.get(day)!) : ""))].join("\t"));
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}
