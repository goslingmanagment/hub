/**
 * Overview, the revenue charts and the operations list — all read from the
 * ledger in money-ledger.ts, so every amount on Overview opens operations
 * that add up to it.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { daysAgo, demoError, hoursAgo, iso, isoDay, queryNumber, queryString, rng, intBetween, type DemoHandlers, type DemoRequest } from "../core.ts";
import { DEMO_MODELS, DEMO_OFAPI_OFF_AT, DEMO_PAGES, demoFans, type DemoPage } from "../world.ts";
import { pagePopulation } from "./page-world.ts";
import {
  DAY_MS,
  HISTORY_DAYS,
  LEDGER_BUCKET,
  LEDGER_TYPES,
  addTx,
  daysBetween,
  deltaPct,
  emptyTotals,
  historyStartMs,
  isoOrNull,
  ledgerDay,
  ledgerRange,
  pageTotals,
  platformWindow,
  startOfDayMs,
  visiblePages,
  type LedgerTx,
  type LedgerType,
  type PlatformWindow,
  type Totals,
} from "./money-ledger.ts";

type Period = "today" | "7d" | "30d" | "all" | "custom";

export function periodOf(request: DemoRequest, fallback: Period = "30d"): Period {
  const value = queryString(request, "period");
  return value === "today" || value === "7d" || value === "30d" || value === "all" || value === "custom" ? value : fallback;
}

/** The clock a report resolves its window with: `windowAt` when the screen pins it. */
export function clockOf(request: DemoRequest): Date {
  const windowAt = queryString(request, "windowAt");
  const parsed = windowAt ? new Date(windowAt) : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed : request.now;
}

export function customOf(request: DemoRequest): { from: string; to: string } | undefined {
  const from = queryString(request, "from");
  const to = queryString(request, "to");
  return from && to ? { from, to } : undefined;
}

function platformsOf(pages: readonly DemoPage[]): Array<DemoPage["platform"]> {
  return (["fansly", "onlyfans"] as const).filter((platform) => pages.some((page) => page.platform === platform));
}

function windowsFor(pages: readonly DemoPage[], period: Period, now: Date, custom?: { from: string; to: string }): PlatformWindow[] {
  return platformsOf(pages).map((platform) => platformWindow(platform, period, now, custom));
}

function windowOf(windows: readonly PlatformWindow[], platform: DemoPage["platform"]): PlatformWindow {
  return windows.find((item) => item.platform === platform)!;
}

export function breakdownOf(totals: Totals) {
  return LEDGER_TYPES.filter((type) => totals.byType.has(type)).map((type) => ({
    canonicalType: type,
    bucket: LEDGER_BUCKET[type],
    netAmountMills: totals.byType.get(type)!,
  }));
}

export function sourcesOf(current: Totals, previous: Totals) {
  return LEDGER_TYPES.filter((type) => current.byType.has(type) || previous.byType.has(type)).map((type) => {
    const now = current.byType.get(type) ?? 0;
    const before = previous.byType.get(type) ?? 0;
    return {
      canonicalType: type,
      bucket: LEDGER_BUCKET[type],
      currentNetMills: now,
      previousNetMills: before,
      deltaNetMills: now - before,
      deltaPct: deltaPct(now, before),
    };
  });
}

function merge(into: Totals, from: Totals): void {
  into.net += from.net;
  into.revenue += from.revenue;
  into.adjustment += from.adjustment;
  into.unclassified += from.unclassified;
  into.count += from.count;
  for (const [type, value] of from.byType) into.byType.set(type, (into.byType.get(type) ?? 0) + value);
}

function minIso(values: Array<number | null>): string | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : new Date(Math.min(...known)).toISOString();
}

function maxIso(values: Array<number | null>): string | null {
  const known = values.filter((value): value is number => value !== null);
  return known.length === 0 ? null : new Date(Math.max(...known)).toISOString();
}

// --- Overview: the revenue report ---

function overviewRevenue(request: DemoRequest): KernelOperationResponse<"overviewRevenue"> {
  const now = clockOf(request);
  const period = periodOf(request, "7d");
  const custom = customOf(request);
  const pages = visiblePages(request);
  const windows = windowsFor(pages, period, now, custom);
  const comparing = period !== "all";

  const all = emptyTotals();
  const allPrevious = emptyTotals();
  const pageItems = pages.map((page) => {
    const window = windowOf(windows, page.platform);
    const current = pageTotals(page, window.fromMs, window.toMs, now);
    const previous = comparing ? pageTotals(page, window.comparisonFromMs, window.comparisonToMs, now) : null;
    merge(all, current);
    if (previous) merge(allPrevious, previous);
    return { page, current, previous };
  });

  const models = DEMO_MODELS
    .map((model) => {
      const own = pageItems.filter((item) => item.page.modelSlug === model.slug);
      if (own.length === 0) return null;
      const net = own.reduce((sum, item) => sum + item.current.net, 0);
      const previous = comparing ? own.reduce((sum, item) => sum + (item.previous?.net ?? 0), 0) : null;
      return {
        modelId: model.id,
        modelSlug: model.slug,
        modelName: model.name,
        pageCount: own.length,
        netEarningsMills: net,
        totalNetMills: net,
        previousNetEarningsMills: previous,
        deltaNetMills: previous === null ? null : net - previous,
        deltaPct: previous === null ? null : deltaPct(net, previous),
        status: "active" as const,
      };
    })
    .filter((item) => item !== null);

  return {
    revenueMills: all.revenue,
    adjustmentMills: all.adjustment,
    unclassifiedMills: all.unclassified,
    netEarningsMills: all.net,
    totalNetMills: all.net,
    period,
    windowAt: now.toISOString(),
    from: minIso(windows.map((window) => window.fromMs)),
    to: maxIso(windows.map((window) => window.toMs)),
    currency: "USD",
    breakdown: breakdownOf(all),
    comparison: comparing
      ? {
          from: minIso(windows.map((window) => window.comparisonFromMs))!,
          to: maxIso(windows.map((window) => window.comparisonToMs))!,
          netEarningsMills: allPrevious.net,
          totalNetMills: allPrevious.net,
          deltaNetMills: all.net - allPrevious.net,
          deltaPct: deltaPct(all.net, allPrevious.net),
          sources: sourcesOf(all, allPrevious),
        }
      : null,
    platformWindows: windows.map((window) => ({
      platform: window.platform,
      from: isoOrNull(window.fromMs),
      to: isoOrNull(window.toMs),
      comparisonFrom: isoOrNull(window.comparisonFromMs),
      comparisonTo: isoOrNull(window.comparisonToMs),
    })),
    models,
    pages: pageItems.map(({ page, current, previous }) => ({
      pageId: page.id,
      pageLabel: page.label,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      netEarningsMills: current.net,
      totalNetMills: current.net,
      previousNetEarningsMills: previous ? previous.net : null,
      deltaNetMills: previous ? current.net - previous.net : null,
      deltaPct: previous ? deltaPct(current.net, previous.net) : null,
      platform: page.platform,
      status: "active" as const,
    })),
  };
}

// --- Overview: the catalog (audience, sync state, short sums) ---

function syncUxOf(page: DemoPage, now: Date) {
  if (page.health === "off") {
    return {
      state: "off" as const,
      label: "Нет доступа",
      headline: "Сбор OnlyFans выключен",
      detail: "Доступ к OnlyFans через сервис выключен с 1 ноября.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: iso(new Date(DEMO_OFAPI_OFF_AT)),
      requiresAction: false,
    };
  }
  if (page.health === "attention") {
    return {
      state: "attention" as const,
      label: "Нужен вход",
      headline: "Fansly вышел из аккаунта",
      detail: "Fansly signed the page's browser out; a new login is needed.",
      progressLabel: null,
      nextRetryAt: null,
      updatedAt: iso(hoursAgo(now, 5.2)),
      requiresAction: true,
    };
  }
  return {
    state: "healthy" as const,
    label: "В порядке",
    headline: "Данные свежие",
    detail: null,
    progressLabel: null,
    nextRetryAt: null,
    updatedAt: iso(hoursAgo(now, 0.2)),
    requiresAction: false,
  };
}

function summaryOf(pages: readonly DemoPage[], period: "7d" | "30d", now: Date) {
  const current = emptyTotals();
  const previous = emptyTotals();
  for (const page of pages) {
    const window = platformWindow(page.platform, period, now);
    merge(current, pageTotals(page, window.fromMs, window.toMs, now));
    merge(previous, pageTotals(page, window.comparisonFromMs, window.comparisonToMs, now));
  }
  return {
    revenueMills: current.revenue,
    adjustmentMills: current.adjustment,
    unclassifiedMills: current.unclassified,
    netEarningsMills: current.net,
    previousNetEarningsMills: previous.net,
    deltaPct: deltaPct(current.net, previous.net),
  };
}

function overview(request: DemoRequest): KernelOperationResponse<"overview"> {
  const now = request.now;
  const pages = visiblePages(request);
  const models = new Set(pages.map((page) => page.modelSlug));
  const fanCount = pages.reduce((sum, page) => sum + page.subscribers + Math.round((page.followers ?? 0) * 0.85) + demoFans(page.label).length, 0);
  const worst = pages.find((page) => page.health === "attention") ?? null;
  return {
    counts: { models: models.size, pages: pages.length, fans: fanCount },
    revenue: { "7d": summaryOf(pages, "7d", now), "30d": summaryOf(pages, "30d", now) },
    overall: {
      syncUx: worst
        ? {
            ...syncUxOf(worst, now),
            headline: `${worst.label}: нужен вход`,
          }
        : syncUxOf(pages[0] ?? DEMO_PAGES[0]!, now),
    },
    pages: pages.map((page) => {
      const random = rng(`overview:${page.label}:${isoDay(now)}`);
      const off = page.health === "off";
      // One count with the card and «Подписчики»: as the server, a subscription with a price.
      const paid = pagePopulation(page).filter((item) => item.subscription?.paid === true).length;
      const today = pageTotals(page, startOfDayMs(now), now.getTime() + 1, now);
      const week = platformWindow(page.platform, "7d", now);
      const month = platformWindow(page.platform, "30d", now);
      return {
        id: page.id,
        label: page.label,
        platform: page.platform,
        modelSlug: page.modelSlug,
        modelName: page.modelName,
        username: page.username,
        subscriberCount: { value: page.subscribers, available: true },
        followerCount: { value: page.followers, available: page.followers !== null },
        paidSubscriberCount: { value: paid, available: true },
        freeAudienceCount: page.platform === "fansly"
          ? { value: page.followers, available: page.followers !== null }
          : { value: page.subscribers - paid, available: true },
        revenueTodayMills: today.net,
        revenue7dMills: pageTotals(page, week.fromMs, week.toMs, now).net,
        revenue30dMills: pageTotals(page, month.fromMs, month.toMs, now).net,
        newSubscribersToday: off ? 0 : intBetween(random, 0, Math.max(1, Math.round(page.subscribers / 120))),
        newFollowersToday: page.followers === null ? 0 : intBetween(random, 2, Math.max(4, Math.round(page.followers / 220))),
        connectionStatus: off ? "expired" as const : page.health === "attention" ? "stale" as const : "active" as const,
        lastLightSyncAt: page.platform === "fansly" ? iso(hoursAgo(now, page.health === "attention" ? 5.2 : 0.3)) : null,
        lastFollowerSyncAt: page.platform === "fansly" ? iso(hoursAgo(now, page.health === "attention" ? 9 : 1)) : null,
        lastSyncError: off ? "Сбор OnlyFans выключен" : null,
        syncUx: syncUxOf(page, now),
      };
    }),
    setup: {
      hasPages: pages.length > 0,
      hasFanslyPages: pages.some((page) => page.platform === "fansly"),
      hasOnlyFansPages: pages.some((page) => page.platform === "onlyfans"),
    },
  };
}

// --- Daily series ---

/** The days a series covers: the period's widest platform window, or the
 *  stored history for "all". */
function seriesRange(pages: readonly DemoPage[], period: Period, now: Date, custom?: { from: string; to: string }) {
  if (period === "all") return { fromMs: historyStartMs(now), toMs: startOfDayMs(now) + DAY_MS };
  const windows = windowsFor(pages, period === "custom" && !custom ? "30d" : period, now, custom);
  return {
    fromMs: Math.min(...windows.map((window) => window.fromMs!)),
    toMs: Math.max(...windows.map((window) => window.toMs!)),
  };
}

function dailySeries(request: DemoRequest, pages: readonly DemoPage[]): KernelOperationResponse<"overviewRevenueDaily"> {
  const now = clockOf(request);
  const period = periodOf(request, "30d");
  const byType = queryString(request, "groupByType") === "true";
  if (pages.length === 0) return { series: [] };
  const range = seriesRange(pages, period, now, customOf(request));
  const series: KernelOperationResponse<"overviewRevenueDaily">["series"] = [];
  for (const day of daysBetween(range.fromMs, range.toMs)) {
    const txs: LedgerTx[] = [];
    for (const page of pages) {
      // Each page keeps to its own platform's window.
      const window = period === "all" ? null : platformWindow(page.platform, period, now, customOf(request));
      const dayMs = Date.parse(`${day}T00:00:00Z`);
      if (window && (dayMs < window.fromMs! || dayMs >= window.toMs!)) continue;
      txs.push(...ledgerDay(page, day, now));
    }
    if (txs.length === 0) continue;
    if (byType) {
      const groups = new Map<LedgerType, { net: number; count: number }>();
      for (const tx of txs) {
        const group = groups.get(tx.type) ?? { net: 0, count: 0 };
        group.net += tx.netMills;
        group.count += 1;
        groups.set(tx.type, group);
      }
      for (const type of LEDGER_TYPES) {
        const group = groups.get(type);
        if (group) series.push({ businessDate: day, canonicalType: type, netAmountMills: group.net, transactionCount: group.count });
      }
    } else {
      series.push({
        businessDate: day,
        netAmountMills: txs.reduce((sum, tx) => sum + tx.netMills, 0),
        transactionCount: txs.length,
      });
    }
  }
  return { series };
}

function overviewRevenueByModel(request: DemoRequest): KernelOperationResponse<"overviewRevenueByModel"> {
  const pages = visiblePages(request);
  return {
    models: DEMO_MODELS
      .map((model) => {
        const own = pages.filter((page) => page.modelSlug === model.slug);
        if (own.length === 0) return null;
        const { series } = dailySeries({ ...request, query: { ...request.query, groupByType: "false" } }, own);
        return {
          modelSlug: model.slug,
          modelName: model.name,
          pageCount: own.length,
          totalNetAmountMills: series.reduce((sum, point) => sum + point.netAmountMills, 0),
          transactionCount: series.reduce((sum, point) => sum + point.transactionCount, 0),
          series: series.map(({ businessDate, netAmountMills, transactionCount }) => ({ businessDate, netAmountMills, transactionCount })),
        };
      })
      .filter((item) => item !== null)
      .sort((left, right) => right.totalNetAmountMills - left.totalNetAmountMills),
  };
}

// --- Operations across pages ---

const ALL_TYPES = new Set<string>(LEDGER_TYPES);

function crossPageTransactions(request: DemoRequest): KernelOperationResponse<"crossPageTransactions"> {
  const now = request.now;
  const limit = Math.min(200, Math.max(1, queryNumber(request, "limit", 50)));
  const offset = Math.max(0, queryNumber(request, "offset", 0));
  const pageLabel = queryString(request, "pageLabel") ?? null;
  const typeText = queryString(request, "type");
  const type = typeText && (ALL_TYPES.has(typeText) || typeText === "payout_reversal") ? typeText as LedgerType | "payout_reversal" : null;
  const stateText = queryString(request, "state");
  const state = stateText === "pending" || stateText === "posted" || stateText === "unknown" ? stateText : null;
  const sortBy = queryString(request, "sortBy") ?? "occurredAt";
  const sortDir = queryString(request, "sortDir") === "asc" ? 1 : -1;
  const fromText = queryString(request, "from");
  const toText = queryString(request, "to");
  const reportableOnly = queryString(request, "reportableOnly") === "true";
  const fromMs = fromText ? Date.parse(fromText) : historyStartMs(now);
  const toMs = toText ? Date.parse(toText) : now.getTime() + 1;

  const pages = visiblePages(request).filter((page) => pageLabel === null || page.label === pageLabel);
  // A year of operations is the most the demo walks; older windows are empty.
  const floor = startOfDayMs(daysAgo(now, HISTORY_DAYS + 400));
  const items: LedgerTx[] = [];
  for (const page of pages) {
    for (const tx of ledgerRange(page, Math.max(fromMs, floor), toMs, now)) {
      if (type !== null && tx.type !== type) continue;
      if (state !== null && tx.state !== state) continue;
      items.push(tx);
    }
  }
  const key = (tx: LedgerTx) => (sortBy === "netAmountMills" ? tx.netMills : sortBy === "grossAmountMills" ? tx.grossMills : tx.occurredMs);
  items.sort((left, right) => (key(left) - key(right)) * sortDir || (right.occurredMs - left.occurredMs));
  const total = items.length;
  const net = items.reduce((sum, tx) => sum + tx.netMills, 0);

  return {
    items: items.slice(offset, offset + limit).map((tx) => ({
      transactionId: tx.id,
      rawType: tx.rawType,
      canonicalType: tx.type,
      transactionState: tx.state,
      amountMills: tx.grossMills,
      destinationAmountMills: tx.netMills,
      netAmountMills: tx.netMills,
      occurredAt: new Date(tx.occurredMs).toISOString(),
      sourceUpdatedAt: tx.updatedMs === null ? null : new Date(Math.min(tx.updatedMs, now.getTime())).toISOString(),
      fan: tx.fan
        ? { platformUserId: tx.fan.platformUserId, username: tx.fan.username, displayName: tx.fan.displayName === tx.fan.username ? null : tx.fan.displayName }
        : null,
      pageLabel: tx.label,
      platform: tx.platform,
    })),
    limit,
    offset,
    total,
    summary: { netAmountMills: net, currency: "USD", readAt: now.toISOString() },
    scope: {
      pageLabel,
      from: fromText ? new Date(fromText).toISOString() : null,
      to: toText ? new Date(toText).toISOString() : null,
      type,
      state,
      reportableOnly,
    },
  };
}

export const revenueHandlers: DemoHandlers = {
  overview,
  overviewRevenue,
  overviewRevenueDaily: (request) => dailySeries(request, visiblePages(request)),
  overviewRevenueByModel,
  pageRevenueDaily: (request) => {
    const page = visiblePages(request).find((item) => item.label === request.params.pageLabel);
    if (!page) return demoError(404, "not_found", `Страница ${request.params.pageLabel ?? ""} не найдена`);
    return dailySeries(request, [page]);
  },
  modelRevenueDaily: (request) => {
    const pages = visiblePages(request).filter((item) => item.modelSlug === request.params.modelSlug);
    if (pages.length === 0) return demoError(404, "not_found", `Модель ${request.params.modelSlug ?? ""} не найдена`);
    return dailySeries(request, pages);
  },
  crossPageTransactions,
};
