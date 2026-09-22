import {
  listFanslyPages,
  reconcileFanslyBulkStreamGate,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { evaluateFanslyStreamGate, GATED_FANSLY_STREAMS } from "./fansly-stream-gate.ts";

export type FanslyBulkStreamGateSummary = {
  paused: number;
  resumed: number;
  recoveryGenerations: number;
};

/**
 * Materializes the live Fansly rollout gate into durable stream state.
 * Reopening a gate becomes one ordinary recovery generation; the planner's
 * existing runnable-row and fixed page-wakeup path remains the only dispatch
 * authority.
 */
export async function reconcileFanslyBulkStreamScheduling(
  app: Pick<AppContext, "config" | "db">,
  now = new Date(),
): Promise<FanslyBulkStreamGateSummary> {
  const [effective, pages] = await Promise.all([
    loadEffectiveConfig(app.db, app.config),
    listFanslyPages(app.db),
  ]);
  const summary: FanslyBulkStreamGateSummary = {
    paused: 0,
    resumed: 0,
    recoveryGenerations: 0,
  };

  for (const page of pages) {
    for (const { stream } of GATED_FANSLY_STREAMS) {
      const result = await reconcileFanslyBulkStreamGate(app.db, {
        pageId: page.id,
        stream,
        gateState: evaluateFanslyStreamGate(effective, stream, page.label).state,
        now,
      });
      if (result.action === "paused") {
        summary.paused += 1;
      } else if (result.action === "resumed") {
        summary.resumed += 1;
      }
      if (result.createdRecoveryGeneration) {
        summary.recoveryGenerations += 1;
      }
    }
  }

  return summary;
}
