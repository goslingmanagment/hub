import { daysAgo, iso, isoDay, mills, queryString, type DemoHandlers, type DemoReply } from "../core.ts";
import { demoNetSum } from "../world.ts";
import { pageBrowserHandlers } from "./page-browser.ts";
import { pageFanHandlers } from "./page-fans.ts";
import { pageInsightHandlers } from "./page-insights.ts";
import { DAY_MS, assignedPage, resolvePage, revenueMix } from "./page-world.ts";

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

const REVENUE_TYPES = ["subscription", "tip", "message_purchase", "post_purchase", "stream_tip"] as const;

/** A window's net split by kind, with a small chargeback on longer windows. */
function breakdownOf(netMills: number, days: number, mix: ReturnType<typeof revenueMix>) {
  const chargeback = days >= 30 && netMills > 0 ? -Math.round(netMills * 0.004) : 0;
  const revenue = netMills - chargeback;
  const rows = REVENUE_TYPES.map((type) => ({ canonicalType: type, bucket: "revenue" as const, netAmountMills: Math.round(revenue * mix[type]) }));
  const assigned = rows.reduce((sum, row) => sum + row.netAmountMills, 0);
  const messages = rows.find((row) => row.canonicalType === "message_purchase");
  if (messages) messages.netAmountMills += revenue - assigned;
  const kept: { canonicalType: (typeof REVENUE_TYPES)[number] | "chargeback"; bucket: "revenue" | "adjustment"; netAmountMills: number }[] = rows.filter((row) => row.netAmountMills !== 0);
  if (chargeback !== 0) kept.push({ canonicalType: "chargeback", bucket: "adjustment", netAmountMills: chargeback });
  return { revenue, chargeback, rows: kept };
}

/** A page's revenue windows: sums of the same daily net the overview and the money screens use. */
const pageRevenueHandlers: DemoHandlers = {
  pageRevenue: (request) => {
    const page = resolvePage(request);
    if (isReply(page)) return page;
    const now = request.now;
    const period = queryString(request, "period") ?? "7d";
    let days: number;
    let offset = 0;
    if (period === "custom") {
      const from = queryString(request, "from") ?? isoDay(now);
      const to = queryString(request, "to") ?? isoDay(now);
      offset = Math.max(0, Math.round((Date.parse(`${isoDay(now)}T00:00:00Z`) - Date.parse(`${to}T00:00:00Z`)) / DAY_MS));
      days = Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1);
    } else {
      days = period === "today" ? 1 : period === "30d" ? 30 : period === "all" ? 365 : 7;
    }
    const net = mills(demoNetSum(page.label, now, days, offset));
    const mix = revenueMix(page);
    const current = breakdownOf(net, days, mix);
    const end = daysAgo(now, offset);
    const start = daysAgo(end, days - 1, 0);
    const windowFrom = period === "all" ? null : iso(start);
    const windowTo = offset === 0 ? iso(now) : `${isoDay(end)}T23:59:59.999Z`;
    let comparison = null;
    let comparisonFrom: string | null = null;
    let comparisonTo: string | null = null;
    if (period !== "all") {
      const previous = mills(demoNetSum(page.label, now, days, offset + days));
      const prior = breakdownOf(previous, days, mix);
      comparisonFrom = iso(daysAgo(start, days, 0));
      comparisonTo = iso(new Date(start.getTime() - 1));
      comparison = {
        from: comparisonFrom,
        to: comparisonTo,
        netEarningsMills: previous,
        totalNetMills: previous,
        deltaNetMills: net - previous,
        deltaPct: previous === 0 ? null : ((net - previous) / Math.abs(previous)) * 100,
        sources: current.rows.map((row) => {
          const before = prior.rows.find((item) => item.canonicalType === row.canonicalType)?.netAmountMills ?? 0;
          return {
            canonicalType: row.canonicalType,
            bucket: row.bucket,
            currentNetMills: row.netAmountMills,
            previousNetMills: before,
            deltaNetMills: row.netAmountMills - before,
            deltaPct: before === 0 ? null : ((row.netAmountMills - before) / Math.abs(before)) * 100,
          };
        }),
      };
    }
    return {
      revenueMills: current.revenue,
      adjustmentMills: current.chargeback,
      unclassifiedMills: 0,
      netEarningsMills: net,
      totalNetMills: net,
      period: period as "today" | "7d" | "30d" | "all" | "custom",
      windowAt: iso(now),
      from: windowFrom,
      to: windowTo,
      currency: "USD" as const,
      breakdown: current.rows,
      comparison,
      platformWindows: [{ platform: page.platform, from: windowFrom, to: windowTo, comparisonFrom, comparisonTo }],
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
