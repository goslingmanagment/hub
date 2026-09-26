import { getWebhookDeliveryHistoryCoverage, type OpsMetricSampleInput } from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";

// H2: the delivery-history coverage signal — how old the newest completely
// captured OFAPI delivery history is. The collector catches up by itself once
// it is 30 minutes behind (ofapi-webhook-recovery.ts); above 45 minutes it is
// stuck, and the metric-scoped golden_signal_lag latch opens.
export const OFAPI_DELIVERY_HISTORY_AGE_METRIC = "ofapi_delivery_history_age";
export const OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS = 45 * 60_000;

/** Gauge samples for the golden-signal sampler, `null` when the probe itself
 * failed (a blind spot the sampler latches like a breach). While collection is
 * off or no webhook is registered there is no coverage to age: the gauge reads
 * a neutral 0, so a latch opened before switching collection off resolves
 * instead of staying open with no series behind it. */
export async function sampleOfapiDeliveryHistoryAge(
  app: Pick<AppContext, "db">,
  now = Date.now(),
): Promise<OpsMetricSampleInput[] | null> {
  try {
    const coverage = await getWebhookDeliveryHistoryCoverage(app.db);
    const valueMs = coverage ? Math.max(0, now - coverage.since.getTime()) : 0;
    return [
      { metric: OFAPI_DELIVERY_HISTORY_AGE_METRIC, quantile: "p50", valueMs },
      { metric: OFAPI_DELIVERY_HISTORY_AGE_METRIC, quantile: "p95", valueMs },
    ];
  } catch {
    return null;
  }
}
