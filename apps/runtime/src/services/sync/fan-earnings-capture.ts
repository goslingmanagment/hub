import {
  claimFanEarningsRotation, renewFanEarningsClaim, settleFanEarningsReceipt,
  withOwnedPageSyncTransaction, type FanEarningsClaim, type FanEarningsReceipt,
  type FanEarningsRefreshWindow,
} from "@agency_hub_core/db";
import { FANSLY_MAPPER_VERSION, FanslyApiError } from "@agency_hub_core/fansly";
import type { AppContext } from "../../bootstrap.ts";
import { buildFanEarningsReceipt } from "./fan-earnings-receipt.ts";
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
  fan: { fanId: number; platformUserId: string };
  window: FanEarningsRefreshWindow;
  after: Date;
  before: Date;
  shadow: boolean;
  fetch: () => Promise<{ items: unknown; raw?: unknown }>;
}) {
  const claim = input.shadow ? await withOwnedPageSyncTransaction(app.db, (tx) =>
    claimFanEarningsRotation(tx, {
      pageId: input.pageId, fanRef: input.fan.platformUserId, window: input.window, now: new Date(),
    })) : null;
  let response: { items: unknown; raw?: unknown };
  try {
    response = await input.fetch();
  } catch (error) {
    if (claim) {
      const rejected = error instanceof FanslyApiError && [400, 404, 410].includes(error.status ?? 0);
      try {
        await settleOwnedReceipt(app, claim, {
          outcome: rejected ? "rejected" : "failed", observationId: null, fingerprint: null,
          checkedAt: new Date(), retryAfterAt: error instanceof FanslyApiError ? error.retryAfterAt : null,
        });
      } catch {
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
      fanId: input.fan.fanId, correlationAccountId: input.fan.platformUserId, spendersOnly: true,
    },
    responsePayload: payload, mapperVersion: FANSLY_MAPPER_VERSION,
    payloadKind: "mapping_critical", retainUntil: retentionDate(),
  }, { action: `inserting ${endpoint} raw payload`, platform: "fansly" });

  // Raw and observation writes finish before parse, lease/claim settlement,
  // or the caller's next endpoint. Lost claims never discard captured bytes.
  if (claim) {
    const receipt = buildFanEarningsReceipt({
      pageId: input.pageId, fanRef: input.fan.platformUserId, window: input.window,
      observationId: captured.observationId, payload, checkedAt: new Date(),
    });
    await settleOwnedReceipt(app, claim, receipt);
  }
  if (!Array.isArray(response.items)) {
    throw new Error(input.window === "lifetime"
      ? "Fansly fan earnings stats response was not an array"
      : "Fansly monthly fan earnings response was not an array");
  }
}
