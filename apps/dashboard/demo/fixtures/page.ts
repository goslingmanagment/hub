import type { DemoHandlers, DemoReply } from "../core.ts";
import { deltaPct, isoOrNull, pageTotals, platformWindow } from "./money-ledger.ts";
import { breakdownOf, clockOf, customOf, periodOf, sourcesOf } from "./money-revenue.ts";
import { pageBrowserHandlers } from "./page-browser.ts";
import { pageFanHandlers } from "./page-fans.ts";
import { pageInsightHandlers } from "./page-insights.ts";
import { assignedPage, resolvePage } from "./page-world.ts";

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

/** A page's revenue windows: the same ledger the overview and the operations read, so
 *  a page's sum on every screen is the sum of its operations. */
const pageRevenueHandlers: DemoHandlers = {
  pageRevenue: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const now = clockOf(request);
    const period = periodOf(request, "7d");
    const window = platformWindow(page.platform, period, now, customOf(request));
    const current = pageTotals(page, window.fromMs, window.toMs, now);
    const previous = period === "all" ? null : pageTotals(page, window.comparisonFromMs, window.comparisonToMs, now);
    return {
      revenueMills: current.revenue,
      adjustmentMills: current.adjustment,
      unclassifiedMills: current.unclassified,
      netEarningsMills: current.net,
      totalNetMills: current.net,
      period,
      windowAt: now.toISOString(),
      from: isoOrNull(window.fromMs),
      to: isoOrNull(window.toMs),
      currency: "USD" as const,
      breakdown: breakdownOf(current),
      comparison: previous && {
        from: isoOrNull(window.comparisonFromMs)!,
        to: isoOrNull(window.comparisonToMs)!,
        netEarningsMills: previous.net,
        totalNetMills: previous.net,
        deltaNetMills: current.net - previous.net,
        deltaPct: deltaPct(current.net, previous.net),
        sources: sourcesOf(current, previous),
      },
      platformWindows: [{
        platform: page.platform,
        from: isoOrNull(window.fromMs),
        to: isoOrNull(window.toMs),
        comparisonFrom: isoOrNull(window.comparisonFromMs),
        comparisonTo: isoOrNull(window.comparisonToMs),
      }],
      page: assignedPage(page, now),
    };
  },
};

/** Demo answers of this area's screens (see demo/core.ts). */
export const pageHandlers: DemoHandlers = {
  ...pageRevenueHandlers,
  ...pageFanHandlers,
  ...pageInsightHandlers,
  ...pageBrowserHandlers,
};
