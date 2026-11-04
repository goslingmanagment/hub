import type { UntilRebuilt } from "./types.js";

/** Group home-money. A rebuilt screen's row goes. */
export const UNTIL_REBUILT_HOME_MONEY: UntilRebuilt = {
  // The table reads every page for now; the page's tiles, chart and kinds come with its rebuild.
  home: { pageFilter: "all" },
  transactions: { periodInBody: true },
};
