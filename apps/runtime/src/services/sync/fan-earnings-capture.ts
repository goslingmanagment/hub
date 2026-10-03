import {
  assertOwnedPageSyncLease, claimFanEarningsRotation, PageSyncLeaseLostError,
  renewFanEarningsClaim, settleFanEarningsReceipt,
  withOwnedPageSyncTransaction, type FanEarningsClaim, type FanEarningsReceipt,
  type FanEarningsRefreshWindow,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, FanslyApiError } from "@agency_hub_core/fansly";
import type { AppContext } from "../../bootstrap.ts";
import { buildFanEarningsReceipt } from "../../sync/fansly/lib/fan-earnings-receipt.ts";
import { persistRawPayload, retentionDate } from "./shared.ts";

const ENDPOINTS = {
  lifetime: { endpoint: "fan_earnings_stats" },
  monthly: { endpoint: "fan_earnings_monthly" },
} as const;

async function settleOwnedReceipt(app: AppContext, claim: FanEarningsClaim, receipt: FanEarningsReceipt) {
  return withOwnedPageSyncTransaction(app.db, async (tx) => {
    if (!await renewFanEarningsClaim(tx, claim, receipt.checkedAt)) return false;
    return settleFanEarningsReceipt(tx, claim, receipt);
  });
}

export async function captureFanEarningsEndpoint(app: AppContext, input: {
  pageId: number;
  syncRunId: number;
  fan: { fanId: number | null; platformUserId: string };
  window: FanEarningsRefreshWindow;
  after: Date;
  before: Date;
  shadow: boolean;
  /** Recovery crosses a rejection only after its endpoint debt is durable. */
  isolateRejection?: boolean;
  target?: { claim: FanEarningsClaim; wasAdmitted: () => boolean };
  fetch: () => Promise<{ items: unknown; raw?: unknown }>;
}) {
  const claim = input.target?.claim ?? ((input.shadow || input.isolateRejection) ? await withOwnedPageSyncTransaction(app.db, (tx) =>
    claimFanEarningsRotation(tx, {
      pageId: input.pageId, fanRef: input.fan.platformUserId, window: input.window, now: new Date(),
    })) : null);
  if (input.isolateRejection && !claim) throw new Error("fan_earnings_recovery_claim_required");
  let response: { items: unknown; raw?: unknown };
  try {
    response = await input.fetch();
  } catch (error) {
    if (claim && (!input.target || input.target.wasAdmitted())) {
      const rejected = error instanceof FanslyApiError && [400, 404, 410].includes(error.status ?? 0);
      try {
        const settled = await settleOwnedReceipt(app, claim, {
          outcome: rejected ? "rejected" : "failed", observationId: null, fingerprint: null,
          checkedAt: new Date(), retryAfterAt: error instanceof FanslyApiError ? error.retryAfterAt : null,
        });
        if (input.isolateRejection && settled && rejected && error instanceof FanslyApiError
          && error.retryAfterAt === null) return { outcome: "rejected" as const };
      } catch (receiptError) {
        if (input.isolateRejection && rejected && error instanceof FanslyApiError
          && error.retryAfterAt === null) throw receiptError;
        // Preserve provider class/Retry-After and the contiguous-prefix path.
        // The durable visit-minus-receipt count retains this missing receipt.
        app.logger.warn({ pageId: input.pageId, window: input.window },
          "Fan-earnings failure receipt could not be stored");
      }
    }
    throw error;
  }

  const { endpoint } = ENDPOINTS[input.window];
  const payload = response.raw ?? response.items;
  const captured = await persistRawPayload(app.db, {
    platformAccountId: input.pageId, syncRunId: input.syncRunId, endpoint,
    requestParams: {
      after: input.after.toISOString(), before: input.before.toISOString(),
      fanId: input.fan.fanId, correlationAccountId: input.fan.platformUserId, spendersOnly: !input.target,
      ...(input.target ? { selection: "target" } : {}),
    },
    responsePayload: payload, mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical", retainUntil: retentionDate(),
  }, { action: `inserting ${endpoint} raw payload`, platform: "fansly" });

  // Raw and observation writes finish before parse, lease/claim settlement,
  // or the caller's next endpoint. Lost claims never discard captured bytes.
  let outcome: "observed" | "empty" | "invalid" = "observed";
  if (claim) {
    const receipt = buildFanEarningsReceipt({
      pageId: input.pageId, fanRef: input.fan.platformUserId, window: input.window,
      observationId: captured.observationId, payload, checkedAt: new Date(),
    });
    outcome = receipt.outcome === "observed" ? "observed" : receipt.outcome === "empty" ? "empty" : "invalid";
    try {
      const settled = await settleOwnedReceipt(app, claim, receipt);
      if ((input.target || input.isolateRejection) && !settled) throw new Error("fan_earnings_target_claim_fenced");
    } catch (error) {
      if (error instanceof PageSyncLeaseLostError || input.target || input.isolateRejection) throw error;
      // The receipt transaction rolled back. Continue the captured baseline only
      // while its page lease is still owned; missing receipts remain shadow debt.
      await assertOwnedPageSyncLease(app.db);
      app.logger.warn({ pageId: input.pageId, window: input.window },
        "Fan-earnings success receipt could not be stored");
    }
  }
  if (!Array.isArray(response.items)) {
    throw new Error(input.window === "lifetime"
      ? "Fansly fan earnings stats response was not an array"
      : "Fansly monthly fan earnings response was not an array");
  }
  return { outcome };
}
