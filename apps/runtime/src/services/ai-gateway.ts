import { randomUUID } from "node:crypto";

import type {
  AiFeatureDebugInputFrame,
  AiGatewayQuota,
  AiGatewayStreamBody,
  AiGatewayStreamFrame,
  AiGatewayUsage,
} from "@agency_hub_core/contracts";
import {
  finalizeAiGatewayUsageEvent,
  findPageByLabel,
  getAiGatewayDailyUsageTotals,
  getAiGatewayFeatureDailyTotals,
  insertAiGenerationContent,
  markStaleAiGatewayReservationsFailed,
  recordAiGatewayQuotaDenied,
  reserveAiGatewayUsageEvent,
} from "@agency_hub_core/db";
import type { ProxyConfig } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError, QuotaDeniedError, ServiceUnavailableError } from "./errors.ts";
import { estimateAnthropicGatewayRequestCost } from "./ai-gateway-anthropic.ts";
import { estimateOpenrouterGatewayRequestCost } from "./ai-gateway-openrouter-provider.ts";
import { aiGatewayProviderForModel } from "./ai-gateway-pricing.ts";
import { resolveStoredProxyConfig, resolveStoredProxyEgressKey } from "./page-context.ts";

export const DEFAULT_AI_GATEWAY_DAILY_REQUEST_LIMIT = 500;
export const DEFAULT_AI_GATEWAY_DAILY_MICRO_USD_LIMIT = 10_000_000;
export const DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT = 5_000_000;
export const AI_GATEWAY_STALE_RESERVATION_MS = 30 * 60 * 1000;

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
    proxy: ProxyConfig | null;
    egressKey: string;
  };
  body: AiGatewayStreamBody;
  quota: AiGatewayQuota;
  signal: AbortSignal;
  /** Server-derived, off the wire: disables adaptive summarized thinking so a
   * tight maxTokens stays a pure output budget (fan-summary short recap). The
   * Anthropic provider honors it; OpenRouter has no thinking block to disable. */
  disableAdaptiveThinking?: boolean;
}

export interface AiGatewayProvider {
  readonly provider: "anthropic" | "openrouter";
  stream(input: AiGatewayProviderInput): AsyncIterable<AiGatewayStreamFrame>;
}

export interface PreparedAiGatewayStream {
  requestId: string;
  meta: AiGatewayStreamFrame;
  debugFrame?: AiFeatureDebugInputFrame;
  stream(signal: AbortSignal): AsyncIterable<AiGatewayStreamFrame>;
  recordTerminal(input: AiGatewayTerminalRecordInput): Promise<boolean>;
  /** Coach transport ceiling (spec §3/§7, option "c"): when set, the SSE pump
   * aborts the generation if accumulated visible output (content_delta chars)
   * crosses this bound, erroring WITHOUT a `done` frame so the attempt is
   * terminal-recorded as failed and can never be committed/replayed. Off the
   * wire (feature service sets it for coach-chat only); unset = no ceiling. */
  visibleOutputCeilingChars?: number;
}

export interface AiGatewayTerminalRecordInput {
  outcome: "completed" | "failed" | "cancelled";
  usage: AiGatewayUsage | null;
  providerResponseId: string | null;
  cacheHit: boolean;
  durationMs: number;
  completedAt: Date;
  /** Stage 29 restricted class: the accumulated completion text, verbatim. */
  completionText: string;
  stopReason?: string | null;
}

/** Stage 29: model prefix routes the provider — "openrouter:*" to the
 * second provider, everything else to Anthropic. */
export function selectAiGatewayProvider(
  app: Pick<AppContext, "aiGatewayProvider" | "aiGatewayOpenrouterProvider">,
  model: string,
): AiGatewayProvider | undefined {
  return aiGatewayProviderForModel(model) === "openrouter"
    ? app.aiGatewayOpenrouterProvider
    : app.aiGatewayProvider;
}

export function parseAiGatewayFeatureLimits(raw: string | undefined): Record<string, number> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const limits: Record<string, number> = {};
    for (const [feature, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        limits[feature] = Math.floor(value);
      }
    }
    return limits;
  } catch {
    return {};
  }
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

/** PR3: internal-only knobs for a prepared stream. NEVER a field on
 * aiGatewayStreamBodySchema — the body is client-forgeable, shared with the
 * raw gateway route, and a schema change would force an SDK regen. */
export interface AiGatewayStreamInternalOptions {
  /** Per-generation transcript context manifest (counts/heads only, no
   * text) — recorded as the ADDITIVE params.contextManifest key on the
   * restricted generation record. Shadow generations settle through the
   * same recordTerminal finally-path, so there is no second write path;
   * quota-denied / pre-stream throws never reach recordTerminal and thus
   * never manifest, by design. */
  contextManifest?: Record<string, unknown>;
  /** Feature-lane-only, capability-gated prompt echo. Never set by the raw
   * gateway route and never persisted separately from the existing restricted
   * generation record. */
  debugFrame?: AiFeatureDebugInputFrame;
  /** Echoed only for clients that supplied the matching feature precondition. */
  personaDefinitionId?: string;
}

/** The feature service builds a stream input from the wire body plus optional
 * server-derived provenance. `featureParams` is NEVER part of the wire
 * contract (the raw gateway route passes a plain body and leaves it unset) —
 * it is spread verbatim, additively, into the restricted generation record's
 * params so fan-summary rows carry summaryMode/transcriptCoverage/counts for
 * the two-slot recap selection (spec §5). */
export type AiGatewayStreamInput = AiGatewayStreamBody & {
  featureParams?: Record<string, unknown>;
  /** Server-derived, off the wire: disables adaptive summarized thinking on the
   * Anthropic provider so a tight maxTokens stays a pure output budget (the
   * fan-summary short recap sets it alongside maxTokens: 2048). */
  disableAdaptiveThinking?: boolean;
  /** Off the wire (never on aiGatewayStreamBodySchema): the fan this generation
   * is ABOUT, stored as the restricted record's fan_ref so a fan-scope Stage 28
   * erasure reaches coach/recap rows whose conversation_ref is the canonical
   * groupId (spec §5). The feature lane sets it to body.fanRef ?? null; the raw
   * gateway and internal lanes leave it unset (null). */
  fanRef?: string | null;
  /** Server-derived, off the wire: the coach transport ceiling (spec §3/§7,
   * option "c"). The feature service sets it to COACH_ANSWER_MAX_CHARS for
   * coach-chat so the SSE pump enforces the same bound on the live stream that
   * the wire schema enforces on a replayed answer. Propagated verbatim onto the
   * prepared stream; the raw gateway and other features leave it unset. */
  visibleOutputCeilingChars?: number;
};

export async function prepareAiGatewayStream(
  app: AppContext,
  principal: AuthPrincipal,
  input: AiGatewayStreamInput,
  internal?: AiGatewayStreamInternalOptions,
): Promise<PreparedAiGatewayStream> {
  if (!isChatMuseAiGatewayEnabled(app.config)) {
    throw new ServiceUnavailableError("ChatMuse AI gateway is disabled");
  }

  const storedPage = await findPageByLabel(app.db, input.pageLabel);
  if (
    !storedPage ||
    !canAccessPage(principal, storedPage.page.id) ||
    storedPage.page.platform !== input.platform
  ) {
    throw new NotFoundError("Page not found");
  }
  const page = storedPage.page;
  const proxy = resolveStoredProxyConfig(app, storedPage.proxy);
  const egressKey = resolveStoredProxyEgressKey(storedPage.proxy);
  if (!proxy) {
    throw new ServiceUnavailableError("ChatMuse AI gateway requires a configured page proxy");
  }

  const now = new Date();
  const recoveredReservations = await markStaleAiGatewayReservationsFailed(app.db, {
    reservedBefore: new Date(now.getTime() - AI_GATEWAY_STALE_RESERVATION_MS),
    recoveredAt: now,
  });
  if (recoveredReservations > 0) {
    app.logger.warn({
      recoveredReservations,
      staleAfterMs: AI_GATEWAY_STALE_RESERVATION_MS,
    }, "recovered stale ai gateway reservations");
  }

  // Quota answers do not depend on provider config: a 429 outranks the 503
  // below (pre-Stage-29 ordering preserved), so the reservation carries the
  // provider only once one resolves.
  const provider = selectAiGatewayProvider(app, input.model);
  const reservationEvent = {
    clientEventId: input.clientRequestId,
    feature: input.feature,
    model: input.model,
    pageId: page.id,
    provider: provider?.provider ?? null,
    conversationId: input.conversationId ?? null,
    isRegeneration: input.isRegeneration,
    reservedAt: now,
  };
  async function denyQuota(message: string): Promise<never> {
    // A denial is a ledger fact, not silence (gateway_outcome=quota_denied).
    await recordAiGatewayQuotaDenied(app.db, {
      userId: principal.user.id,
      event: reservationEvent,
    });
    throw new QuotaDeniedError(message);
  }

  const quota = await evaluateAiGatewayQuota(app, {
    userId: principal.user.id,
    pageId: page.id,
    now,
  });
  if (!quota.accepted) {
    await denyQuota("ChatMuse AI gateway daily quota exceeded");
  }

  // Stage 29: per-feature GLOBAL daily ceilings (all principals) — sized so
  // scheduled internal lanes fit; absent feature = no per-feature ceiling.
  const featureLimits = parseAiGatewayFeatureLimits(
    app.config.chatMuseAiGatewayFeatureDailyMicroUsdLimits,
  );
  const featureLimit = featureLimits[input.feature];
  if (featureLimit !== undefined) {
    const day = utcDayBounds(now);
    const featureTotals = await getAiGatewayFeatureDailyTotals(app.db, {
      feature: input.feature,
      from: day.from,
      toExclusive: day.toExclusive,
    });
    if (featureTotals.costMicroUsd >= featureLimit) {
      await denyQuota(`ChatMuse AI gateway daily budget for ${input.feature} exceeded`);
    }
  }

  if (!provider) {
    throw new ServiceUnavailableError("ChatMuse AI gateway provider execution is not configured");
  }
  const requestMicroUsdLimit = resolveNonnegativeLimit(
    app.config.chatMuseAiGatewayRequestMicroUsdLimit,
    DEFAULT_AI_GATEWAY_REQUEST_MICRO_USD_LIMIT,
  );
  let estimatedRequestCostMicroUsd: number;
  try {
    estimatedRequestCostMicroUsd = provider.provider === "openrouter"
      ? estimateOpenrouterGatewayRequestCost(input).costMicroUsd
      : estimateAnthropicGatewayRequestCost(input).costMicroUsd;
  } catch {
    throw new BadRequestError("Unsupported ChatMuse AI gateway model");
  }
  if (requestMicroUsdLimit <= 0 || estimatedRequestCostMicroUsd > requestMicroUsdLimit) {
    await denyQuota("ChatMuse AI gateway request cost ceiling exceeded");
  }
  const reserved = await reserveAiGatewayUsageEvent(app.db, {
    userId: principal.user.id,
    event: reservationEvent,
  });
  if (!reserved) {
    throw new ConflictError("ChatMuse AI gateway request id is already reserved");
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
      provider: provider.provider,
      providerResponseId: null,
      ...(internal?.personaDefinitionId !== undefined
        ? { personaDefinitionId: internal.personaDefinitionId }
        : {}),
      quota: quotaFrame,
    },
    ...(internal?.debugFrame ? { debugFrame: internal.debugFrame } : {}),
    ...(input.visibleOutputCeilingChars !== undefined
      ? { visibleOutputCeilingChars: input.visibleOutputCeilingChars }
      : {}),
    stream(signal) {
      return provider.stream({
        requestId,
        principal,
        page: {
          id: page.id,
          label: page.label,
          platform: page.platform,
          proxy,
          egressKey,
        },
        body: input,
        quota: quotaFrame,
        signal,
        ...(input.disableAdaptiveThinking
          ? { disableAdaptiveThinking: true }
          : {}),
      });
    },
    async recordTerminal(record) {
      const usage = record.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        costMicroUsd: 0,
        costApproximate: false,
      };
      const usageEventId = await finalizeAiGatewayUsageEvent(app.db, {
        userId: principal.user.id,
        event: {
          clientEventId: input.clientRequestId,
          providerResponseId: record.providerResponseId,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          cacheReadTokens: usage.cacheReadTokens,
          costMicroUsd: usage.costMicroUsd,
          costApproximate: usage.costApproximate,
          gatewayOutcome: record.outcome,
          durationMs: Math.max(0, Math.floor(record.durationMs)),
          isCacheHit: record.cacheHit,
          completedAt: record.completedAt,
        },
      });
      // Stage 29 (DP 6-A): the restricted class stores the generation
      // VERBATIM — prompt blocks, completion, params — keyed by the
      // gateway-issued requestId (= generation_ref on the meta frame, the
      // acceptance correlation key). All outcomes captured; a cancelled
      // stream's partial completion is still a fact.
      await insertAiGenerationContent(app.db, {
        usageEventId,
        generationRef: requestId,
        feature: input.feature,
        model: input.model,
        provider: provider.provider,
        userId: principal.user.id,
        pageId: page.id,
        conversationRef: input.conversationId ?? null,
        fanRef: input.fanRef ?? null,
        promptBlocks: [
          { role: "system", blocks: input.prompt.systemBlocks },
          { role: "user", blocks: input.prompt.userBlocks },
        ],
        completion: record.completionText,
        params: {
          // Feature-derived provenance spreads FIRST so the canonical
          // gateway keys below always win on any collision.
          ...(input.featureParams ?? {}),
          maxTokens: input.maxTokens ?? null,
          temperature: input.temperature ?? null,
          reasoningEffort: input.reasoningEffort,
          isRegeneration: input.isRegeneration,
          outcome: record.outcome,
          stopReason: record.stopReason ?? null,
          ...(internal?.contextManifest !== undefined
            ? { contextManifest: internal.contextManifest }
            : {}),
        },
      });
      return usageEventId !== null;
    },
  };
}

export function serializeAiGatewaySseFrame(frame: AiGatewayStreamFrame | AiFeatureDebugInputFrame) {
  return `event: ai\ndata: ${JSON.stringify(frame)}\n\n`;
}
