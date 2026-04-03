import type {
  AdminChatterUsageQuery,
  AdminChatterUsageResponse,
  AiUsageBatchBody,
  AiUsageBatchResponse,
} from "@agency_hub_core/contracts";
import { insertAiUsageEvents, listChatterUsageSummary } from "@agency_hub_core/db";
import {
  MOSCOW_TIME_ZONE,
  businessDateToUtcStart,
  nextBusinessDate,
  previousBusinessDate,
  resolveBusinessDateRange,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { requireApiKeyUser, type AuthPrincipal } from "./auth.ts";
import { BadRequestError } from "./errors.ts";

const COMPLETED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;

function parseCompletedAt(value: string, now: Date) {
  const completedAt = new Date(value);
  if (Number.isNaN(completedAt.getTime())) {
    throw new BadRequestError("completedAt must be a valid timestamp");
  }

  if (completedAt.getTime() > now.getTime() + COMPLETED_AT_FUTURE_SKEW_MS) {
    throw new BadRequestError("completedAt cannot be more than 5 minutes in the future");
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

function resolveRequestedUsageRange(query: AdminChatterUsageQuery, now: Date) {
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
  const insertedCount = await insertAiUsageEvents(app.db, {
    userId: principal.user.id,
    events: body.events.map((event) => ({
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
      completedAt: parseCompletedAt(event.completedAt, now),
    })),
  });

  return {
    receivedCount: body.events.length,
    insertedCount,
    dedupedCount: body.events.length - insertedCount,
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
