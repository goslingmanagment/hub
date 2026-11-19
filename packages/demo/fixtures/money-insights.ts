/**
 * «Аналитика»: the WP-S1 insights routes of a Fansly page — traffic by
 * source, media, tags, comments, the revenue mix and the coverage panel that
 * says how much of all that Hub holds. Built on the same statistics as
 * «Статистика» and the same ledger as Overview.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";
import { between, demoError, hashString, intBetween, isoDay, queryNumber, queryString, rng, type DemoHandlers, type DemoReply, type DemoRequest } from "../core.ts";
import type { DemoPage } from "../world.ts";
import { TAGS, demoMedia, reachOf } from "./money-creator-stats.ts";
import { DAY_MS, ledgerDay, ownerOnly, pageOr404, startOfDayMs, type LedgerType } from "./money-ledger.ts";

type CoverageRow = KernelOperationResponse<"statsCoverage">["planes"][number];

function ownerPage(request: DemoRequest): DemoPage | DemoReply {
  return ownerOnly(request) ?? pageOr404(request, request.params.pageLabel);
}

function isReply(value: unknown): value is DemoReply {
  return typeof value === "object" && value !== null && (value as { demoReply?: unknown }).demoReply === true;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

function instantWindow(request: DemoRequest): { from: string; to: string; fromMs: number; toMs: number } | DemoReply {
  const from = queryString(request, "from");
  const to = queryString(request, "to");
  if (!from || !to || !INSTANT.test(from) || !INSTANT.test(to)) {
    return demoError(400, "bad_request", "from and to must be RFC 3339 timestamps with an offset");
  }
  return { from, to, fromMs: Date.parse(from), toMs: Date.parse(to) };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function day(ms: number): string {
  return isoDay(new Date(ms));
}

/** First day Hub holds the page's account statistics. */
function historyStartMs(page: DemoPage, now: Date): number {
  return startOfDayMs(now) - reachOf(page).historyDays * DAY_MS;
}

/** A keyset page over a sorted list; the cursor is the next row's index. */
function paged<T>(rows: readonly T[], request: DemoRequest, fallbackLimit: number): { rows: T[]; nextCursor: string | null } {
  const limit = Math.min(500, Math.max(1, queryNumber(request, "limit", fallbackLimit)));
  const cursor = queryString(request, "cursor");
  const start = cursor?.startsWith("k") ? Number(cursor.slice(1)) || 0 : 0;
  const slice = rows.slice(start, start + limit);
  return { rows: slice, nextCursor: start + limit < rows.length ? `k${start + limit}` : null };
}

// --- capture coverage: one table for every route of the page ---

function coverageRows(page: DemoPage, now: Date): CoverageRow[] {
  const history = historyStartMs(page, now);
  const pageId = String(page.id);
  const mediaCount = demoMedia(page).length;
  const row = (
    plane: string,
    scopeRef: string,
    status: string,
    proof: string,
    oldest: number | null,
    newest: number | null,
    extra: Partial<CoverageRow> = {},
  ): CoverageRow => ({
    plane,
    scopeRef,
    status,
    acquisitionMode: plane === "post_likes" ? "none" : scopeRef === "steady" ? "steady_poll" : "history_walk",
    proof,
    oldestCapturedAt: oldest === null ? null : iso(oldest),
    newestCapturedAt: newest === null ? null : iso(newest),
    expectedCount: null,
    observedUniqueCount: null,
    reasonCode: null,
    nextProbeAt: null,
    updatedAt: iso(newest ?? now.getTime() - 3_600_000),
    ...extra,
  });
  const t = now.getTime();
  const repliesInProgress = page.label === "ivy-2";
  return [
    row("stats_account_daily", "", "provider_exhausted", "terminal_response", history, t - 13 * DAY_MS),
    row("stats_account_daily", "steady", "window_captured", "complete_count_matched", t - 14 * DAY_MS, t - 2.5 * 3_600_000, { nextProbeAt: iso(t + 0.5 * 3_600_000) }),
    row("stats_account_hourly", "steady", "window_captured", "complete_count_matched", t - 72 * 3_600_000, t - 3_600_000),
    row("stats_earnings", "", "provider_exhausted", "terminal_response", t - 300 * DAY_MS, t - 20 * DAY_MS),
    row("stats_earnings", "steady", "window_captured", "complete_count_matched", t - 21 * DAY_MS, t - 2 * 3_600_000),
    row("media_stats", pageId, "window_captured", "complete_count_matched", history, t - 5 * 3_600_000, {
      expectedCount: mediaCount,
      observedUniqueCount: page.label === "ivy-1" ? Math.round(mediaCount * 0.68) : mediaCount,
    }),
    row("catalog", pageId, "provider_exhausted", "terminal_response", null, t - 2 * 3_600_000, { expectedCount: mediaCount, observedUniqueCount: mediaCount }),
    row("catalog_vault_media", pageId, "provider_exhausted", "terminal_response", null, t - 6 * 3_600_000),
    row("post_replies", pageId, repliesInProgress ? "in_progress" : "window_captured", repliesInProgress ? "none" : "terminal_response", t - (repliesInProgress ? 19 : 120) * DAY_MS, t - 6 * 3_600_000, repliesInProgress ? { nextProbeAt: iso(t + 2 * 3_600_000) } : {}),
    row("notifications", "", "window_captured", "terminal_response", t - 90 * DAY_MS, t - 0.4 * 3_600_000),
    row("payouts", "", "provider_exhausted", "terminal_response", t - 400 * DAY_MS, t - 26 * 3_600_000),
    row("post_likes", "", "not_started", "none", null, null, { reasonCode: "no_confirmed_like_code_e4", updatedAt: iso(t - 30 * DAY_MS) }),
    // The new collection of Fansly's statistics: the media walk and the audience lanes.
    // nova-1's collection needs attention: nothing read for nine hours.
    ...(() => {
      const lag = page.label === "nova-1" ? 9 * 3_600_000 : 0;
      const walked = page.label === "ivy-1" ? Math.round(mediaCount * 0.68) : mediaCount;
      return [
        row("creator_stats_media", "walk", walked < mediaCount ? "in_progress" : "window_captured", walked < mediaCount ? "none" : "complete_count_matched", history, t - lag - 1.2 * 3_600_000, { expectedCount: mediaCount, observedUniqueCount: walked }),
        row("creator_stats_media", "top:0:7d", "window_captured", "complete_count_matched", t - 7 * DAY_MS, t - lag - 0.6 * 3_600_000),
        row("creator_stats_audience", "steady:geo:0", "window_captured", "complete_count_matched", t - 30 * DAY_MS, t - lag - 0.9 * 3_600_000),
        row("creator_stats_audience", "steady:tags:1:0", "window_captured", "complete_count_matched", t - 30 * DAY_MS, t - lag - 0.9 * 3_600_000),
        row("creator_stats_audience", "steady:active_hours:0", "window_captured", "complete_count_matched", t - 90 * DAY_MS, t - lag - 2.5 * 3_600_000),
        row("creator_stats_audience", "steady:benchmarks:0", "window_captured", "complete_count_matched", t - 30 * DAY_MS, t - lag - 2.5 * 3_600_000),
        row("creator_stats_audience", "steady:media_shown", "window_captured", "complete_count_matched", t - 72 * 3_600_000, t - lag - 0.5 * 3_600_000),
      ];
    })(),
  ];
}

function coverageFor(page: DemoPage, now: Date, planes: readonly string[]): CoverageRow[] {
  return coverageRows(page, now).filter((row) => planes.includes(row.plane));
}

// --- tags ---

const FYP_TAGS: ReadonlyArray<[string, number]> = [
  ["lingerie", 1], ["cosplay", 0.82], ["fitness", 0.7], ["petite", 0.66], ["blonde", 0.58], ["bikini", 0.52],
  ["yoga", 0.45], ["redhead", 0.4], ["tattoos", 0.36], ["goth", 0.31], ["girlnextdoor", 0.29], ["", 0.26],
  ["stockings", 0.22], ["dance", 0.2], ["asmr", 0.17], ["outdoor", 0.15], ["curvy", 0.13], ["smile", 0.1],
];

function statsTags(request: DemoRequest): KernelOperationResponse<"statsTags"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const window = instantWindow(request);
  if (isReply(window)) return window;
  const now = request.now;
  const reach = reachOf(page);
  const weekEnd = startOfDayMs(now);
  const weekStart = weekEnd - 7 * DAY_MS;
  const random = rng(`tags:${page.label}:${day(weekEnd)}`);
  const tags = page.platform === "fansly" ? FYP_TAGS : [];
  const topTags = tags.map(([name, weight], rank) => {
    const views = Math.round(reach.views * 7 * reach.split[0]! * 0.22 * weight * between(random, 0.85, 1.15));
    return {
      plane: "fyp",
      rank,
      tagRef: String(3_000_000 + (hashString(`tag:${name || "unnamed"}`) % 900_000)),
      // One tag came back without its name: Hub never invents it from the id.
      tagName: name === "" ? null : name,
      periodMs: 7 * DAY_MS,
      requestedStart: iso(weekStart),
      requestedEnd: iso(weekEnd),
      views,
      previewViews: Math.round(views * 0.3),
      interactionTimeMs: Math.round(views * between(random, 6, 11) * 1000),
      previewInteractionTimeMs: Math.round(views * 0.3 * 2_500),
      observedAt: iso(now.getTime() - 5 * 3_600_000),
    };
  });
  // The tags' numbers across all of Fansly, one row per tag of the page's lists, as of
  // yesterday. The same on every page (they are Fansly's); a tenth came without numbers.
  const names = [...new Set([...TAGS, ...FYP_TAGS.map(([name]) => name).filter((name) => name !== "")])];
  const platformTags = page.platform !== "fansly" ? [] : names.filter((name) => hashString(`platform-tag:${name}`) % 10 !== 3).map((name) => {
    const tagRandom = rng(`platform-tag:${name}`);
    const size = 10 ** between(tagRandom, 6.3, 8.9);
    return {
      tagRef: String(3_000_000 + (hashString(`tag:${name}`) % 900_000)),
      tagName: name,
      businessDate: isoDay(new Date(weekEnd - DAY_MS)),
      viewCount: Math.round(size),
      postCount: Math.round(size / between(tagRandom, 900, 4_000)),
      source: "tag_stats",
      capturedAt: iso(now.getTime() - 9 * 3_600_000),
    };
  });
  const sliced = paged(topTags, request, 100);
  return {
    page: { label: page.label, platform: page.platform },
    window: { from: window.from, to: window.to },
    topTags: sliced.rows,
    platformTags,
    coverage: coverageRows(page, now),
    nextCursor: sliced.nextCursor,
  };
}

// --- the revenue mix ---

const MIX_CODE: Partial<Record<LedgerType, { code: number; label: string; era: "legacy" | "current" | "single" }>> = {
  subscription: { code: 15001, label: "subscriptions", era: "current" },
  tip: { code: 7101, label: "tips", era: "current" },
  message_purchase: { code: 2110, label: "media", era: "current" },
  post_purchase: { code: 2116, label: "media_sets", era: "current" },
  stream_tip: { code: 45101, label: "stream_tickets", era: "current" },
  refund: { code: 6101, label: "refund", era: "single" },
  chargeback: { code: 6101, label: "refund", era: "single" },
};

type MixRow = KernelOperationResponse<"moneyRevenueMix">["daily"][number];

function mixDay(page: DemoPage, businessDate: string, now: Date): MixRow[] {
  const groups = new Map<number, { label: string; era: "legacy" | "current" | "single"; net: number; gross: number }>();
  const add = (code: number, label: string, era: "legacy" | "current" | "single", net: number) => {
    const group = groups.get(code) ?? { label, era, net: 0, gross: 0 };
    group.net += net;
    group.gross += net > 0 ? Math.round(net / 0.8) : net;
    groups.set(code, group);
  };
  for (const tx of ledgerDay(page, businessDate, now)) {
    const mapped = MIX_CODE[tx.type];
    if (!mapped) continue;
    // Old subscriptions still renew under Fansly's legacy code.
    if (tx.type === "subscription" && hashString(tx.id) % 9 === 0) add(15002, "subscriptions", "legacy", tx.netMills);
    else add(mapped.code, mapped.label, mapped.era, tx.netMills);
  }
  const observed = iso(Math.min(now.getTime() - 2 * 3_600_000, Date.parse(`${businessDate}T00:00:00Z`) + DAY_MS + 3 * 3_600_000));
  return [...groups.entries()].sort((left, right) => left[0] - right[0]).map(([typeCode, group]) => ({
    businessDate,
    typeCode,
    typeLabel: group.label,
    typeEra: group.era,
    mappingVersion: 1,
    grossMills: group.gross,
    netMills: group.net,
    lastObservedAt: observed,
  }));
}

function moneyRevenueMix(request: DemoRequest): KernelOperationResponse<"moneyRevenueMix"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const from = queryString(request, "from");
  const to = queryString(request, "to");
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return demoError(400, "bad_request", "from and to must be business dates");
  }
  const now = request.now;
  const today = isoDay(now);
  const earliest = isoDay(new Date(startOfDayMs(now) - 300 * DAY_MS));
  const daily: MixRow[] = [];
  if (page.platform === "fansly") {
    for (let at = Date.parse(`${from}T00:00:00Z`); at <= Date.parse(`${to}T00:00:00Z`); at += DAY_MS) {
      const businessDate = day(at);
      if (businessDate > today || businessDate < earliest) continue;
      daily.push(...mixDay(page, businessDate, now));
    }
  }
  // The Statements' months: the last six, and Fansly's rolling header.
  const months: KernelOperationResponse<"moneyRevenueMix">["months"] = [];
  if (page.platform === "fansly") {
    const random = rng(`months:${page.label}`);
    let rollupNet = 0;
    let rollupGross = 0;
    const current = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (let back = 5; back >= 0; back -= 1) {
      const start = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - back, 1);
      const end = Date.UTC(current.getUTCFullYear(), current.getUTCMonth() - back + 1, 1);
      let net = 0;
      let gross = 0;
      for (let at = start; at < end && at <= now.getTime(); at += DAY_MS) {
        for (const row of mixDay(page, day(at), now)) {
          net += row.netMills ?? 0;
          gross += row.grossMills ?? 0;
        }
      }
      rollupNet += net;
      rollupGross += gross;
      const date = new Date(start);
      const top = page.dailyNet > 100 ? between(random, 0.4, 1.6) : between(random, 8, 22);
      months.push({
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        rollup: false,
        totalGrossMills: gross,
        totalNetMills: net,
        topPercent: top.toFixed(1),
        maxTopPercent: (top * between(random, 0.5, 0.9)).toFixed(1),
        windowStart: iso(start),
        windowEnd: iso(Math.min(end, now.getTime())),
        lastObservedAt: iso(now.getTime() - 3 * 3_600_000),
      });
    }
    months.push({
      year: 0,
      month: 0,
      rollup: true,
      totalGrossMills: Math.round(rollupGross * 2.1),
      totalNetMills: Math.round(rollupNet * 2.1),
      topPercent: null,
      maxTopPercent: null,
      windowStart: null,
      windowEnd: null,
      lastObservedAt: iso(now.getTime() - 3 * 3_600_000),
    });
    months.reverse();
  }
  const sliced = paged(daily, request, 500);
  return {
    page: { label: page.label, platform: page.platform },
    window: { from, to },
    daily: sliced.rows,
    months,
    coverage: coverageFor(page, now, ["stats_earnings"]),
    nextCursor: sliced.nextCursor,
  };
}

// --- the coverage panel ---

const STREAMS: ReadonlyArray<{ stream: string; resources: readonly string[]; everyHours: number }> = [
  { stream: "stats_snapshot", resources: ["stats.series", "stats.summary", "stats.hourly", "stats.geo", "stats.tags"], everyHours: 1 },
  { stream: "media_stats", resources: ["media-stats.walk", "stats.media", "creator-stats.media"], everyHours: 6 },
  { stream: "transactions", resources: ["transactions.head", "transactions.page", "transactions.backfill"], everyHours: 0.25 },
  { stream: "subscribers", resources: ["subscribers.poll", "subscribers.page"], everyHours: 1 },
  { stream: "followers", resources: ["followers.head", "followers.page", "followers.reconcile"], everyHours: 2 },
  { stream: "dm_conversations", resources: ["dm.conversations"], everyHours: 0.1 },
  { stream: "dm_messages", resources: ["dm.messages", "dm.live"], everyHours: 0.05 },
  { stream: "top_spenders", resources: ["top-spenders.page"], everyHours: 12 },
];

function statsCoverage(request: DemoRequest): KernelOperationResponse<"statsCoverage"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const now = request.now;
  const t = now.getTime();
  const hour = 3_600_000;
  if (page.platform !== "fansly") {
    return { page: { label: page.label, platform: page.platform }, generatedAt: iso(t), planes: [], engine: null };
  }
  const streams = STREAMS.map((item) => {
    const random = rng(`stream:${page.label}:${item.stream}`);
    const lastRead = t - item.everyHours * hour * between(random, 0.1, 0.9);
    const stream = {
      stream: item.stream,
      resources: [...item.resources],
      succeededAt: iso(lastRead),
      nextDueAt: iso(lastRead + item.everyHours * hour),
      activeWork: intBetween(random, 1, 3),
      paused: false,
      stopped: "none" as "none" | "some" | "all",
      stops: [] as Array<{ reason: "paused" | "page_hold" | "resource_hold" | "route_hold"; by: string[]; resources: string[]; until: string | null }>,
      needsAttention: false,
      reason: null as string | null,
      waiting: { resource: item.resources[0]!, reason: "not_due" as const, until: iso(lastRead + item.everyHours * hour) } as
        { resource: string; reason: "not_due" | "pacer"; until: string | null } | null,
      consecutiveFailures: 0,
    };
    // nova-1's follower list hit Fansly's limit: its route is held for a while.
    if (page.label === "nova-1" && item.stream === "followers") {
      stream.succeededAt = iso(t - 9 * hour);
      stream.nextDueAt = iso(t + 40 * 60_000);
      stream.stopped = "some";
      stream.stops = [{ reason: "route_hold", by: ["/api/v1/account/followers"], resources: ["followers.page"], until: iso(t + 40 * 60_000) }];
      stream.consecutiveFailures = 2;
      stream.waiting = null;
    }
    // ivy-1's media walk is still on its first pass and waits on the pace.
    if (page.label === "ivy-1" && item.stream === "media_stats") {
      stream.activeWork = 17;
      stream.waiting = { resource: "media-stats.walk", reason: "pacer", until: iso(t + 4 * 60_000) };
    }
    return stream;
  });
  return {
    page: { label: page.label, platform: page.platform },
    generatedAt: iso(t),
    planes: coverageRows(page, now),
    engine: { mode: "live", ownerRunning: true, streams },
  };
}

function statsHoldings(request: DemoRequest): KernelOperationResponse<"statsHoldings"> | DemoReply {
  const page = ownerPage(request);
  if (isReply(page)) return page;
  const t = request.now.getTime();
  const hour = 3_600_000;
  if (page.platform !== "fansly") return { page: { label: page.label, platform: page.platform }, holdings: [] };
  const days = reachOf(page).historyDays;
  const mediaCount = demoMedia(page).length;
  const holdings = [
    ["stats_traffic_buckets", days * 9],
    ["stats_top_media", Math.round(days / 7) * 15],
    ["stats_top_tags", Math.round(days / 7) * 18],
    ["fansly_media_tag_stats", mediaCount * 4],
    ["platform_tag_daily", days * 14],
    ["creator_media", mediaCount],
    ["media_orders", Math.round(mediaCount * 6.5)],
    ["message_media_offers", Math.round(page.dailyNet * 9)],
    ["revenue_mix_daily", 300 * 5],
    ["revenue_month_totals", 11],
    ["page_promo_links", 4],
    ["platform_notifications", Math.round(days * 38)],
    ["post_likes", 0],
    ["post_comments", Math.round(mediaCount * 7.4)],
    ["creator_vault_albums", 9],
    ["page_subscription_tiers", 3],
    ["page_walls", 2],
    ["page_automated_messages", 3],
    ["page_payout_requests", 18],
    ["page_payout_methods", 1],
  ] as const;
  return {
    page: { label: page.label, platform: page.platform },
    holdings: holdings.map(([projection, rowCount]) => ({
      projection,
      rowCount,
      oldestAt: rowCount === 0 ? null : iso(t - (projection.startsWith("page_payout") ? 400 : projection.startsWith("revenue") ? 300 : days) * DAY_MS),
      newestAt: rowCount === 0 ? null : iso(t - 2 * hour),
    })),
  };
}

export const insightsHandlers: DemoHandlers = {
  statsTags,
  statsCoverage,
  statsHoldings,
  moneyRevenueMix,
};
