import { randomUUID } from "node:crypto";

import type {
  AiGatewayQuota,
  AiGatewayStreamBody,
  AiGatewayStreamFrame,
  AiGatewayUsage,
} from "@agency_hub_core/contracts";
import {
  findPageSummaryByLabel,
  getAiGatewayDailyUsageTotals,
  insertAiUsageEvents,
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

export interface AiGatewayProviderInput {
  requestId: string;
  principal: AuthPrincipal;
  page: {
    id: number;
    label: string;
    platform: AiGatewayStreamBody["platform"];
  };
  body: AiGatewayStreamBody;
  quota: AiGatewayQuota;
  signal: AbortSignal;
}

export interface AiGatewayProvider {
  readonly provider: "anthropic" | "openrouter";
  stream(input: AiGatewayProviderInput): AsyncIterable<AiGatewayStreamFrame>;
}

export interface PreparedAiGatewayStream {
  requestId: string;
  meta: AiGatewayStreamFrame;
  stream(signal: AbortSignal): AsyncIterable<AiGatewayStreamFrame>;
  recordTerminal(input: AiGatewayTerminalRecordInput): Promise<number>;
}

export interface AiGatewayTerminalRecordInput {
  outcome: "completed" | "failed" | "cancelled";
  usage: AiGatewayUsage | null;
  providerResponseId: string | null;
  cacheHit: boolean;
  durationMs: number;
  completedAt: Date;
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
): Promise<PreparedAiGatewayStream> {
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
  if (!app.aiGatewayProvider) {
    throw new ServiceUnavailableError("ChatMuse AI gateway provider execution is not configured");
  }

  const requestId = randomUUID();
  const quotaFrame: AiGatewayQuota = {
    accepted: quota.accepted,
    remainingRequestsToday: quota.remainingRequestsToday,
    remainingMicroUsdToday: quota.remainingMicroUsdToday,
  };

  return {
    requestId,
    meta: {
      type: "meta",
      requestId,
      clientRequestId: input.clientRequestId,
      feature: input.feature,
      pageLabel: page.label,
      model: input.model,
      provider: app.aiGatewayProvider.provider,
      providerResponseId: null,
      quota: quotaFrame,
    },
    stream(signal) {
      return app.aiGatewayProvider!.stream({
        requestId,
        principal,
        page: {
          id: page.id,
          label: page.label,
          platform: page.platform,
        },
        body: input,
        quota: quotaFrame,
        signal,
      });
    },
    recordTerminal(record) {
      const usage = record.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: 0,
        costApproximate: false,
      };
      return insertAiUsageEvents(app.db, {
        userId: principal.user.id,
        events: [{
          clientEventId: input.clientRequestId,
          feature: input.feature,
          model: input.model,
          pageId: page.id,
          provider: app.aiGatewayProvider!.provider,
          providerResponseId: record.providerResponseId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costMicroUsd: usage.costMicroUsd,
          costApproximate: usage.costApproximate,
          quotaAccepted: true,
          gatewayOutcome: record.outcome,
          conversationId: input.conversationId ?? null,
          durationMs: Math.max(0, Math.floor(record.durationMs)),
          isCacheHit: record.cacheHit,
          isRegeneration: input.isRegeneration,
          completedAt: record.completedAt,
        }],
      });
    },
  };
}

export function serializeAiGatewaySseFrame(frame: AiGatewayStreamFrame) {
  return `event: ai\ndata: ${JSON.stringify(frame)}\n\n`;
}
