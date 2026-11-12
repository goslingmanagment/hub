import { millsToWholeCents } from "@agency_hub_core/shared";

/**
 * «Доход страниц» beside Главная's income of the same Moscow month, as the cents both print:
 * - `equal` — the same to the cent;
 * - `behind` — the month goes on and the ledger has less: it takes Hub's facts once an hour (its card is of `asOf`),
 *   so the gap is that hour, not a discrepancy, and the screen says when it last took them;
 * - `differs` — a month that is over, or a ledger ahead of Главная (the lag never makes it more): the difference,
 *   ledger − Главная, is named.
 */
export type MonthCheck =
  | { kind: "equal" }
  | { kind: "behind"; asOf: string | null }
  | { kind: "differs"; deltaMills: number };

export function monthCheck(input: { pagesNetMills: number; hubMills: number; current: boolean; asOf: string | null }): MonthCheck {
  const deltaMills = (millsToWholeCents(input.pagesNetMills) - millsToWholeCents(input.hubMills)) * 10;
  if (deltaMills === 0) return { kind: "equal" };
  if (input.current && deltaMills < 0) return { kind: "behind", asOf: input.asOf };
  return { kind: "differs", deltaMills };
}
