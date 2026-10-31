import type {
  AdminAiChatterLimitUpdateBody,
  AdminAiChatterLimitsResponse,
  ClientAiLimitResponse,
} from "@agency_hub_core/contracts";
import {
  getAiLimitPoolState,
  getAiPersonalLimitState,
  insertAuditEvent,
  listAiPersonalLimits,
  setAiPersonalDailyLimit,
} from "@agency_hub_core/db";
import {
  MOSCOW_TIME_ZONE,
  businessDateToUtcStart,
  nextBusinessDate,
  previousBusinessDate,
  toBusinessDate,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";

// The owner's personal daily AI limit of a person (0336): what their AI calls
// may cost in one Moscow day, all pages together. Past it the person spends
// from the shared pool — what everyone with a limit left unspent yesterday —
// until the pool runs dry; then the gateway refuses every AI call of the
// person until 00:00 Moscow time. The common per-page cap
// (chatMuseAiGatewayDailyMicroUsdLimit) applies on top.

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

function limitDaysOf(now: Date) {
  const today = moscowDayOf(now);
  return {
    today,
    yesterday: {
      from: businessDateToUtcStart(previousBusinessDate(today.day), MOSCOW_TIME_ZONE),
      toExclusive: today.from,
    },
  };
}

export interface AiLimitPool {
  /** Yesterday's unspent limits of everyone with a limit. */
  poolMicroUsd: number;
  usedMicroUsd: number;
  remainingMicroUsd: number;
}

function poolOf(state: { poolMicroUsd: number; usedMicroUsd: number }): AiLimitPool {
  return { ...state, remainingMicroUsd: Math.max(state.poolMicroUsd - state.usedMicroUsd, 0) };
}

export interface PersonalAiLimit {
  limitMicroUsd: number;
  spentMicroUsd: number;
  /** What is left of the person's own limit. */
  remainingMicroUsd: number;
  pool: AiLimitPool;
  /** Own remainder plus the shared pool's: what the person may still spend today. */
  availableMicroUsd: number;
  /** 00:00 Moscow time of the next day. */
  resetsAt: Date;
}

/** The person's personal limit and the shared pool today; null when they have no limit. */
export async function evaluatePersonalAiLimit(
  app: LimitsApp,
  input: { userId: number; now: Date },
): Promise<PersonalAiLimit | null> {
  const days = limitDaysOf(input.now);
  const state = await getAiPersonalLimitState(app.db, { userId: input.userId, ...days.today });
  if (!state || state.limitMicroUsd === null) return null;
  const pool = poolOf(await getAiLimitPoolState(app.db, days));
  const remainingMicroUsd = Math.max(state.limitMicroUsd - state.spentMicroUsd, 0);
  return {
    limitMicroUsd: state.limitMicroUsd,
    spentMicroUsd: state.spentMicroUsd,
    remainingMicroUsd,
    pool,
    availableMicroUsd: remainingMicroUsd + pool.remainingMicroUsd,
    resetsAt: days.today.toExclusive,
  };
}

/** The caller's own limit, today's spend and the shared pool (the chat extension's limit bar). */
export async function getClientAiLimit(
  app: LimitsApp,
  input: { userId: number },
  now = new Date(),
): Promise<ClientAiLimitResponse> {
  const range = moscowDayOf(now);
  const limit = await evaluatePersonalAiLimit(app, { userId: input.userId, now });
  if (limit === null) {
    const state = await getAiPersonalLimitState(app.db, { userId: input.userId, ...range });
    return {
      asOf: now.toISOString(),
      day: range.day,
      resetsAt: range.toExclusive.toISOString(),
      dailyLimitMicroUsd: null,
      todayMicroUsd: state?.spentMicroUsd ?? 0,
      remainingMicroUsd: null,
      poolMicroUsd: null,
      poolRemainingMicroUsd: null,
    };
  }
  return {
    asOf: now.toISOString(),
    day: range.day,
    resetsAt: range.toExclusive.toISOString(),
    dailyLimitMicroUsd: limit.limitMicroUsd,
    todayMicroUsd: limit.spentMicroUsd,
    remainingMicroUsd: limit.remainingMicroUsd,
    poolMicroUsd: limit.pool.poolMicroUsd,
    poolRemainingMicroUsd: limit.pool.remainingMicroUsd,
  };
}

/** Every living person: their limit, what their AI cost today and yesterday, and the shared pool. */
export async function getAdminAiChatterLimits(app: LimitsApp, now = new Date()): Promise<AdminAiChatterLimitsResponse> {
  const days = limitDaysOf(now);
  const rows = await listAiPersonalLimits(app.db, days);
  const pool = poolOf(await getAiLimitPoolState(app.db, days));
  return {
    generatedAt: now.toISOString(),
    day: days.today.day,
    resetsAt: days.today.toExclusive.toISOString(),
    pool: { microUsd: pool.poolMicroUsd, usedMicroUsd: pool.usedMicroUsd, remainingMicroUsd: pool.remainingMicroUsd },
    chatters: rows.map((row) => {
      const limit = row.limitMicroUsd;
      return {
        userId: row.userId,
        username: row.username,
        role: row.role,
        dailyLimitMicroUsd: limit,
        todayMicroUsd: row.spentMicroUsd,
        yesterdayMicroUsd: row.yesterdaySpentMicroUsd,
        intoPoolMicroUsd: limit === null ? null : Math.max(limit - row.yesterdaySpentMicroUsd, 0),
        fromPoolMicroUsd: limit === null ? null : Math.max(row.spentMicroUsd - limit, 0),
        blocked: limit !== null && row.spentMicroUsd >= limit && pool.remainingMicroUsd <= 0,
      };
    }),
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
