import { getWebhookDeliveryHistoryCoverage, type OpsMetricSampleInput } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

// H2: the delivery-history coverage signal — how old the newest completely
// captured OFAPI delivery history is. The collector catches up by itself once
// it is 30 minutes behind (ofapi-webhook-recovery.ts); above 45 minutes it is
// stuck, and the metric-scoped golden_signal_lag latch opens.
export const OFAPI_DELIVERY_HISTORY_AGE_METRIC = "ofapi_delivery_history_age";
export const OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS = 45 * 60_000;

/** Gauge samples for the golden-signal sampler: none while collection is off
 * or no webhook is registered, `null` when the probe itself failed (a blind
 * spot the sampler latches like a breach). */
export async function sampleOfapiDeliveryHistoryAge(
  app: Pick<AppContext, "db">,
  now = Date.now(),
): Promise<OpsMetricSampleInput[] | null> {
  try {
    const coverage = await getWebhookDeliveryHistoryCoverage(app.db);
    if (!coverage) return [];
    const valueMs = Math.max(0, now - coverage.since.getTime());
    return [
      { metric: OFAPI_DELIVERY_HISTORY_AGE_METRIC, quantile: "p50", valueMs },
      { metric: OFAPI_DELIVERY_HISTORY_AGE_METRIC, quantile: "p95", valueMs },
    ];
  } catch {
    return null;
  }
}
