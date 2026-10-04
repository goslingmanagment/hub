import {
  CLIENT_AI_USAGE_MAX_AGE_DAYS,
  type AdminChatterUsageQuery,
  type AdminChatterUsageResponse,
  type AiUsageBatchBody,
  type AiUsageBatchResponse,
  type AuthMyUsageResponse,
  type ClientAiUsageCoverageReason,
  type ClientAiUsageQuery,
  type ClientAiUsageRefusalReason,
  type ClientAiUsageResponse,
  type ClientAiUsageTotals,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  insertAiUsageEvents,
  listChatterUsageSummary,
  listUserPageDailyUsage,
  listUserUsageReport,
  type UserPageDailyUsageRow,
} from "@agency_hub_core/db";
import {
  MOSCOW_TIME_ZONE,
  businessDateToUtcStart,
  nextBusinessDate,
  previousBusinessDate,
  resolveBusinessDateRange,
  toBusinessDate,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { evaluateAiGatewayQuota, isChatMuseAiGatewayEnabled } from "./ai-gateway.ts";
import {
  requireApiKeyUser,
  requireSessionUser,
  type AuthPrincipal,
  type HumanAuthPrincipal,
} from "./auth.ts";
import { requireClientPage, type ClientFeatureRequest } from "./client-switches.ts";
import { BadRequestError } from "./errors.ts";

const COMPLETED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

// Null instead of throwing: one bad event must not reject the rest of the batch —
// chatter clients batch offline and a thrown 400 would make them re-send (and lose)
// the valid events alongside the poison one.
function parseCompletedAt(value: string, now: Date): Date | null {
  const completedAt = new Date(value);
  if (Number.isNaN(completedAt.getTime())) {
    return null;
  }

  if (completedAt.getTime() > now.getTime() + COMPLETED_AT_FUTURE_SKEW_MS) {
    return null;
  }

  return completedAt;
}

function resolveDefaultUsageRange(now: Date) {
  const range = resolveBusinessDateRange("7d", now, undefined, MOSCOW_TIME_ZONE);
  if (!range.from || !range.toExclusive) {
    throw new Error("Expected the default usage range to resolve to concrete dates");
  }

  return {
    from: range.from,
    to: previousBusinessDate(range.toExclusive),
  };
}

export function resolveRequestedUsageRange(query: AdminChatterUsageQuery, now: Date) {
  const hasFrom = Boolean(query.from);
  const hasTo = Boolean(query.to);
  if (hasFrom !== hasTo) {
    throw new BadRequestError("from and to must be provided together");
  }

  const requestedRange = query.from && query.to
    ? { from: query.from, to: query.to }
    : resolveDefaultUsageRange(now);

  if (requestedRange.from > requestedRange.to) {
    throw new BadRequestError("from must be on or before to");
  }

  return {
    from: requestedRange.from,
    to: requestedRange.to,
    timeZone: MOSCOW_TIME_ZONE,
    fromBound: businessDateToUtcStart(requestedRange.from, MOSCOW_TIME_ZONE),
    toExclusiveBound: businessDateToUtcStart(nextBusinessDate(requestedRange.to), MOSCOW_TIME_ZONE),
  };
}

export async function ingestAiUsageBatch(
  app: AppContext,
  principal: AuthPrincipal,
  body: AiUsageBatchBody,
): Promise<AiUsageBatchResponse> {
  requireApiKeyUser(principal);

  const now = new Date();
  const validEvents = [];
  let invalidCount = 0;
  for (const event of body.events) {
    const completedAt = parseCompletedAt(event.completedAt, now);
    if (!completedAt) {
      invalidCount += 1;
      continue;
    }

    validEvents.push({
      clientEventId: event.clientEventId,
      feature: event.feature,
      model: event.model,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheWriteTokens: event.cacheWriteTokens,
      cacheReadTokens: event.cacheReadTokens,
      conversationId: event.conversationId ?? null,
      durationMs: event.durationMs ?? null,
      isCacheHit: event.isCacheHit,
      isRegeneration: event.isRegeneration,
      completedAt,
    });
  }

  const insertedCount = validEvents.length > 0
    ? await insertAiUsageEvents(app.db, {
      userId: principal.user.id,
      events: validEvents,
    })
    : 0;

  if (invalidCount > 0) {
    app.logger.warn({
      userId: principal.user.id,
      receivedCount: body.events.length,
      invalidCount,
    }, "Skipped AI usage events with invalid completedAt");
  }

  return {
    receivedCount: body.events.length,
    insertedCount,
    invalidCount,
    dedupedCount: body.events.length - invalidCount - insertedCount,
  };
}

export async function getAdminChatterUsageReport(
  app: AppContext,
  query: AdminChatterUsageQuery,
): Promise<AdminChatterUsageResponse> {
  const now = new Date();
  const range = resolveRequestedUsageRange(query, now);
  const rows = await listChatterUsageSummary(app.db, {
    from: range.fromBound,
    toExclusive: range.toExclusiveBound,
  });

  return {
    range: {
      from: range.from,
      to: range.to,
      timeZone: range.timeZone,
    },
    rows,
  };
}

/**
 * Decision 349: the caller's OWN usage (any session, any human role) — the same
 * range semantics as the admin report, over a dedicated repository query that
 * carries no role filter (listChatterUsageSummary would leave a team_lead's or
 * owner's cabinet empty).
 */
export async function getOwnUsageReport(
  app: AppContext,
  principal: AuthPrincipal,
  query: AdminChatterUsageQuery,
): Promise<AuthMyUsageResponse> {
  requireSessionUser(principal);
  const now = new Date();
  const range = resolveRequestedUsageRange(query, now);
  const report = await listUserUsageReport(app.db, {
    userId: principal.user.id,
    from: range.fromBound,
    toExclusive: range.toExclusiveBound,
    timeZone: range.timeZone,
  });

  return {
    range: {
      from: range.from,
      to: range.to,
      timeZone: range.timeZone,
    },
    row: report.row,
    daily: report.daily,
  };
}

// ── chat-extension H-15: the caller's own AI spend on one page, by day ───────

/** How the refusals of this route name it (`client_feature_disabled`). */
const CLIENT_AI_USAGE_FEATURE = "ai-usage";

function refuseClientAiUsage(message: string, reason: ClientAiUsageRefusalReason): never {
  throw new BadRequestError(message, { reason });
}

/** A zone this runtime can cut calendar days in. */
function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** `count` consecutive calendar dates ending at `lastDate`, oldest first. */
function businessDatesEndingAt(lastDate: string, count: number): string[] {
  const dates = [lastDate];
  while (dates.length < count) {
    dates.unshift(previousBusinessDate(dates[0]!));
  }
  return dates;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The first instant of a calendar day in a zone: where the zone's date turns
 * to `day`.
 *
 * businessDateToUtcStart reads the zone's offset once, at the day's UTC
 * midnight. That is up to 14 hours from the zone's own midnight, so when the
 * clocks change in between (Sydney, Auckland, Santiago, Cairo and others) its
 * answer is off by the change, and the hour would be reported under the
 * neighbouring date. A clock change next to the day moves between the offsets
 * in force a day before and a day after it, so the day's midnight is taken by
 * each of them, and the cut is the earliest of those at which the date does
 * turn. A midnight the clocks skip starts the day where they land; of a
 * midnight they repeat, the first counts.
 */
export function calendarDayStart(day: string, timeZone: string): Date {
  const plain = businessDateToUtcStart(day, timeZone).getTime();
  const cuts = [...new Set([
    businessDateToUtcStart(previousBusinessDate(day), timeZone).getTime() + DAY_MS,
    plain,
    businessDateToUtcStart(nextBusinessDate(day), timeZone).getTime() - DAY_MS,
  ])].sort((left, right) => left - right);
  const turn = cuts.find((cut) => (
    toBusinessDate(new Date(cut), timeZone) >= day && toBusinessDate(new Date(cut - 1), timeZone) < day
  ));
  // No cut turns the date only if the clocks changed twice within two days,
  // which no zone does: the plain cut then, an hour off at worst.
  return new Date(turn ?? plain);
}

function toClientAiUsageTotals(rows: readonly UserPageDailyUsageRow[]): ClientAiUsageTotals {
  const sum = (pick: (row: UserPageDailyUsageRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    requestCount: sum((row) => row.requestCount),
    costMicroUsd: sum((row) => row.costMicroUsd),
    costApproximate: rows.some((row) => row.costApproximate),
    tokens: {
      input: sum((row) => row.inputTokens),
      output: sum((row) => row.outputTokens),
      cacheWrite: sum((row) => row.cacheWriteTokens),
      cacheRead: sum((row) => row.cacheReadTokens),
    },
    completed: sum((row) => row.completedCount),
    failed: sum((row) => row.failedCount),
    cancelled: sum((row) => row.cancelledCount),
    quotaDenied: sum((row) => row.quotaDeniedCount),
    openReservations: sum((row) => row.openReservationCount),
    regenerations: sum((row) => row.regenerationCount),
  };
}

/**
 * chat-extension H-15: what the caller spent on AI on one page, by day.
 * Database only: the ledger and the config; no platform request, no queued work.
 *
 * Whose: always `principal.user.id`. An owner reads the owner's own rows, never
 * a chatter's (the owner's view of everyone is the cabinet's admin report).
 *
 * TWO DAY BOUNDARIES, both printed in the answer:
 * - report days are calendar days in `query.timeZone` (Europe/Moscow by
 *   default, the cabinet's business day), cut where the zone's date turns
 *   (calendarDayStart), so a day the clocks change in is 23 or 25 hours long.
 *   The ledger is bucketed by the instants printed as `from` / `toExclusive`,
 *   so what a day shows is exactly what was counted;
 * - `quota` is the gateway's own answer (evaluateAiGatewayQuota), and its day
 *   is the UTC day. Around midnight the two "today"s are different windows.
 *
 * A day is `partial` while its numbers may still move or are not exact: the day
 * is not over, a generation of it has no outcome yet (its row carries no cost
 * and moves to the day it finishes in), or a cost in it is an estimate.
 *
 * Refuses (400 + reason) a zone the runtime does not know, a `date` after today
 * in that zone, and a `date` more than CLIENT_AI_USAGE_MAX_AGE_DAYS before it.
 */
export async function getClientAiUsageReport(
  app: AppContext,
  request: ClientFeatureRequest,
  principal: HumanAuthPrincipal,
  input: { pageLabel: string; query: ClientAiUsageQuery },
  now: Date = new Date(),
): Promise<ClientAiUsageResponse> {
  requireApiKeyUser(principal);
  // The hub's own check of this route (409 `client_feature_disabled` + reason).
  // It has no flag of its own, so: `not_granted` (not an active page granted
  // to the caller; a missing page answers the same), `disabled` (the owner's
  // master switch is off), `client_outdated`. No platform check: AI is spent
  // on every platform.
  const page = await requireClientPage(
    app,
    request,
    principal,
    await findPageSummaryByLabel(app.db, input.pageLabel),
    CLIENT_AI_USAGE_FEATURE,
  );

  const { date, days, timeZone } = input.query;
  if (!isKnownTimeZone(timeZone)) {
    refuseClientAiUsage("timeZone is not a time zone this hub knows", "unknown_time_zone");
  }
  const today = toBusinessDate(now, timeZone);
  if (date > today) {
    refuseClientAiUsage(`date is after today (${today} in ${timeZone})`, "date_in_future");
  }
  const oldest = businessDatesEndingAt(today, CLIENT_AI_USAGE_MAX_AGE_DAYS + 1)[0]!;
  if (date < oldest) {
    refuseClientAiUsage(
      `date is more than ${CLIENT_AI_USAGE_MAX_AGE_DAYS} days before today (${today} in ${timeZone})`,
      "date_too_old",
    );
  }

  const dates = businessDatesEndingAt(date, days);
  // One more boundary than days: day i is [boundaries[i], boundaries[i + 1]).
  const boundaries = [...dates, nextBusinessDate(date)].map((day) => calendarDayStart(day, timeZone));
  const userId = principal.user.id;
  const rows = await listUserPageDailyUsage(app.db, {
    userId,
    pageId: page.id,
    dayStarts: boundaries.slice(0, -1),
    toExclusive: boundaries[boundaries.length - 1]!,
  });
  const quota = isChatMuseAiGatewayEnabled(app.config)
    ? await evaluateAiGatewayQuota(app, { userId, pageId: page.id, now })
    : null;

  return {
    scope: { pageLabel: page.label, userId },
    timeZone,
    asOf: now.toISOString(),
    moneyUnit: "micro-USD",
    days: dates.map((day, index) => {
      const dayRows = rows.filter((row) => row.dayIndex === index);
      const totals = toClientAiUsageTotals(dayRows);
      const toExclusive = boundaries[index + 1]!;
      const coverageReasons: ClientAiUsageCoverageReason[] = [];
      if (now.getTime() < toExclusive.getTime()) {
        coverageReasons.push("day_open");
      }
      if (totals.openReservations > 0) {
        coverageReasons.push("open_reservations");
      }
      if (totals.costApproximate) {
        coverageReasons.push("approximate_cost");
      }
      return {
        date: day,
        from: boundaries[index]!.toISOString(),
        toExclusive: toExclusive.toISOString(),
        coverage: coverageReasons.length === 0 ? "complete" : "partial",
        coverageReasons,
        totals,
        features: dayRows.map((row) => ({ feature: row.feature, ...toClientAiUsageTotals([row]) })),
      };
    }),
    quota: quota === null
      ? null
      : {
        dayBoundary: "UTC",
        remainingRequestsToday: quota.remainingRequestsToday,
        remainingMicroUsdToday: quota.remainingMicroUsdToday,
      },
  };
}
