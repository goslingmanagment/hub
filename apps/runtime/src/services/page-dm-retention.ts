import type { AppContext } from "../bootstrap.ts";

// Stage 1 retention stand-down: the per-conversation page_dm_messages prune
// deletes captured business facts, so every prune call site is gated behind
// this env kill-switch (default OFF — history is nondecreasing). Re-enabled as
// a safe cache policy only in Stage 28, once history lives in the
// archive+ledger.
export function isPageDmPruneEnabled(
  config?: Pick<AppContext["config"], "pageDmPruneEnabled">,
) {
  return config?.pageDmPruneEnabled === true;
}
