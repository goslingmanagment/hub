import type { AppContext } from "../../apps/runtime/src/bootstrap.ts";

export type EarningsVisit = { fanRef: string; window: "lifetime" | "monthly" };

/** Match transport budget accounting without making provider requests. */
export function earningsShadowAdapter(
  visits: EarningsVisit[],
  beforeResponse?: (visit: EarningsVisit) => Promise<void>,
) {
  const call = (window: EarningsVisit["window"]) => async (
    context: { requestObserver?: { onRequestEvent(event: unknown): Promise<void> } | null },
    params: { correlationAccountId: string },
  ) => {
    const visit = { fanRef: params.correlationAccountId, window };
    visits.push(visit);
    await context.requestObserver?.onRequestEvent({ state: "started" });
    await beforeResponse?.(visit);
    const items = [{
      correlationAccountId: params.correlationAccountId,
      type: 2110, totalGross: 100, totalNet: 80, year: 2026, month: 9,
    }];
    return { items, raw: items };
  };
  return {
    getEarningsStatsAccountsPage: call("lifetime"),
    getEarningsMonthlyStatsAccountsPage: call("monthly"),
  } as unknown as AppContext["adapter"];
}
