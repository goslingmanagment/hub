import {
  listFanslyPages,
  reconcileFanslyBulkStreamGate,
  type FanslyBulkStreamGateState,
  type FanslyBulkSyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { resolveFanslyNewStreamState } from "./fansly-stream-gate.ts";

export type FanslyBulkStreamGateSummary = {
  paused: number;
  resumed: number;
  recoveryGenerations: number;
};

function resolveGateState(input: {
  pageLabel: string;
  streamEnabled: boolean;
  allowlistCsv: string | undefined;
}): FanslyBulkStreamGateState {
  const state = resolveFanslyNewStreamState({
    platform: "fansly",
    ...input,
  });
  if (state === "unsupported_platform") {
    throw new Error("Fansly bulk-stream gate received a non-Fansly page");
  }
  return state;
}

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
    const streams: Array<{
      stream: FanslyBulkSyncStream;
      enabled: boolean;
    }> = [
      {
        stream: "fan_earnings",
        enabled: effective.fanslyFanEarningsSyncEnabled === true,
      },
      {
        stream: "purchase_history",
        enabled: effective.fanslyPurchaseHistorySyncEnabled === true,
      },
    ];

    for (const stream of streams) {
      const result = await reconcileFanslyBulkStreamGate(app.db, {
        pageId: page.id,
        stream: stream.stream,
        gateState: resolveGateState({
          pageLabel: page.label,
          streamEnabled: stream.enabled,
          allowlistCsv: effective.fanslyNewStreamPageAllowlist,
        }),
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
