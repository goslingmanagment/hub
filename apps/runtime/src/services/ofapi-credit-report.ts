// Read models for the owner-only /ofapi-credits dashboard page (Phase 2 of
// docs/ofapi-parity-plan.md, D7): summary cards + ops strip, daily series for
// the two charts plus the breakdown tables, and the filtered ledger listing.
// Everything is derived from ofapi_credit_ledger / ofapi_credit_state and the
// notification incidents — no OFAPI requests are made here.

import type {
  AdminOfapiCreditsLedgerQuery,
  OfapiCreditsDailyResponse,
  OfapiCreditsLedgerResponse,
  OfapiCreditsSummaryResponse,
} from "@agency_hub_core/contracts";
import {
  getLastOfapiWebhookAccrualDay,
  getOfapiCreditReconcileState,
  getOfapiCreditState,
  listNotificationIncidents,
  listOfapiBalanceSeriesBetween,
  listOfapiCreditLedgerEntries,
  listOfapiDailySpendBySource,
  listOfapiOperationBreakdownBetween,
  listOfapiPageBreakdownBetween,
  listOfapiRefillsBetween,
  sumOfapiCreditsSpentSince,
  sumOfapiRestCreditsForOperationsBetween,
  sumOfapiSpendBySourceBetween,
  type OfapiCreditLedgerSource,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { BadRequestError } from "./errors.ts";
import { isOfapiCreditLedgerEnabled } from "./ofapi-credits.ts";

const DEFAULT_DM_DAILY_CREDIT_BUDGET = 500;
const DEFAULT_CREDIT_FLOOR = 500;

// Ledger operations attributed to the DM bootstrap/reconcile stream (decision #49).
const DM_STREAM_OPERATIONS = ["ofapi_chats", "ofapi_chat_messages"] as const;

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

export async function getOfapiCreditsSummary(
  app: AppContext,
  now = new Date(),
): Promise<OfapiCreditsSummaryResponse> {
  const enabled = isOfapiCreditLedgerEnabled(app.config);
  const dayStart = utcDayStart(now);
  const nextDayStart = addUtcDays(dayStart, 1);

  const [credit, reconcile, lastAccrualDay, todaySpend, dmSpentToday, spend7d, openIncidents] =
    await Promise.all([
      getOfapiCreditState(app.db, now),
      getOfapiCreditReconcileState(app.db),
      getLastOfapiWebhookAccrualDay(app.db),
      sumOfapiSpendBySourceBetween(app.db, { from: dayStart, to: nextDayStart }),
      sumOfapiRestCreditsForOperationsBetween(app.db, {
        operations: DM_STREAM_OPERATIONS,
        from: dayStart,
        to: nextDayStart,
      }),
      sumOfapiCreditsSpentSince(app.db, {
        since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      }),
      listNotificationIncidents(app.db, { status: "open" }),
    ]);

  const bySource = toSpendBySource(todaySpend);
  const creditFloor = Math.max(0, app.config.ofapiCreditFloor ?? DEFAULT_CREDIT_FLOOR);
  const floorBlocked = creditFloor > 0 &&
    credit.lastBalance !== null &&
    credit.lastBalance < creditFloor;

  // Budget state mirrors the executor guard exactly: the ceiling is compared
  // against the GLOBAL day counter (that is what parks the stream), while the
  // displayed per-stream spend is ledger-attributed when available.
  const resolveBudget = (input: { stream: string; spentToday: number; ceiling: number }) => {
    const state = floorBlocked
      ? "floor_blocked" as const
      : credit.spentToday >= input.ceiling
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
    }),
  ];

  const avgDailySpend7d = Math.round((Math.max(0, spend7d) / 7) * 10) / 10;
  const daysLeft = credit.lastBalance !== null && avgDailySpend7d > 0
    ? Math.floor(credit.lastBalance / avgDailySpend7d)
    : null;

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
    accrual: { lastPostedDay: lastAccrualDay },
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
    byPage,
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
