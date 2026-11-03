/**
 * OnlyFans API credits of the demo agency: the balance, every day's spend by
 * source, the per-request ledger, and the projection check. Collection of the
 * OnlyFans pages through the vendor stopped on 2026-11-01, so the days after
 * it spend almost nothing (a balance ping and the account check), the days
 * before it the usual few thousand credits. Days are UTC, as on the screen.
 */
import type { KernelOperationResponse } from "@agency_hub_core/contracts";

import { between, demoError, hashString, intBetween, iso, isoDay, mills, queryNumber, queryString, rng, type DemoReply, type DemoRequest } from "../core.ts";
import { demoDailyNet, demoFans, demoPage } from "../world.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** The day collection of the OnlyFans pages through the vendor stopped. */
const OFF_DAY = "2026-11-01";
const BALANCE_NOW = 184_260;
const FLOOR = 20_000;
const MICRO_USD_PER_CREDIT = 1_000;
/** Refills: days before today, the UTC hour, credits. */
const REFILLS: ReadonlyArray<{ ago: number; hour: number; credits: number }> = [
  { ago: 19, hour: 10.25, credits: 180_000 },
  { ago: 52, hour: 8.6, credits: 250_000 },
];

const OF_PAGES = ["mia-of", "mia-vip-of"] as const;

interface Sources {
  rest: number;
  webhookAccrual: number;
  external: number;
  adjustment: number;
}

function utcDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

function shiftUtcDay(day: string, days: number): string {
  return isoDay(new Date(utcDayStart(day) + days * DAY_MS));
}

function fractionOf(day: string, now: Date): number {
  const start = utcDayStart(day);
  if (now.getTime() >= start + DAY_MS) return 1;
  if (now.getTime() <= start) return 0;
  return (now.getTime() - start) / DAY_MS;
}

/** A whole UTC day's credit movement by source (refills apart). */
function fullDaySources(day: string): Sources {
  const random = rng(`ofapi-day:${day}`);
  if (day >= OFF_DAY) {
    return { rest: intBetween(random, 6, 10), webhookAccrual: 0, external: 0, adjustment: 0 };
  }
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const weekend = weekday === 0 || weekday === 6 ? 1.15 : 1;
  const rest = Math.round(1_650 * weekend * between(random, 0.8, 1.22));
  return {
    rest,
    webhookAccrual: Math.round(rest * between(random, 0.26, 0.34)),
    external: random() < 0.35 ? intBetween(random, -30, 140) : 0,
    adjustment: random() < 0.07 ? -intBetween(random, 15, 70) : 0,
  };
}

function daySources(day: string, now: Date): Sources {
  const fraction = fractionOf(day, now);
  const full = fullDaySources(day);
  if (fraction >= 1) return full;
  // The accrual of a day is posted after it ends; the rest so far.
  return {
    rest: Math.round(full.rest * fraction),
    webhookAccrual: 0,
    external: Math.round(full.external * fraction),
    adjustment: 0,
  };
}

function total(sources: Sources): number {
  return sources.rest + sources.webhookAccrual + sources.external + sources.adjustment;
}

// --- Requests by operation ---------------------------------------------------

/** Share of a day's REST credits per operation, and credits per request. */
const OPERATION_MIX: ReadonlyArray<{ operation: string; share: number; perRequest: number; page: boolean }> = [
  { operation: "ofapi_chat_messages", share: 0.24, perRequest: 2, page: true },
  { operation: "ofapi_chats", share: 0.11, perRequest: 2, page: true },
  { operation: "ofapi_transactions", share: 0.1, perRequest: 2, page: true },
  { operation: "ofapi_gateway_chat_messages", share: 0.1, perRequest: 2, page: true },
  { operation: "ofapi_fans_active", share: 0.09, perRequest: 3, page: true },
  { operation: "ofapi_audience_sweep", share: 0.08, perRequest: 3, page: true },
  { operation: "ofapi_gateway_chats", share: 0.05, perRequest: 2, page: true },
  { operation: "ofapi_fans_expired", share: 0.05, perRequest: 3, page: true },
  { operation: "ofapi_command_send_text", share: 0.04, perRequest: 1, page: true },
  { operation: "ofapi_gateway_user", share: 0.03, perRequest: 1, page: true },
  { operation: "ofapi_command_send_media", share: 0.02, perRequest: 2, page: true },
  { operation: "ofapi_gateway_vault_media", share: 0.02, perRequest: 2, page: true },
  { operation: "ofapi_sync_events", share: 0.02, perRequest: 1, page: false },
  { operation: "ofapi_command_mark_chat_read", share: 0.01, perRequest: 1, page: true },
  { operation: "ofapi_balance_ping", share: 0.003, perRequest: 1, page: false },
  { operation: "ofapi_admin_accounts", share: 0.002, perRequest: 1, page: false },
];

function operationsOf(day: string, rest: number): Array<{ operation: string; credits: number; perRequest: number; page: boolean }> {
  if (rest <= 0) return [];
  if (day >= OFF_DAY) {
    const pings = Math.min(rest, 4);
    return [
      { operation: "ofapi_balance_ping", credits: pings, perRequest: 1, page: false },
      { operation: "ofapi_admin_accounts", credits: rest - pings, perRequest: 1, page: false },
    ].filter((item) => item.credits > 0);
  }
  const items = OPERATION_MIX.map((mix) => ({ operation: mix.operation, credits: Math.floor(rest * mix.share), perRequest: mix.perRequest, page: mix.page }));
  const placed = items.reduce((sum, item) => sum + item.credits, 0);
  items[0]!.credits += rest - placed;
  return items.filter((item) => item.credits > 0);
}

function pageOfRequest(seed: string): (typeof OF_PAGES)[number] {
  return hashString(seed) % 100 < 58 ? "mia-of" : "mia-vip-of";
}

// --- Summary (adminOfapiCreditsSummary) ---------------------------------------

export function adminOfapiCreditsSummary(request: DemoRequest): KernelOperationResponse<"adminOfapiCreditsSummary"> {
  const now = request.now;
  const today = isoDay(now);
  const todaySources = daySources(today, now);
  const lastWeek = Array.from({ length: 7 }, (_, index) => total(fullDaySources(shiftUtcDay(today, -1 - index))));
  const avg = lastWeek.reduce((sum, value) => sum + value, 0) / 7;
  const daysLeft = avg > 0 ? Math.floor(BALANCE_NOW / avg) : null;
  const monthStart = `${today.slice(0, 8)}01`;
  let monthToDate = 0;
  for (let day = monthStart; day <= today; day = shiftUtcDay(day, 1)) monthToDate += total(daySources(day, now));
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  const daysRemaining = Math.max(0, Math.round((monthEnd.getTime() - utcDayStart(today)) / DAY_MS));
  const todayTotal = total(todaySources);
  const dmShare = Math.round(todaySources.rest * 0.55);
  return {
    enabled: true,
    balance: { value: BALANCE_NOW, observedAt: iso(new Date(now.getTime() - 7 * 60_000)) },
    today: {
      day: today,
      total: todayTotal,
      bySource: { rest: todaySources.rest, webhookAccrual: todaySources.webhookAccrual, external: todaySources.external, adjustment: todaySources.adjustment },
    },
    budgets: [
      { stream: "all", spentToday: todayTotal, dailyCeiling: 6_000, state: "ok", retryAt: null },
      { stream: "dm", spentToday: dmShare, dailyCeiling: 3_500, state: "ok", retryAt: null },
      { stream: "audience", spentToday: Math.round(todaySources.rest * 0.15), dailyCeiling: 1_200, state: "ok", retryAt: null },
    ],
    floor: { value: FLOOR, blocked: false },
    forecast: {
      basis: "recorded_activity",
      monthUnverifiedResidualCredits: 0,
      avgDailySpend7d: Math.round(avg * 10) / 10,
      daysLeft,
      runOutDate: daysLeft === null ? null : shiftUtcDay(today, daysLeft),
      monthToDateSpend: monthToDate,
      monthEndProjection: Math.round(monthToDate + avg * daysRemaining),
      refillRecommendation: { targetDays: 30, credits: Math.max(0, Math.round(FLOOR + avg * 30 - BALANCE_NOW)) },
    },
    incidents: [
      {
        kind: "ofapi_webhook_silence",
        openedAt: `${OFF_DAY}T06:12:00.000Z`,
        errorSummary: "No OnlyFans webhook events for 6 h (last at 2026-11-01 00:07 UTC)",
      },
    ],
    reconciliation: { lastRunAt: iso(new Date(now.getTime() - 38 * 60_000)), lastDriftCredits: 0 },
    accrual: {
      lastPostedDay: shiftUtcDay(OFF_DAY, -1),
      pendingToday: { day: today, eventCount: 0, estimatedCredits: 0 },
    },
    recentBurn: {
      windowMinutes: 60,
      total: 1,
      threshold: 1_500,
      alerting: false,
      topOperations: [{ operation: "ofapi_balance_ping", requests: 1, credits: 1 }],
      topPages: [],
    },
    pricing: { microUsdPerCredit: MICRO_USD_PER_CREDIT },
  };
}

// --- Balance over time ---------------------------------------------------------

/** The balance at the end of each of the UTC days asked, walking back from now. */
function balanceByDay(days: readonly string[], now: Date): Map<string, number> {
  const today = isoDay(now);
  const result = new Map<string, number>();
  let balance = BALANCE_NOW;
  // `balance` is the balance at the end of `day` (now for today).
  for (let day = today; day >= days[0]!; day = shiftUtcDay(day, -1)) {
    result.set(day, balance);
    balance += total(daySources(day, now));
    for (const refill of REFILLS) {
      if (shiftUtcDay(today, -refill.ago) === day) balance -= refill.credits;
    }
  }
  return result;
}

export function adminOfapiCreditsDaily(request: DemoRequest): KernelOperationResponse<"adminOfapiCreditsDaily"> {
  const now = request.now;
  const count = Math.min(90, Math.max(1, Math.round(queryNumber(request, "days", 30))));
  const today = isoDay(now);
  const days = Array.from({ length: count }, (_, index) => shiftUtcDay(today, index - count + 1));
  const balances = balanceByDay(days, now);
  const operations = new Map<string, { requests: number; credits: number }>();
  const pageCredits = new Map<string, number>();
  for (const day of days) {
    for (const item of operationsOf(day, daySources(day, now).rest)) {
      const entry = operations.get(item.operation) ?? { requests: 0, credits: 0 };
      entry.credits += item.credits;
      entry.requests += Math.round(item.credits / item.perRequest);
      operations.set(item.operation, entry);
      if (item.page) {
        pageCredits.set("mia-of", (pageCredits.get("mia-of") ?? 0) + Math.round(item.credits * 0.58));
        pageCredits.set("mia-vip-of", (pageCredits.get("mia-vip-of") ?? 0) + Math.round(item.credits * 0.42));
      }
    }
  }
  return {
    days: days.map((day) => {
      const sources = daySources(day, now);
      return { day, total: total(sources), bySource: { ...sources } };
    }),
    balance: days.map((day) => ({
      at: day === today ? iso(new Date(now.getTime() - 7 * 60_000)) : `${day}T23:55:00.000Z`,
      value: balances.get(day) ?? BALANCE_NOW,
    })),
    refills: REFILLS
      .filter((refill) => refill.ago < count)
      .map((refill) => ({
        at: iso(new Date(utcDayStart(shiftUtcDay(today, -refill.ago)) + refill.hour * HOUR_MS)),
        credits: -refill.credits,
      })),
    byOperation: [...operations.entries()]
      .map(([operation, entry]) => ({ operation, requests: entry.requests, credits: entry.credits }))
      .sort((left, right) => right.credits - left.credits),
    byPage: OF_PAGES.map((label) => ({
      pageId: demoPage(label)!.id,
      pageLabel: label,
      credits: pageCredits.get(label) ?? 0,
      revenueMills: mills(demoDailyNet(label, now, count).reduce((sum, item) => sum + item.net, 0)),
    })),
  };
}

// --- The ledger (adminOfapiCreditsLedger) --------------------------------------

type LedgerRow = KernelOperationResponse<"adminOfapiCreditsLedger">["rows"][number];
type LedgerSource = LedgerRow["source"];

const LEDGER_DAYS = 32;
const ledgerCache = new Map<string, LedgerRow[]>();

function requestId(seed: string): string {
  return `req_${hashString(seed).toString(16).padStart(8, "0")}${hashString(`${seed}#`).toString(16).padStart(8, "0")}`;
}

/** Every ledger row of the last LEDGER_DAYS UTC days, newest first. */
function ledgerRows(now: Date): LedgerRow[] {
  const cacheKey = `${isoDay(now)}:${Math.floor(now.getTime() / (10 * 60_000))}`;
  const cached = ledgerCache.get(cacheKey);
  if (cached) return cached;
  ledgerCache.clear();
  const today = isoDay(now);
  const rows: Array<Omit<LedgerRow, "id" | "balanceAfter">> = [];
  for (let ago = LEDGER_DAYS - 1; ago >= 0; ago -= 1) {
    const day = shiftUtcDay(today, -ago);
    const start = utcDayStart(day);
    const end = Math.min(start + DAY_MS, now.getTime());
    const sources = daySources(day, now);
    const random = rng(`ledger:${day}`);
    for (const item of operationsOf(day, sources.rest)) {
      const requests = Math.max(1, Math.round(item.credits / item.perRequest));
      let left = item.credits;
      for (let index = 0; index < requests; index += 1) {
        const credits = index === requests - 1 ? left : Math.min(left, item.perRequest);
        left -= credits;
        if (credits <= 0) continue;
        const seed = `${day}:${item.operation}:${index}`;
        const page = item.page ? pageOfRequest(seed) : null;
        const notFound = item.operation === "ofapi_gateway_user" && hashString(seed) % 40 === 0;
        rows.push({
          occurredAt: iso(new Date(start + ((index + random()) / requests) * (end - start))),
          source: "rest",
          operation: item.operation,
          pageId: page ? demoPage(page)!.id : null,
          pageLabel: page,
          httpStatus: notFound ? 404 : 200,
          credits,
          estimated: false,
          requestId: requestId(seed),
          accrualDay: null,
        });
      }
    }
    if (sources.external !== 0) {
      rows.push({
        occurredAt: iso(new Date(start + between(random, 0.3, 0.9) * (end - start))),
        source: "external",
        operation: null,
        pageId: null,
        pageLabel: null,
        httpStatus: null,
        credits: sources.external,
        estimated: false,
        requestId: null,
        accrualDay: null,
      });
    }
    if (sources.adjustment !== 0) {
      rows.push({
        occurredAt: iso(new Date(start + between(random, 0.4, 0.8) * (end - start))),
        source: "adjustment",
        operation: null,
        pageId: null,
        pageLabel: null,
        httpStatus: null,
        credits: sources.adjustment,
        estimated: false,
        requestId: null,
        accrualDay: null,
      });
    }
    // A day's webhook accrual is posted just after the day ends.
    if (sources.webhookAccrual > 0 && start + DAY_MS + 5 * 60_000 <= now.getTime()) {
      rows.push({
        occurredAt: iso(new Date(start + DAY_MS + 5 * 60_000)),
        source: "webhook_accrual",
        operation: null,
        pageId: null,
        pageLabel: null,
        httpStatus: null,
        credits: sources.webhookAccrual,
        estimated: true,
        requestId: null,
        accrualDay: day,
      });
    }
    for (const refill of REFILLS) {
      if (refill.ago !== ago) continue;
      rows.push({
        occurredAt: iso(new Date(start + refill.hour * HOUR_MS)),
        source: "refill",
        operation: null,
        pageId: null,
        pageLabel: null,
        httpStatus: null,
        credits: -refill.credits,
        estimated: false,
        requestId: null,
        accrualDay: null,
      });
    }
  }
  rows.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
  // Ids grow with time; the balance after each row is walked back from the balance now.
  const numbered = rows.map((row, index) => ({ ...row, id: 4_812_000 + index }));
  const result: LedgerRow[] = [];
  let balance = BALANCE_NOW;
  for (let index = numbered.length - 1; index >= 0; index -= 1) {
    const row = numbered[index]!;
    result.push({ ...row, balanceAfter: row.source === "rest" && row.operation !== "ofapi_balance_ping" ? null : balance });
    balance += row.credits;
  }
  ledgerCache.set(cacheKey, result);
  return result;
}

export function adminOfapiCreditsLedger(request: DemoRequest): KernelOperationResponse<"adminOfapiCreditsLedger"> | DemoReply {
  const offset = Math.max(0, Math.round(queryNumber(request, "offset", 0)));
  const limit = Math.min(200, Math.max(1, Math.round(queryNumber(request, "limit", 50))));
  const source = queryString(request, "source") as LedgerSource | undefined;
  const sources: readonly string[] = ["rest", "webhook_accrual", "external", "refill", "adjustment"];
  if (source !== undefined && !sources.includes(source)) {
    return demoError(400, "bad_request", "querystring/source must be equal to one of the allowed values");
  }
  const pageId = queryString(request, "pageId");
  const operation = queryString(request, "operation");
  const from = queryString(request, "from");
  const to = queryString(request, "to");
  const fromMs = from ? Date.parse(from) : null;
  const toMs = to ? Date.parse(to) : null;
  const rows = ledgerRows(request.now).filter((row) =>
    (source === undefined || row.source === source)
    && (pageId === undefined || String(row.pageId) === pageId)
    && (operation === undefined || row.operation === operation)
    && (fromMs === null || Date.parse(row.occurredAt) >= fromMs)
    && (toMs === null || Date.parse(row.occurredAt) < toMs));
  return {
    total: rows.length,
    pageOptions: OF_PAGES.map((label) => ({ pageId: demoPage(label)!.id, pageLabel: label })),
    rows: rows.slice(offset, offset + limit),
  };
}

// --- Projection accuracy (adminOfapiSpendComparison) ------------------------------

type Comparison = KernelOperationResponse<"adminOfapiSpendComparison">;
type ComparisonStatus = Comparison["summary"][number]["status"];

const EVENT_OF: Readonly<Record<string, string>> = {
  matched: "messages.ppv.unlocked",
  ppv_estimated: "messages.ppv.unlocked",
  tips_signal: "tips.received",
  amount_mismatch: "messages.ppv.unlocked",
  missing_in_core_truth: "subscriptions.renewed",
};

export function adminOfapiSpendComparison(request: DemoRequest): Comparison {
  const now = request.now;
  const days = Math.min(30, Math.max(1, Math.round(queryNumber(request, "days", 7))));
  const sampleLimit = Math.min(100, Math.max(1, Math.round(queryNumber(request, "sampleLimit", 25))));
  const from = new Date(now.getTime() - days * DAY_MS);
  // Only the days before the vendor stopped carry webhook events.
  const activeDays = Array.from({ length: days }, (_, index) => isoDay(new Date(from.getTime() + (index + 1) * DAY_MS)))
    .filter((day) => day < OFF_DAY);
  const counts: Array<{ status: ComparisonStatus; perDay: number }> = [
    { status: "matched", perDay: 37 },
    { status: "ppv_estimated", perDay: 1.8 },
    { status: "tips_signal", perDay: 0.7 },
    { status: "amount_mismatch", perDay: 0.25 },
    { status: "missing_in_core_truth", perDay: 0.12 },
  ];
  const byPage: Comparison["byPage"] = [];
  const summary = new Map<ComparisonStatus, Comparison["summary"][number]>();
  for (const label of OF_PAGES) {
    const page = demoPage(label)!;
    const pageShare = label === "mia-of" ? 0.55 : 0.45;
    const net = demoDailyNet(label, now, days + 1)
      .filter((item) => activeDays.includes(item.day))
      .reduce((sum, item) => sum + item.net, 0);
    for (const { status, perDay } of counts) {
      const count = Math.round(perDay * activeDays.length * pageShare * 2);
      if (count === 0) continue;
      const share = status === "matched" ? 0.9 : status === "ppv_estimated" ? 0.05 : 0.012;
      const creatorNet = mills(net * share);
      const coreNet = status === "missing_in_core_truth" ? 0 : status === "amount_mismatch" ? Math.round(creatorNet * 0.82) : status === "ppv_estimated" ? Math.round(creatorNet * 0.96) : creatorNet;
      const row = {
        status,
        count,
        grossAmountMills: Math.round(creatorNet / 0.8),
        creatorNetAmountMills: creatorNet,
        coreGrossAmountMills: Math.round(coreNet / 0.8),
        coreCreatorNetAmountMills: coreNet,
      };
      byPage.push({ ...row, pageId: page.id, pageLabel: label });
      const sum = summary.get(status) ?? { status, count: 0, grossAmountMills: 0, creatorNetAmountMills: 0, coreGrossAmountMills: 0, coreCreatorNetAmountMills: 0 };
      sum.count += row.count;
      sum.grossAmountMills += row.grossAmountMills;
      sum.creatorNetAmountMills += row.creatorNetAmountMills;
      sum.coreGrossAmountMills += row.coreGrossAmountMills;
      sum.coreCreatorNetAmountMills += row.coreCreatorNetAmountMills;
      summary.set(status, sum);
    }
  }

  const samples: Comparison["samples"] = [];
  const order: ComparisonStatus[] = ["amount_mismatch", "missing_in_core_truth", "ppv_estimated", "tips_signal", "matched"];
  let index = 0;
  for (const status of order) {
    const available = summary.get(status)?.count ?? 0;
    const take = Math.min(available, status === "matched" ? sampleLimit : 4);
    for (let sample = 0; sample < take && samples.length < sampleLimit; sample += 1) {
      const random = rng(`cmp:${status}:${sample}`);
      const label = sample % 2 === 0 ? "mia-of" : "mia-vip-of";
      const page = demoPage(label)!;
      const fans = demoFans(label).filter((fan) => fan.totalSpent > 0);
      const fan = fans[intBetween(random, 0, Math.min(40, fans.length - 1))]!;
      const day = activeDays[intBetween(random, 0, Math.max(0, activeDays.length - 1))] ?? isoDay(from);
      const occurredAt = new Date(utcDayStart(day) + between(random, 0.05, 0.95) * DAY_MS);
      const price = status === "tips_signal" ? pickTip(random) : pickPpv(random);
      const net = mills(price * 0.8);
      const coreNet = status === "missing_in_core_truth" ? null : status === "amount_mismatch" ? mills(pickPpv(random) * 0.8) : status === "ppv_estimated" ? mills(price * 0.8 * 0.96) : net;
      const transactionId = String(1_900_000_000 + (hashString(`tx:${status}:${sample}`) % 90_000_000));
      index += 1;
      samples.push({
        projectionId: 2_118_400 + index * 7,
        comparisonStatus: status,
        sourceEventType: EVENT_OF[status] ?? "messages.ppv.unlocked",
        projectionStatus: "projected",
        eventStatus: "processed",
        blockedReason: null,
        journalId: 98_441_000 + index * 13,
        pageId: page.id,
        pageLabel: label,
        fanPlatformUserId: fan.platformUserId,
        transactionId: status === "tips_signal" ? null : transactionId,
        messageId: status === "tips_signal" || status === "missing_in_core_truth" ? null : String(4_100_000_000_000 + (hashString(`msg:${status}:${sample}`) % 900_000_000)),
        occurredAt: iso(occurredAt),
        grossAmountMills: mills(price),
        creatorNetAmountMills: net,
        coreTransactionPk: coreNet === null ? null : 7_300_000 + index * 3,
        corePageId: coreNet === null ? null : page.id,
        coreFanPlatformUserId: coreNet === null ? null : fan.platformUserId,
        coreTransactionState: coreNet === null ? null : "completed",
        coreOccurredAt: coreNet === null ? null : iso(new Date(occurredAt.getTime() + intBetween(random, 40, 900) * 1000)),
        coreGrossAmountMills: coreNet === null ? null : Math.round(coreNet / 0.8),
        coreCreatorNetAmountMills: coreNet,
      });
    }
  }

  return {
    generatedAt: iso(now),
    window: { from: iso(from), to: iso(now), days },
    summary: [...summary.values()].sort((left, right) => right.count - left.count),
    byPage,
    samples,
    limitations: [
      "OnlyFans collection through the vendor stopped on 2026-11-01: later days carry no webhook events to project.",
      "A PPV unlock is projected at the message price until its transaction is synced; tips arrive as a signal without a transaction id.",
    ],
  };
}

function pickPpv(random: () => number): number {
  const prices = [9.99, 12, 14.99, 15, 19.99, 25, 29.99, 35, 49.99];
  return prices[Math.floor(random() * prices.length)]!;
}

function pickTip(random: () => number): number {
  const tips = [5, 10, 10, 15, 20, 25, 50];
  return tips[Math.floor(random() * tips.length)]!;
}

// --- The key's declared scope (ofapiKeyScopeGet) -------------------------------------

export function ofapiKeyScopeGet(request: DemoRequest): KernelOperationResponse<"ofapiKeyScopeGet"> {
  return {
    credentialFingerprint: "9c4e1b7a2d8f3065e1a4b9c7d2f80e36a5b1c9d4e7f2083a6b5c1d9e4f7a2b30",
    version: 3,
    capabilities: ["reads", "webhooks", "exports", "commands"],
    accountIds: ["acct_7Hq2mLx9", "acct_Rv41kPz0"],
    visibility: "declared_restricted",
    observedTeam: "Northlight Media",
    preflightStatus: "verified",
    updatedAt: iso(new Date(request.now.getTime() - 9 * DAY_MS - 5 * HOUR_MS)),
    source: "owner_declaration_not_vendor_introspection",
  };
}
