import {
  listFanslyPages,
  reconcileFanslyBulkStreamGate,
  type FanslyBulkStreamGateState,
  type FanslyBulkSyncStream,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfig } from "../effective-config.ts";
import { isPageAllowlisted } from "../voice-notes.ts";
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
      /** Set only by lanes with their own FAIL-CLOSED allowlist key. */
      allowlisted?: boolean;
    }> = [
      {
        stream: "fan_earnings",
        enabled: effective.fanslyFanEarningsSyncEnabled === true,
      },
      {
        stream: "purchase_history",
        enabled: effective.fanslyPurchaseHistorySyncEnabled === true,
      },
      {
        stream: "stats_snapshot",
        enabled: effective.fanslyStatsSnapshotSyncEnabled === true,
        // WP-F1 (S4): its OWN allowlist key, on the FAIL-CLOSED template
        // (empty = NO pages). Passing it through `resolveGateState`'s
        // `allowlistCsv` would silently apply the opposite rule — empty = ALL
        // pages — and open the lane fleet-wide on the deploy that ships it.
        allowlisted: isPageAllowlisted(effective.fanslyStatsSnapshotPageAllowlist, page.label),
      },
      {
        stream: "notifications",
        enabled: effective.fanslyNotificationsSyncEnabled === true,
        // WP-F2 (S4): its OWN fail-closed allowlist key, for the same reason.
        allowlisted: isPageAllowlisted(effective.fanslyNotificationsPageAllowlist, page.label),
      },
    ];

    for (const stream of streams) {
      const result = await reconcileFanslyBulkStreamGate(app.db, {
        pageId: page.id,
        stream: stream.stream,
        gateState: stream.allowlisted === undefined
          ? resolveGateState({
            pageLabel: page.label,
            streamEnabled: stream.enabled,
            allowlistCsv: effective.fanslyNewStreamPageAllowlist,
          })
          : !stream.enabled
          ? "flag_off"
          : stream.allowlisted
          ? "ramped"
          : "not_allowlisted",
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
