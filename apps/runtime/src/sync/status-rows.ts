import type { SyncPageRow, SyncWorkStatusFields } from "@agency_hub_core/db";

import { holdSetOf, type HoldSet } from "./engine/admission.ts";
import type { StatusPage, StatusWork } from "./engine/status.ts";
import { fanslyResourceSpec } from "./fansly/registry.ts";

// The rows `explainWork` reads, built from a `sync_pages` row and a
// `sync_work` row. A leaf: `inspect.ts` and `services/sync-status-engine.ts`
// build them here. Not in `engine/status.ts`: the engine does not import the
// Fansly registry.

/** The page as the explanation reads it; `holds` defaults to the page's own
 *  hold set. */
export function statusPageOf(page: SyncPageRow, holds: HoldSet = holdSetOf(page.holds)): StatusPage {
  return {
    mode: page.mode,
    pausedAll: page.pausedAll,
    pausedRequests: page.pausedRequests,
    pausedResources: page.pausedResources,
    holds,
    owner: page.owner,
  };
}

/** The work as the explanation reads it, with `http` from the registry (a
 *  key it does not know counts as one that sends). */
export function statusWorkOf(work: Omit<SyncWorkStatusFields, "pageId">): StatusWork {
  return {
    id: work.id,
    resource: work.resource,
    subject: work.subject,
    class: work.class,
    state: work.state,
    dueAt: work.dueAt,
    breakerUntil: work.breakerUntil,
    blockedByVendorAt: work.blockedByVendorAt,
    waitingReason: work.waitingReason,
    waitingUntil: work.waitingUntil,
    http: fanslyResourceSpec(work.resource)?.http !== false,
  };
}
