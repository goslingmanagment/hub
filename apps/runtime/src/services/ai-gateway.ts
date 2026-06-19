import type { AiGatewayStreamBody } from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  getAiGatewayDailyUsageTotals,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { NotFoundError, ServiceUnavailableError, TooManyRequestsError } from "./errors.ts";

export const DEFAULT_AI_GATEWAY_DAILY_REQUEST_LIMIT = 200;
export const DEFAULT_AI_GATEWAY_DAILY_MICRO_USD_LIMIT = 5_000_000;

export interface AiGatewayQuotaSnapshot {
  accepted: boolean;
  remainingRequestsToday: number;
  remainingMicroUsdToday: number;
}

export function isChatMuseAiGatewayEnabled(
  config?: Pick<AppContext["config"], "chatMuseAiGatewayEnabled">,
) {
  return config?.chatMuseAiGatewayEnabled === true;
}

function utcDayBounds(now = new Date()) {
  const from = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  ));
  const toExclusive = new Date(from.getTime() + 24 * 60 * 60 * 1000);
  return { from, toExclusive };
}

function resolveNonnegativeLimit(value: number | null | undefined, fallback: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }

  return Math.floor(value);
}

export async function evaluateAiGatewayQuota(
  app: AppContext,
  input: {
    userId: number;
    pageId: number;
    now?: Date;
  },
): Promise<AiGatewayQuotaSnapshot> {
  const requestLimit = resolveNonnegativeLimit(
    app.config.chatMuseAiGatewayDailyRequestLimit,
    DEFAULT_AI_GATEWAY_DAILY_REQUEST_LIMIT,
  );
  const microUsdLimit = resolveNonnegativeLimit(
    app.config.chatMuseAiGatewayDailyMicroUsdLimit,
    DEFAULT_AI_GATEWAY_DAILY_MICRO_USD_LIMIT,
  );
  const day = utcDayBounds(input.now);
  const totals = await getAiGatewayDailyUsageTotals(app.db, {
    userId: input.userId,
    pageId: input.pageId,
    from: day.from,
    toExclusive: day.toExclusive,
  });
  const remainingRequestsToday = Math.max(requestLimit - totals.requestCount, 0);
  const remainingMicroUsdToday = Math.max(microUsdLimit - totals.costMicroUsd, 0);

  return {
    accepted: remainingRequestsToday > 0 && remainingMicroUsdToday > 0,
    remainingRequestsToday,
    remainingMicroUsdToday,
  };
}

export async function prepareAiGatewayStream(
  app: AppContext,
  principal: AuthPrincipal,
  input: AiGatewayStreamBody,
) {
  if (!isChatMuseAiGatewayEnabled(app.config)) {
    throw new ServiceUnavailableError("ChatMuse AI gateway is disabled");
  }

  const page = await findPageSummaryByLabel(app.db, input.pageLabel);
  if (!page || !canAccessPage(principal, page.id) || page.platform !== input.platform) {
    throw new NotFoundError("Page not found");
  }

  const quota = await evaluateAiGatewayQuota(app, {
    userId: principal.user.id,
    pageId: page.id,
  });
  if (!quota.accepted) {
    throw new TooManyRequestsError("ChatMuse AI gateway daily quota exceeded");
  }

  // Provider execution, atomic quota reservation, durable terminal provider rows,
  // and SSE streaming land in the next C6c slices. Until then, enabling the flag
  // still cannot reach Anthropic/OpenRouter or persist prompt text.
  throw new ServiceUnavailableError("ChatMuse AI gateway provider execution is not implemented");
}
