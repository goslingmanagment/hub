import { listClientBootstrapPages } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { SERVED_CLIENT_CAPABILITIES } from "./client-capabilities.ts";
import { evaluateClientFeature } from "./client-features.ts";
import { loadClientSwitches } from "./client-switches.ts";

/**
 * The owner's `splitAll` flag, as an AI generation reads it (chat-extension
 * hub-pr-plan H-10; architecture.md D-15).
 *
 * Split for the features that never split for a released client (Ping, Hi and
 * Coach drafts) is served only when the request advertises `split-all-v1` AND
 * this answers true for the page. It is the same evaluation the bootstrap and
 * every client route run: platform, master switch, the flag, the binding, what
 * the hub serves.
 *
 * Unlike requireClientFeature it never refuses. With the flag off the
 * generation runs as it always has and returns unsplit text; the client asked
 * for parts and shows that it got one. A read that fails answers false for the
 * same reason: Split is an enhancement, never a reason to fail a generation.
 *
 * The caller has already checked the caller's access to the page. A narrow
 * extension token has by then also passed the AI switch (master switch and
 * minimum version, client-ai-switch.ts).
 */
export async function isSplitAllOnForPage(app: AppContext, pageId: number): Promise<boolean> {
  try {
    const [row] = await listClientBootstrapPages(app.db, [pageId]);
    if (row === undefined) {
      return false;
    }
    const switches = await loadClientSwitches(app);
    return evaluateClientFeature({
      settings: switches.settings,
      page: { label: row.label, platform: row.platform, platformAccountId: row.platformAccountId },
      flag: "splitAll",
      served: SERVED_CLIENT_CAPABILITIES,
    }).available;
  } catch (error) {
    app.logger.warn({ pageId, err: error }, "splitAll flag read failed; Split stays off for this generation");
    return false;
  }
}
