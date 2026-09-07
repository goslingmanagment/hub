// The two types every executor stream handler speaks: what a chunk is HANDED
// and what it must RETURN. They lived in executor-handlers.ts, which made every
// extracted handler module import from the file it was extracted out of — fine
// while the imports were type-only, a cycle the moment one of them needed a
// value. They are declared here so a handler module can be a leaf.
//
// executor-handlers.ts re-exports both, so the modules that already import them
// from there (fansly-stats, fansly-catalog, fansly-media-stats,
// fansly-notifications, fansly-payouts, fansly-post-replies, posts, and the
// platform registry) keep working unchanged.

import type { SyncRequestSource } from "@agency_hub_core/db";

import type { ResolvedPageContext } from "../page-context.ts";
import type { SyncRunTelemetry } from "./observability.ts";
import type { SyncChunkBudget, SyncChunkYieldReason } from "./chunk-budget.ts";

export type ExecutorRequestContext = {
  budget: SyncChunkBudget;
  pageContext: ResolvedPageContext;
  telemetry: SyncRunTelemetry;
};

export type StreamChunkResult = {
  satisfied: boolean;
  yieldReason: SyncChunkYieldReason | null;
  continuationRetryAt?: Date | null;
  continuationRequestSource?: SyncRequestSource | null;
  stats?: Record<string, unknown>;
  /** Set when a ramp gate short-circuited the chunk before any egress. Such a
   *  chunk terminates WITHOUT recording a successful sync anywhere. ONLY
   *  fanslyNewStreamSkip sets this — do not extend it to the other
   *  "satisfied but did nothing" skips (onlyfans_top_spenders_disabled,
   *  legacy_ofapi_dm_messages_retired, sweep_not_due, ...): their streams sit
   *  in BLOCK_TASKS / SYNC_DOMAIN_POLICY, where withholding succeeded_at WOULD
   *  degrade chatter-visible block health. That is a separate decision. */
  gatedSkip?: string | null;
  /** A completed attempt whose data failed certification. Settle the request
   *  without success, freshness, failure reset, or incident recovery. */
  qualityHold?: string | null;
};
