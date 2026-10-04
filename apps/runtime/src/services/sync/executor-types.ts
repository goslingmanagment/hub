// The two types every executor stream handler speaks: what a chunk is HANDED
// and what it must RETURN. They lived in executor-handlers.ts, which made every
// extracted handler module import from the file it was extracted out of — fine
// while the imports were type-only, a cycle the moment one of them needed a
// value. They are declared here so a handler module can be a leaf.
//
// executor-handlers.ts re-exports both, so the modules that already import them
// from there (posts and the platform registry) keep working unchanged.

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
  /** Set when a gate short-circuited the chunk before any egress (the
   *  OnlyFans top spenders switch is off; OnlyFans transactions are
   *  webhook-sourced). Such a chunk terminates WITHOUT recording a successful
   *  sync anywhere. Do not extend it to the other "satisfied but did nothing"
   *  skips (onlyfans_audience_not_eligible, onlyfans_dm_requires_ofapi_mapping,
   *  ...) without deciding it: withholding succeeded_at from a stream in
   *  BLOCK_TASKS / SYNC_DOMAIN_POLICY degrades chatter-visible block health. */
  gatedSkip?: string | null;
  /** A completed attempt whose data failed certification. Settle the request
   *  without success, freshness, failure reset, or incident recovery. */
  qualityHold?: string | null;
};
