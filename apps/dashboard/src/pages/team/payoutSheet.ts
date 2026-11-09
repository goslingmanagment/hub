/**
 * The payout sheet's text, byte for byte as the owner pastes it into the
 * chatter's tab of the payout table (tests/payout-sheet.test.ts pins it). One
 * copy for the console and Workboard: packages/ui/src/payoutSheet.ts.
 */
export { daysOf, pivotOf, sheetCell, sheetText, type PivotRow, type SheetRow } from "@agency_hub_core/ui/payoutSheet";

/** Today in Moscow shifted by `offsetDays` (the console's own export window). */
export function moscowDay(offsetDays: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
}
