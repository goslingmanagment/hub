import type { UntilRebuilt } from "./types.js";

/** Group home-money. A rebuilt screen's row goes. */
export const UNTIL_REBUILT_HOME_MONEY: UntilRebuilt = {
  // Not a gap but the screen's design: «Операции» draw their period themselves,
  // because an exact window from a clicked sum is a fifth value, «Свои даты»,
  // that the header's control does not have (design/screens/home-money.md §4).
  transactions: { periodInBody: true },
};
