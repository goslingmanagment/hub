import type {
  AdminAiChatterLimitUpdateBody,
  AdminAiChatterLimitsResponse,
  ClientAiLimitResponse,
} from "@agency_hub_core/contracts";
import {
  getAiPersonalLimitState,
  insertAuditEvent,
  listAiPersonalLimits,
  setAiPersonalDailyLimit,
} from "@agency_hub_core/db";
import {
  MOSCOW_TIME_ZONE,
  businessDateToUtcStart,
  nextBusinessDate,
  toBusinessDate,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";

// The owner's personal daily AI limit of a person (0336): what their AI calls
// may cost in one Moscow day, all pages together. At the limit the gateway
// refuses every AI call of the person until 00:00 Moscow time; the common
// per-page cap (chatMuseAiGatewayDailyMicroUsdLimit) applies on top.

type LimitsApp = Pick<AppContext, "db">;

/** The Moscow day `now` is in, as a [from, toExclusive) range. Pure. */
export function moscowDayOf(now: Date) {
  const day = toBusinessDate(now, MOSCOW_TIME_ZONE);
  return {
    day,
    from: businessDateToUtcStart(day, MOSCOW_TIME_ZONE),
    toExclusive: businessDateToUtcStart(nextBusinessDate(day), MOSCOW_TIME_ZONE),
  };
}

export interface PersonalAiLimit {
  limitMicroUsd: number;
  spentMicroUsd: number;
  remainingMicroUsd: number;
  /** 00:00 Moscow time of the next day. */
  resetsAt: Date;
}

/** The person's personal limit today; null when they have none. */
export async function evaluatePersonalAiLimit(
  app: LimitsApp,
  input: { userId: number; now: Date },
): Promise<PersonalAiLimit | null> {
  const range = moscowDayOf(input.now);
  const state = await getAiPersonalLimitState(app.db, { userId: input.userId, ...range });
  if (!state || state.limitMicroUsd === null) return null;
  return {
    limitMicroUsd: state.limitMicroUsd,
    spentMicroUsd: state.spentMicroUsd,
    remainingMicroUsd: Math.max(state.limitMicroUsd - state.spentMicroUsd, 0),
    resetsAt: range.toExclusive,
  };
}

/** The caller's own limit and today's spend (the chat extension's limit bar). */
export async function getClientAiLimit(
  app: LimitsApp,
  input: { userId: number },
  now = new Date(),
): Promise<ClientAiLimitResponse> {
  const range = moscowDayOf(now);
  const state = await getAiPersonalLimitState(app.db, { userId: input.userId, ...range });
  const limit = state?.limitMicroUsd ?? null;
  const spent = state?.spentMicroUsd ?? 0;
  return {
    asOf: now.toISOString(),
    day: range.day,
    resetsAt: range.toExclusive.toISOString(),
    dailyLimitMicroUsd: limit,
    todayMicroUsd: spent,
    remainingMicroUsd: limit === null ? null : Math.max(limit - spent, 0),
  };
}

/** Every living person: their limit and what their AI cost today. */
export async function getAdminAiChatterLimits(app: LimitsApp, now = new Date()): Promise<AdminAiChatterLimitsResponse> {
  const range = moscowDayOf(now);
  const rows = await listAiPersonalLimits(app.db, range);
  return {
    generatedAt: now.toISOString(),
    day: range.day,
    resetsAt: range.toExclusive.toISOString(),
    chatters: rows.map((row) => ({
      userId: row.userId,
      username: row.username,
      role: row.role,
      dailyLimitMicroUsd: row.limitMicroUsd,
      todayMicroUsd: row.spentMicroUsd,
      blocked: row.limitMicroUsd !== null && row.spentMicroUsd >= row.limitMicroUsd,
    })),
  };
}

/** The owner sets or removes (null) a person's limit; answers with the whole list. */
export async function updateAdminAiChatterLimit(
  app: LimitsApp,
  input: { actorUserId: number; userId: number; body: AdminAiChatterLimitUpdateBody },
  now = new Date(),
): Promise<AdminAiChatterLimitsResponse> {
  const updated = await setAiPersonalDailyLimit(app.db, {
    userId: input.userId,
    limitMicroUsd: input.body.dailyLimitMicroUsd,
    at: now,
  });
  if (!updated) {
    throw new NotFoundError("User not found");
  }
  await insertAuditEvent(app.db, {
    actorUserId: input.actorUserId,
    source: "dashboard",
    eventType: "admin.ai_chatter_limit_update",
    metadata: { userId: input.userId, dailyLimitMicroUsd: input.body.dailyLimitMicroUsd },
  });
  return getAdminAiChatterLimits(app, now);
}
