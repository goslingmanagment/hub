import type { UntilRebuilt } from "./types.js";

/** Group system. A rebuilt screen's row goes. */
export const UNTIL_REBUILT_SYSTEM: UntilRebuilt = {
  "system-collection": { pageFilter: "all" },
  "system-history-requests": { pageFilter: "all" },
  "system-dev-extension": { periodInBody: true },
};
