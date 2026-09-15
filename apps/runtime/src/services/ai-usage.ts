import type {
  AdminChatterUsageQuery,
  AdminChatterUsageResponse,
  AiUsageBatchBody,
  AiUsageBatchResponse,
  AuthMyUsageResponse,
} from "@agency_hub_core/contracts";
import { insertAiUsageEvents, listChatterUsageSummary, listUserUsageReport } from "@agency_hub_core/db";
import {
  MOSCOW_TIME_ZONE,
  businessDateToUtcStart,
  nextBusinessDate,
  previousBusinessDate,
  resolveBusinessDateRange,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, requireSessionUser, type AuthPrincipal } from "./auth.ts";
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
 * Decision 347: the caller's OWN usage (any session, any human role) — the same
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
