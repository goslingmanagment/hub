// Read models for the owner-only /ofapi-credits dashboard page (Phase 2 of
// docs/ofapi-parity-plan.md, D7): summary cards + ops strip, daily series for
// the two charts plus the breakdown tables, and the filtered ledger listing.
// Everything is derived from ofapi_credit_ledger / ofapi_credit_state and the
// notification incidents — no OFAPI requests are made here.

import type {
  AdminOfapiCreditsLedgerCsvQuery,
  AdminOfapiCreditsLedgerQuery,
  OfapiCreditsChatterSummaryResponse,
  OfapiCreditsDailyResponse,
  OfapiCreditsLedgerResponse,
  OfapiCreditsSummaryResponse,
} from "@agency_hub_core/contracts";
import {
  countOfapiWebhookEventsReceivedBetween,
  getLastOfapiWebhookAccrualDay,
  getOfapiCreditReconcileState,
  getOfapiCreditState,
  getRevenuePageTotalsForExactPeriod,
  listNotificationIncidents,
  listOfapiBalanceSeriesBetween,
  listOfapiCreditLedgerEntries,
  listOfapiDailySpendBySource,
  listOfapiOperationBreakdownBetween,
  listOfapiPageBreakdownBetween,
  listOfapiRefillsBetween,
  summarizeOfapiSpendWindowSince,
  sumOfapiRestCreditsForPagesBetween,
  sumOfapiRestCreditsForOperationsBetween,
  sumOfapiSpendBySourceBetween,
  type OfapiCreditLedgerSource,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError } from "./errors.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import {
  DEFAULT_BURN_ALERT_CREDITS_PER_HOUR,
  isOfapiCreditLedgerEnabled,
  webhookAccrualCredits,
} from "./ofapi-credits.ts";
import { isOfapiCreditFloorBlocking } from "./sync/ofapi-dm-sync.ts";

const DEFAULT_DM_DAILY_CREDIT_BUDGET = 500;
const DEFAULT_AUDIENCE_DAILY_CREDIT_BUDGET = 300;
const DEFAULT_CREDIT_FLOOR = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Trailing window (days) the runway forecast averages spend over.
const RUNWAY_WINDOW_DAYS = 7;
// Target runway (days above the floor) the refill recommendation sizes for.
const REFILL_TARGET_DAYS = 30;
// Trailing window (minutes) for the recent-burn drivers view; mirrors the
// ofapi_burn_rate monitor's 60-minute window.
const BURN_WINDOW_MINUTES = 60;
const BURN_TOP_N = 5;

// Ledger operations attributed to the DM bootstrap/reconcile stream (decision #49)
// and to the audience sweep (parity Phase 3).
const DM_STREAM_OPERATIONS = ["ofapi_chats", "ofapi_chat_messages"] as const;
const AUDIENCE_STREAM_OPERATIONS = ["ofapi_fans_active"] as const;

function utcDayStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(dayStart: Date, days: number) {
  return new Date(dayStart.getTime() + days * 24 * 60 * 60 * 1000);
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

type SpendBySource = OfapiCreditsSummaryResponse["today"]["bySource"];

function toSpendBySource(map: Map<OfapiCreditLedgerSource, number>): SpendBySource {
  return {
    rest: map.get("rest") ?? 0,
    webhookAccrual: map.get("webhook_accrual") ?? 0,
    external: map.get("external") ?? 0,
    adjustment: map.get("adjustment") ?? 0,
  };
}

function spendTotal(bySource: SpendBySource) {
  return bySource.rest + bySource.webhookAccrual + bySource.external + bySource.adjustment;
}

/**
 * Estimate the credit runway (A2). Average daily spend is the trailing-window net
 * spend divided by the number of days actually OBSERVED — the span from the first
 * spend row in the window to `now`, floored at 1 day and capped at the window —
 * not a hard-coded 7. On a young or idle-then-active ledger this stops a few days
 * of spend from being divided by 7, which would understate the burn rate and
 * overstate the days-left runway right after launch.
 */
export function estimateOfapiRunway(input: {
  lastBalance: number | null;
  spendInWindow: number;
  earliestSpendAt: Date | null;
  now: Date;
  windowDays?: number;
}): { avgDailySpend: number; daysLeft: number | null } {
  const windowDays = input.windowDays ?? RUNWAY_WINDOW_DAYS;
  const observedDays = input.earliestSpendAt
    ? Math.min(
      windowDays,
      Math.max(1, (input.now.getTime() - input.earliestSpendAt.getTime()) / MS_PER_DAY),
    )
    : windowDays;
  const avgDailySpend = Math.round((Math.max(0, input.spendInWindow) / observedDays) * 10) / 10;
  const daysLeft = input.lastBalance !== null && avgDailySpend > 0
    ? Math.floor(input.lastBalance / avgDailySpend)
    : null;
  return { avgDailySpend, daysLeft };
}

async function getChatterSpendWindow(
  app: AppContext,
  input: {
    pageIds: number[];
    from: Date;
    to: Date;
    enabled: boolean;
  },
): Promise<Omit<OfapiCreditsChatterSummaryResponse["today"], "day">> {
  const [restCredits, webhookEventCount] = await Promise.all([
    input.enabled
      ? sumOfapiRestCreditsForPagesBetween(app.db, {
        pageIds: input.pageIds,
        from: input.from,
        to: input.to,
      })
      : Promise.resolve(0),
    input.enabled
      ? countOfapiWebhookEventsReceivedBetween(app.db, {
        pageIds: input.pageIds,
        from: input.from,
        to: input.to,
      })
      : Promise.resolve(0),
  ]);
  const estimatedWebhookCredits = webhookAccrualCredits(webhookEventCount);

  return {
    from: input.from.toISOString(),
    to: input.to.toISOString(),
    restCredits,
    webhook: {
      eventCount: webhookEventCount,
      estimatedCredits: estimatedWebhookCredits,
    },
    totalEstimatedCredits: restCredits + estimatedWebhookCredits,
  };
}

export async function getChatterOfapiCreditsSummary(
  app: AppContext,
  input: { pageIds: number[] },
  now = new Date(),
): Promise<OfapiCreditsChatterSummaryResponse> {
  const enabled = isOfapiCreditLedgerEnabled(app.config);
  const dayStart = utcDayStart(now);
  const nextDayStart = addUtcDays(dayStart, 1);
  const sevenDayStart = addUtcDays(nextDayStart, -7);

  const [todayWindow, last7dWindow] = await Promise.all([
    getChatterSpendWindow(app, {
      pageIds: input.pageIds,
      from: dayStart,
      to: nextDayStart,
      enabled,
    }),
    getChatterSpendWindow(app, {
      pageIds: input.pageIds,
      from: sevenDayStart,
      to: nextDayStart,
      enabled,
    }),
  ]);

  return {
    enabled,
    scope: {
      pageIds: input.pageIds,
      pageCount: input.pageIds.length,
    },
    today: {
      day: isoDay(dayStart),
      ...todayWindow,
    },
    last7d: last7dWindow,
    limitations: enabled
      ? [
        "webhook credits are estimated from assigned-page journal events",
        "REST credits include only ledger rows attributed to assigned pages",
        "owner-only balance, refills, external drift, and adjustments are omitted",
      ]
      : ["ledger disabled; page-scoped credit summary unavailable"],
  };
}

export async function getOfapiCreditsSummary(
  app: AppContext,
  now = new Date(),
): Promise<OfapiCreditsSummaryResponse> {
  const enabled = isOfapiCreditLedgerEnabled(app.config);
  const dayStart = utcDayStart(now);
  const nextDayStart = addUtcDays(dayStart, 1);
  const spendWindowSince = new Date(now.getTime() - RUNWAY_WINDOW_DAYS * MS_PER_DAY);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const burnSince = new Date(now.getTime() - BURN_WINDOW_MINUTES * 60 * 1000);

  const [
    credit,
    reconcile,
    lastAccrualDay,
    todaySpend,
    dmSpentToday,
    audienceSpentToday,
    spendWindow,
    monthWindow,
    burnWindow,
    burnOps,
    burnPages,
    effective,
    openIncidents,
    pendingWebhookEventCount,
  ] = await Promise.all([
    getOfapiCreditState(app.db, now),
    getOfapiCreditReconcileState(app.db),
    getLastOfapiWebhookAccrualDay(app.db),
    sumOfapiSpendBySourceBetween(app.db, { from: dayStart, to: nextDayStart }),
    sumOfapiRestCreditsForOperationsBetween(app.db, {
      operations: DM_STREAM_OPERATIONS,
      from: dayStart,
      to: nextDayStart,
    }),
    sumOfapiRestCreditsForOperationsBetween(app.db, {
      operations: AUDIENCE_STREAM_OPERATIONS,
      from: dayStart,
      to: nextDayStart,
    }),
    // Net spend AND the earliest effective spend start share one query so the
    // runway numerator and denominator use the same window semantics.
    summarizeOfapiSpendWindowSince(app.db, { since: spendWindowSince }),
    // Month-to-date spend (D5) reuses the same refill-excluded/external-prorated
    // semantics as the runway numerator.
    summarizeOfapiSpendWindowSince(app.db, { since: monthStart }),
    // Trailing-hour burn (D3) mirrors the ofapi_burn_rate monitor exactly.
    summarizeOfapiSpendWindowSince(app.db, { since: burnSince }),
    listOfapiOperationBreakdownBetween(app.db, { from: burnSince, to: now }),
    listOfapiPageBreakdownBetween(app.db, { from: burnSince, to: now, limit: BURN_TOP_N }),
    // The burn threshold is live-editable, so read the effective override the
    // monitor uses rather than the boot config. Fall back to the boot config on a
    // read failure (like the monitor does) so an overrides hiccup can't 500 the
    // whole credits page over an informational threshold.
    enabled
      ? loadEffectiveConfig(app.db, app.config).catch(() => app.config)
      : Promise.resolve(null),
    listNotificationIncidents(app.db, { status: "open" }),
    enabled
      ? countOfapiWebhookEventsReceivedBetween(app.db, { from: dayStart, to: nextDayStart })
      : Promise.resolve(0),
  ]);

  const bySource = toSpendBySource(todaySpend);
  const creditFloor = Math.max(0, app.config.ofapiCreditFloor ?? DEFAULT_CREDIT_FLOOR);
  // Mirrors the guard (audit F7): a sub-floor balance whose observation has
  // gone stale no longer parks — the guard lets a probe through to refresh it.
  const floorBlocked = isOfapiCreditFloorBlocking({
    creditFloor,
    lastBalance: credit.lastBalance,
    lastBalanceAt: credit.lastBalanceAt,
    now,
  });

  // Budget state mirrors the executor guards exactly: the DM ceiling is
  // compared against the GLOBAL day counter (that is what parks the stream);
  // the audience ceiling uses its own reservation day counter when the ledger
  // is on (D6/F9), falling back to the global counter like the guard does.
  // The displayed per-stream spend is ledger-attributed when available.
  const resolveBudget = (input: {
    stream: string;
    spentToday: number;
    ceiling: number;
    guardSpentToday: number;
  }) => {
    const state = floorBlocked
      ? "floor_blocked" as const
      : input.guardSpentToday >= input.ceiling
        ? "budget_exhausted" as const
        : "ok" as const;
    return {
      stream: input.stream,
      spentToday: enabled ? input.spentToday : credit.spentToday,
      dailyCeiling: input.ceiling,
      state,
      retryAt: state === "budget_exhausted" ? nextDayStart.toISOString() : null,
    };
  };

  const budgets = [
    resolveBudget({
      stream: "dm",
      spentToday: dmSpentToday,
      ceiling: Math.max(1, app.config.ofapiDmDailyCreditBudget ?? DEFAULT_DM_DAILY_CREDIT_BUDGET),
      guardSpentToday: credit.spentToday,
    }),
    ...(app.config.ofapiAudienceSyncEnabled === true
      ? [resolveBudget({
        stream: "audience",
        spentToday: audienceSpentToday,
        ceiling: Math.max(
          1,
          app.config.ofapiAudienceDailyCreditBudget ?? DEFAULT_AUDIENCE_DAILY_CREDIT_BUDGET,
        ),
        guardSpentToday: enabled ? credit.audienceSpentToday : credit.spentToday,
      })]
      : []),
  ];

  const { avgDailySpend: avgDailySpend7d, daysLeft } = estimateOfapiRunway({
    lastBalance: credit.lastBalance,
    spendInWindow: spendWindow.total,
    earliestSpendAt: spendWindow.earliestEffectiveAt,
    now,
  });

  // D5: project the calendar-month total from month-to-date spend plus the daily
  // rate over the remaining UTC days (exclusive of today, already in MTD).
  const monthToDateSpend = Math.max(0, monthWindow.total);
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const remainingDaysInMonth = Math.max(
    0,
    Math.ceil((nextMonthStart.getTime() - nextDayStart.getTime()) / MS_PER_DAY),
  );
  const monthEndProjection = monthToDateSpend + Math.round(avgDailySpend7d * remainingDaysInMonth);
  // Credits to refill now to keep `REFILL_TARGET_DAYS` of runway above the floor.
  // Only meaningful once a balance has been observed.
  const refillRecommendation = credit.lastBalance === null
    ? null
    : {
      targetDays: REFILL_TARGET_DAYS,
      credits: Math.max(
        0,
        Math.round(creditFloor + avgDailySpend7d * REFILL_TARGET_DAYS - credit.lastBalance),
      ),
    };

  // D3: recent-burn drivers. `total` is all-source (matches the monitor); the
  // top-operation/top-page lists are REST-only (webhook/external have no operation
  // or page attribution).
  const burnThreshold = Math.max(
    0,
    effective?.ofapiBurnAlertCreditsPerHour ?? app.config.ofapiBurnAlertCreditsPerHour
      ?? DEFAULT_BURN_ALERT_CREDITS_PER_HOUR,
  );
  const recentBurn = {
    windowMinutes: BURN_WINDOW_MINUTES,
    total: burnWindow.total,
    threshold: burnThreshold,
    alerting: burnThreshold > 0 && burnWindow.total > burnThreshold,
    topOperations: burnOps.slice(0, BURN_TOP_N),
    topPages: burnPages,
  };

  return {
    enabled,
    balance: {
      value: credit.lastBalance,
      observedAt: credit.lastBalanceAt ? credit.lastBalanceAt.toISOString() : null,
    },
    today: {
      day: isoDay(dayStart),
      total: spendTotal(bySource),
      bySource,
    },
    budgets,
    floor: { value: creditFloor, blocked: floorBlocked },
    forecast: {
      avgDailySpend7d,
      daysLeft,
      runOutDate: daysLeft !== null
        ? isoDay(addUtcDays(dayStart, daysLeft))
        : null,
      monthToDateSpend,
      monthEndProjection,
      refillRecommendation,
    },
    incidents: openIncidents
      .filter((incident) => incident.kind.startsWith("ofapi_"))
      .map((incident) => ({
        kind: incident.kind,
        openedAt: new Date(incident.openedAt).toISOString(),
        errorSummary: incident.errorSummary,
      })),
    reconciliation: {
      lastRunAt: reconcile.lastReconcileAt ? reconcile.lastReconcileAt.toISOString() : null,
      lastDriftCredits: reconcile.lastDriftCredits,
    },
    accrual: {
      lastPostedDay: lastAccrualDay,
      pendingToday: enabled
        ? {
          day: isoDay(dayStart),
          eventCount: pendingWebhookEventCount,
          estimatedCredits: webhookAccrualCredits(pendingWebhookEventCount),
        }
        : null,
    },
    recentBurn,
    // Display-only flat credit price; 0 (unset) tells the dashboard to hide USD.
    pricing: {
      microUsdPerCredit: Math.max(0, Math.trunc(app.config.ofapiCreditMicroUsdPrice ?? 0)),
    },
  };
}

export async function getOfapiCreditsDaily(
  app: AppContext,
  input: { days: number },
  now = new Date(),
): Promise<OfapiCreditsDailyResponse> {
  const to = addUtcDays(utcDayStart(now), 1);
  const from = addUtcDays(to, -input.days);

  const [dailyRows, balance, refills, byOperation, byPage] = await Promise.all([
    listOfapiDailySpendBySource(app.db, { from, to }),
    listOfapiBalanceSeriesBetween(app.db, { from, to }),
    listOfapiRefillsBetween(app.db, { from, to }),
    listOfapiOperationBreakdownBetween(app.db, { from, to }),
    listOfapiPageBreakdownBetween(app.db, { from, to }),
  ]);

  // Net creator revenue for the same pages over the exact [from, to) UTC window,
  // so per-page credit cost can be shown against what the page actually earned.
  // `getRevenuePageTotalsForExactPeriod` windows on transactions.occurredAt — the
  // same raw-UTC boundary the credit ledger uses — so the two align 1:1.
  const revenueRows = byPage.length > 0
    ? await getRevenuePageTotalsForExactPeriod(app.db, {
      pageIds: byPage.map((row) => row.pageId),
      period: { from, to },
    })
    : [];
  const revenueMillsByPage = new Map(
    revenueRows.map((row) => [row.pageId, Number(row.netEarningsMills)]),
  );

  const dayMap = new Map<string, SpendBySource>();
  for (const row of dailyRows) {
    const bucket = dayMap.get(row.day) ?? { rest: 0, webhookAccrual: 0, external: 0, adjustment: 0 };
    if (row.source === "rest") {
      bucket.rest += row.credits;
    } else if (row.source === "webhook_accrual") {
      bucket.webhookAccrual += row.credits;
    } else if (row.source === "external") {
      bucket.external += row.credits;
    } else if (row.source === "adjustment") {
      bucket.adjustment += row.credits;
    }
    dayMap.set(row.day, bucket);
  }

  // Dense series: every day in the window gets a bucket so chart bars align.
  const days: OfapiCreditsDailyResponse["days"] = [];
  for (let dayStart = from; dayStart < to; dayStart = addUtcDays(dayStart, 1)) {
    const day = isoDay(dayStart);
    const bySource = dayMap.get(day) ?? { rest: 0, webhookAccrual: 0, external: 0, adjustment: 0 };
    days.push({ day, total: spendTotal(bySource), bySource });
  }

  return {
    days,
    balance: balance.map((point) => ({ at: point.at.toISOString(), value: point.value })),
    refills: refills.map((row) => ({ at: row.at.toISOString(), credits: row.credits })),
    byOperation,
    byPage: byPage.map((row) => ({
      ...row,
      revenueMills: revenueMillsByPage.get(row.pageId) ?? 0,
    })),
  };
}

function parseIsoDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestError(`Invalid ${field} timestamp`);
  }
  return parsed;
}

export async function getOfapiCreditsLedger(
  app: AppContext,
  query: AdminOfapiCreditsLedgerQuery,
): Promise<OfapiCreditsLedgerResponse> {
  const { total, rows } = await listOfapiCreditLedgerEntries(app.db, {
    offset: query.offset,
    limit: query.limit,
    source: query.source,
    pageId: query.pageId,
    operation: query.operation,
    from: parseIsoDate(query.from, "from"),
    to: parseIsoDate(query.to, "to"),
  });

  return {
    total,
    rows: rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurredAt.toISOString(),
      source: row.source,
      operation: row.operation,
      pageId: row.pageId,
      pageLabel: row.pageLabel,
      httpStatus: row.httpStatus,
      credits: row.credits,
      estimated: row.estimated,
      balanceAfter: row.balanceAfter,
      requestId: row.requestId,
      accrualDay: row.accrualDay,
    })),
  };
}

// A hard ceiling on a single export so a wide filter can't stream unbounded rows.
// Truncation is surfaced (route logs + a header) rather than silently dropped.
const OFAPI_LEDGER_CSV_MAX_ROWS = 50_000;

const OFAPI_LEDGER_CSV_HEADER = [
  "id",
  "occurred_at",
  "source",
  "operation",
  "page_id",
  "page_label",
  "http_status",
  "credits",
  "estimated",
  "balance_after",
  "request_id",
  "accrual_day",
].join(",");

// RFC 4180 escaping: wrap in quotes when the field holds a comma, quote, or
// newline, doubling any embedded quote.
function csvField(value: string | number | boolean | null): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function ledgerCsvFilename(query: AdminOfapiCreditsLedgerCsvQuery): string {
  const parts = ["ofapi-credit-ledger"];
  if (query.source) {
    parts.push(query.source);
  }
  if (query.pageId !== undefined) {
    parts.push(`page-${query.pageId}`);
  }
  if (query.from) {
    parts.push(`from-${query.from.slice(0, 10)}`);
  }
  if (query.to) {
    parts.push(`to-${query.to.slice(0, 10)}`);
  }
  // `from`/`to` are only shape-validated as strings (isoTimestamp === z.string()),
  // so a caller could smuggle a quote or CR/LF into a query value. This filename
  // lands in a Content-Disposition header written after reply.hijack(), where an
  // invalid character would throw with no way to emit a clean response — so hard
  // clamp to a filesystem/header-safe charset.
  return `${parts.join("_")}.csv`.replace(/[^A-Za-z0-9._-]/g, "_");
}

export async function getOfapiCreditsLedgerCsv(
  app: AppContext,
  query: AdminOfapiCreditsLedgerCsvQuery,
): Promise<{ filename: string; csv: string; rowCount: number; truncated: boolean }> {
  const { total, rows } = await listOfapiCreditLedgerEntries(app.db, {
    offset: 0,
    limit: OFAPI_LEDGER_CSV_MAX_ROWS,
    source: query.source,
    pageId: query.pageId,
    operation: query.operation,
    from: parseIsoDate(query.from, "from"),
    to: parseIsoDate(query.to, "to"),
  });

  const lines = [OFAPI_LEDGER_CSV_HEADER];
  for (const row of rows) {
    lines.push([
      csvField(row.id),
      csvField(row.occurredAt.toISOString()),
      csvField(row.source),
      csvField(row.operation),
      csvField(row.pageId),
      csvField(row.pageLabel),
      csvField(row.httpStatus),
      csvField(row.credits),
      csvField(row.estimated),
      csvField(row.balanceAfter),
      csvField(row.requestId),
      csvField(row.accrualDay),
    ].join(","));
  }

  return {
    filename: ledgerCsvFilename(query),
    csv: `${lines.join("\r\n")}\r\n`,
    rowCount: rows.length,
    truncated: total > rows.length,
  };
}
