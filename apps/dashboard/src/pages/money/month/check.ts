import { millsToWholeCents } from "@agency_hub_core/shared";

/**
 * «Доход страниц» beside Hub's own income of the same stretch of the Moscow month, as the cents both print. The
 * ledger's card is of its cut (`asOf`): what occurred before it. While the cut is inside the month (`cut`, window.ts
 * `monthCut`) Hub's income is asked up to the same moment, so like stands beside like:
 * - `equal` — the whole month, the same to the cent;
 * - `equal_so_far` — the same to the cent as of the cut: nothing is missing, the ledger takes newer sales within the
 *   hour, and the screen says when it last took them;
 * - `differs` — a difference, ledger − Hub: of the whole month, or as of the cut. A ledger short of what Hub had by
 *   the ledger's own cut is a discrepancy in a month that goes on too (a page that fell out of the ledger's sync),
 *   never «the hour of lag».
 */
export type MonthCheck =
  | { kind: "equal" }
  | { kind: "equal_so_far"; cut: string }
  | { kind: "differs"; deltaMills: number; cut: string | null };

/** `hubMills`: Hub's income of the month, up to `cut` when the card is of a cut inside the month. */
export function monthCheck(input: { pagesNetMills: number; hubMills: number; cut: string | null }): MonthCheck {
  const deltaMills = (millsToWholeCents(input.pagesNetMills) - millsToWholeCents(input.hubMills)) * 10;
  if (deltaMills !== 0) return { kind: "differs", deltaMills, cut: input.cut };
  return input.cut === null ? { kind: "equal" } : { kind: "equal_so_far", cut: input.cut };
}
