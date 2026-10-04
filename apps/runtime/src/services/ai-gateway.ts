import { randomUUID } from "node:crypto";

import type {
  AiFeatureAttachedRecaps,
  AiFeatureContextFrame,
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
  type AiGatewayFailurePhase,
} from "@agency_hub_core/db";
import {
  normalizeProviderStreamFailure,
  type AiProviderFailureClassification,
  type AiProviderFailureCode,
  type AiProviderFailurePhase,
  type AiProviderId,
  type ProxyConfig,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type HumanAuthPrincipal } from "./auth.ts";
import { BadRequestError, ConflictError, NotFoundError, QuotaDeniedError, ServiceUnavailableError } from "./errors.ts";
import {
  estimateAnthropicGatewayRequestCost,
  type AnthropicGatewayOutputFormat,
} from "./ai-gateway-anthropic.ts";
import { estimateOpenrouterGatewayRequestCost } from "./ai-gateway-openrouter-provider.ts";
import { reconcileAiProviderTerminalIncident } from "./ai-gateway-incidents.ts";
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
  principal: HumanAuthPrincipal;
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
  /** Server-derived, off the wire: structured-outputs schema for a request
   * whose consumer parses JSON. No caller sets it today — the internal
   * completion lane that did was removed with the Workboard (Decision 376) —
   * but the knob stays wired: the Anthropic provider honors it; OpenRouter
   * ignores it. */
  outputFormat?: AnthropicGatewayOutputFormat;
}

export interface AiGatewayProvider {
  readonly provider: "anthropic" | "openrouter";
  stream(input: AiGatewayProviderInput): AsyncIterable<AiGatewayStreamFrame>;
}

export interface PreparedAiGatewayStream {
  requestId: string;
  provider: AiGatewayProvider["provider"];
  page: {
    id: number;
    label: string;
    platform: AiGatewayStreamBody["platform"];
  };
  meta: AiGatewayStreamFrame;
  debugFrame?: AiFeatureDebugInputFrame;
  /** Feature-lane `context_v1` frame, written after `meta` and the debug frame. */
  contextFrame?: AiFeatureContextFrame;
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
  /** Populated for failed terminals only; successful/cancelled rows are
   * normalized back to null at the repository boundary. */
  errorCode?: string | null;
  failurePhase?: AiGatewayFailurePhase | null;
  providerHttpStatus?: number | null;
  usage: AiGatewayUsage | null;
  providerResponseId: string | null;
  cacheHit: boolean;
  durationMs: number;
  completedAt: Date;
  /** Stage 29 restricted class: the accumulated completion text, verbatim. */
  completionText: string;
  stopReason?: string | null;
  /** Coach transport ceiling (spec §3/§7): the ceiling aborts the provider
   * mid-stream BEFORE its terminal usage frame, so real token counts never
   * arrive — but the request already burned provider spend. Set true ONLY on
   * the ceiling path so the ledger falls back to the request-cost estimator
   * instead of recording zeros (which would hide the spend from both budget
   * guards). A genuine provider failure / client cancel leaves this false. */
  estimateCostOnMissingUsage?: boolean;
}

/** Keep HTTP and CLI terminal accounting consistent, including ceiling aborts. */
export function buildAiGatewayTerminalRecord(
  consumer: AiGatewayTerminalStreamConsumer,
  input: Pick<AiGatewayTerminalRecordInput, "outcome" | "durationMs" | "completedAt"> & {
    failure: Pick<AiProviderFailureClassification, "code" | "failurePhase" | "providerHttpStatus"> | null;
  },
): AiGatewayTerminalRecordInput {
  const failed = input.outcome === "failed";
  return {
    outcome: input.outcome,
    errorCode: failed ? input.failure?.code ?? consumer.failureDetail?.errorCode ?? "provider_stream_failed" : null,
    failurePhase: failed ? input.failure?.failurePhase ?? consumer.failureDetail?.failurePhase ?? "stream" : null,
    providerHttpStatus: failed ? input.failure?.providerHttpStatus ?? consumer.failureDetail?.providerHttpStatus ?? null : null,
    usage: consumer.usage,
    providerResponseId: consumer.providerResponseId,
    cacheHit: consumer.cacheHit,
    durationMs: input.durationMs,
    completedAt: input.completedAt,
    completionText: consumer.completionText,
    stopReason: consumer.stopReason,
    estimateCostOnMissingUsage: consumer.ceilingExceeded,
  };
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

/** A `context_v1` frame before the gateway names its generation. */
export type AiFeatureContextFrameBody = Omit<AiFeatureContextFrame, "type" | "generationRef">;

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
  /** Feature-lane-only, capability-gated `context_v1` frame, still without its
   * identity: the generation ref exists only once the request is reserved, so
   * it is stamped here from the same request id the meta frame carries. Never
   * set by the raw gateway route. */
  contextFrame?: AiFeatureContextFrameBody;
  /** Echoed only for clients that supplied the matching feature precondition. */
  personaDefinitionId?: string;
  /** Coach-only recap provenance for the existing meta frame. Derived from the
   * finalized prompt attachments; absent for the raw gateway and other features. */
  attachedRecaps?: AiFeatureAttachedRecaps;
  /** Coach-only echo of the canonical question substituted for a preset turn. */
  presetQuestion?: string;
  /** Feature-lane-only structural check of the FINAL completion text
   * (chat-extension H-10: Split parts and variants; counts, never text). Runs
   * once on a completed stream and is recorded as the ADDITIVE
   * params.outputStructure key of the restricted generation record. Write-only:
   * the stream has already been sent, so it can never filter or change it. */
  describeOutput?: (completionText: string) => Record<string, unknown>;
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
  principal: HumanAuthPrincipal,
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
    provider: provider.provider,
    page: {
      id: page.id,
      label: page.label,
      platform: page.platform,
    },
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
      ...(internal?.attachedRecaps !== undefined
        ? { attachedRecaps: internal.attachedRecaps }
        : {}),
      ...(internal?.presetQuestion !== undefined
        ? { presetQuestion: internal.presetQuestion }
        : {}),
      quota: quotaFrame,
    },
    ...(internal?.debugFrame ? { debugFrame: internal.debugFrame } : {}),
    ...(internal?.contextFrame
      ? { contextFrame: { type: "context_v1" as const, generationRef: requestId, ...internal.contextFrame } }
      : {}),
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
      const errorCode = record.outcome === "failed"
        ? (record.errorCode ?? "provider_stream_failed")
        : null;
      const failurePhase = record.outcome === "failed"
        ? (record.failurePhase ?? "stream")
        : null;
      const providerHttpStatus = record.outcome === "failed"
        ? (record.providerHttpStatus ?? null)
        : null;
      // Ceiling abort (P1-1/P2-6): the provider was torn down mid-stream before
      // its terminal usage frame, so record.usage is null even though the
      // request already spent tokens (a ~100k-token prompt plus the streamed
      // output up to the ceiling). Recording zeros hides that spend from BOTH
      // getAiGatewayDailyUsageTotals (per-user daily $ cap) and
      // getAiGatewayFeatureDailyTotals (per-feature global ceiling), which each
      // sum cost_micro_usd. Fall back to the SAME conservative request-cost
      // estimator the pre-stream ceiling used, so the terminal record carries a
      // non-zero, never-under charge. costApproximate stays true; the token
      // split is left at zero because only the cost is estimable here.
      let resolvedUsage = record.usage;
      if (!resolvedUsage && record.estimateCostOnMissingUsage) {
        try {
          const estimate = provider.provider === "openrouter"
            ? estimateOpenrouterGatewayRequestCost(input)
            : estimateAnthropicGatewayRequestCost(input);
          resolvedUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheWriteTokens: 0,
            cacheReadTokens: 0,
            costMicroUsd: estimate.costMicroUsd,
            costApproximate: true,
          };
        } catch {
          // A pricing lookup failure must not lose the terminal record; fall
          // through to the zeroed default below.
        }
      }
      const usage = resolvedUsage ?? {
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
          errorCode,
          failurePhase,
          providerHttpStatus,
          durationMs: Math.max(0, Math.floor(record.durationMs)),
          isCacheHit: record.cacheHit,
          completedAt: record.completedAt,
        },
      });
      // A record of the finished text, never a reason to lose the terminal row.
      let outputStructure: Record<string, unknown> | undefined;
      if (internal?.describeOutput !== undefined && record.outcome === "completed") {
        try {
          outputStructure = internal.describeOutput(record.completionText);
        } catch (error) {
          app.logger.warn({ requestId, err: error }, "AI gateway output structure check failed");
        }
      }
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
          { role: "user", blocks: input.prompt.userBlocks, ...(input.prompt.images?.length ? { images: input.prompt.images } : {}) },
        ],
        completion: record.completionText,
        params: {
          // Feature-derived provenance spreads FIRST so the canonical
          // gateway keys below always win on any collision.
          ...(input.featureParams ?? {}),
          // chat-extension H-3: a narrow token's generation is labelled with
          // its client profile (the desktop-retirement metric); a full
          // token's params are unchanged.
          ...(principal.clientProfile !== undefined ? { clientProfile: principal.clientProfile } : {}),
          maxTokens: input.maxTokens ?? null,
          temperature: input.temperature ?? null,
          reasoningEffort: input.reasoningEffort,
          isRegeneration: input.isRegeneration,
          outcome: record.outcome,
          stopReason: record.stopReason ?? null,
          ...(internal?.contextManifest !== undefined
            ? { contextManifest: internal.contextManifest }
            : {}),
          ...(outputStructure !== undefined ? { outputStructure } : {}),
        },
      });
      if (usageEventId !== null) {
        // Incidents are strictly downstream of chatter fail-closed handling,
        // terminal ledger settlement, and restricted capture. The producer
        // guards its own query/open/resolve failures and never throws here.
        await reconcileAiProviderTerminalIncident(app, {
          provider: provider.provider,
          outcome: record.outcome,
          pageId: page.id,
          pageLabel: page.label,
          platform: page.platform,
          errorCode,
          failurePhase,
          providerHttpStatus,
          completedAt: record.completedAt,
        });
      }
      return usageEventId !== null;
    },
  };
}

export function serializeAiGatewaySseFrame(
  frame: AiGatewayStreamFrame | AiFeatureDebugInputFrame | AiFeatureContextFrame,
) {
  return `event: ai\ndata: ${JSON.stringify(frame)}\n\n`;
}

const PROVIDER_FAILURE_MESSAGES = {
  provider_billing: "AI provider billing requires attention",
  provider_auth: "AI provider authentication failed",
  provider_rate_limited: "AI provider rate limit reached",
  provider_unavailable: "AI provider is temporarily unavailable",
  provider_proxy_unreachable: "AI gateway could not reach the page's egress proxy",
  provider_stream_failed: "AI gateway provider stream failed",
} satisfies Record<AiProviderFailureCode, string>;

/** Stage 1B wire rendering: one bounded, provider-text-free message per code. */
export function providerStreamFailureFrame(
  failureOrError: AiProviderFailureClassification | unknown,
  input?: {
    provider?: AiProviderId;
    failurePhase?: AiProviderFailurePhase;
    now?: number;
  },
): Extract<AiGatewayStreamFrame, { type: "error" }> {
  const failure = isProviderFailureClassification(failureOrError)
    ? failureOrError
    : normalizeProviderStreamFailure(failureOrError, input);
  return {
    type: "error",
    code: failure.code,
    message: PROVIDER_FAILURE_MESSAGES[failure.code],
    retryAfterMs: failure.retryAfterMs,
  };
}

function isProviderFailureClassification(
  value: unknown,
): value is AiProviderFailureClassification {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<AiProviderFailureClassification>;
  return typeof candidate.code === "string"
    && candidate.code in PROVIDER_FAILURE_MESSAGES
    && (
      candidate.failurePhase === "connect"
      || candidate.failurePhase === "provider_response"
      || candidate.failurePhase === "stream"
    )
    && (candidate.providerHttpStatus === null || typeof candidate.providerHttpStatus === "number")
    && (candidate.retryAfterMs === null || typeof candidate.retryAfterMs === "number");
}

// The coach ceiling error frame (spec §3/§7): emitted WITHOUT a `done` frame so
// no client treats an over-ceiling answer as a committed result.
export const COACH_OUTPUT_TOO_LONG_ERROR_FRAME = {
  type: "error",
  code: "coach_output_too_long",
  message: "AI gateway output exceeded the coach transport ceiling",
  retryAfterMs: null,
} satisfies AiGatewayStreamFrame;

// A provider that streamed content but never sent usage metadata is a broken
// (truncated) stream, recorded as failed — never presented as a result.
export const PROVIDER_USAGE_MISSING_ERROR_FRAME = {
  type: "error",
  code: "provider_usage_missing",
  message: "AI gateway provider ended without usage metadata",
  retryAfterMs: null,
} satisfies AiGatewayStreamFrame;

// A provider that streamed content but reached EOF WITHOUT a terminal stopReason
// (no done frame, or a synthetic done carrying stopReason == null) was cut
// mid-generation — recorded as failed and emitted WITHOUT a done frame, so no
// client can commit an aborted coach answer or attach a truncated recap (P1-2).
export const PROVIDER_STREAM_INCOMPLETE_ERROR_FRAME = {
  type: "error",
  code: "provider_stream_incomplete",
  message: "AI gateway provider stream ended without a terminal stop reason",
  retryAfterMs: null,
} satisfies AiGatewayStreamFrame;

// Empty or whitespace-only output is not a completed generation. Reject it in
// the shared terminal consumer so HTTP and CLI callers agree, no `done` frame
// reaches a client, and the restricted record cannot become a usable recap.
export const PROVIDER_OUTPUT_EMPTY_ERROR_FRAME = {
  type: "error",
  code: "provider_output_empty",
  message: "AI gateway provider completed without usable output",
  retryAfterMs: null,
} satisfies AiGatewayStreamFrame;

/**
 * Shared terminal-stream consumer (P1-5): the coach transport ceiling check and
 * the terminal outcome/usage/stopReason accounting used by BOTH the HTTP SSE
 * pump (pipeAiGatewaySse) and the CLI smoke path (ai:feature-smoke), so the two
 * can never drift on what counts as a committed, usable generation. It writes
 * no SSE and owns no I/O — the caller emits the frames each step returns and
 * decides how to abort. The seam it shares: (1) a coach answer whose accumulated
 * visible output crosses the ceiling is aborted mid-stream and recorded failed
 * (never completed), so it can never be attached/committed; (2) a stream that
 * emitted content but no usage frame is failed, not silently completed.
 */
export class AiGatewayTerminalStreamConsumer {
  outcome: "completed" | "failed" | "cancelled" = "completed";
  usage: AiGatewayUsage | null = null;
  providerResponseId: string | null = null;
  cacheHit = false;
  completionText = "";
  stopReason: string | null = null;
  streamedContent = false;
  ceilingExceeded = false;
  failureDetail: {
    errorCode: string;
    failurePhase: AiGatewayFailurePhase;
    providerHttpStatus: number | null;
  } | null = null;
  private doneFrame: AiGatewayStreamFrame | null = null;

  constructor(private readonly visibleOutputCeilingChars?: number | undefined) {}

  /** Fold one provider frame into the terminal state. Returns the frames the
   * caller should emit IN ORDER, and whether the ceiling was crossed. A
   * crossing means: emit these (the crossing content + the ceiling error),
   * then abort the provider and stop reading — no `done` frame follows. */
  note(frame: AiGatewayStreamFrame): { emit: AiGatewayStreamFrame[]; ceilingCrossed: boolean } {
    if (frame.type === "usage") {
      this.usage = frame.usage;
      this.providerResponseId = frame.providerResponseId;
      this.cacheHit = frame.cacheHit;
      return { emit: [frame], ceilingCrossed: false };
    }
    if (frame.type === "content_delta" && frame.text.length > 0) {
      this.streamedContent = true;
      this.completionText += frame.text;
      if (
        this.visibleOutputCeilingChars !== undefined
        && this.completionText.length > this.visibleOutputCeilingChars
      ) {
        this.ceilingExceeded = true;
        this.outcome = "failed";
        this.noteFailureFrame(COACH_OUTPUT_TOO_LONG_ERROR_FRAME);
        return { emit: [frame, COACH_OUTPUT_TOO_LONG_ERROR_FRAME], ceilingCrossed: true };
      }
      return { emit: [frame], ceilingCrossed: false };
    }
    if (frame.type === "error") {
      this.outcome = "failed";
      this.noteFailureFrame(frame);
      return { emit: [frame], ceilingCrossed: false };
    }
    if (frame.type === "done") {
      // Held back until finish(): a `done` frame is only emitted for a stream
      // that actually completed (with usage), never for a truncated one.
      this.doneFrame = frame;
      this.stopReason = frame.stopReason ?? null;
      return { emit: [], ceilingCrossed: false };
    }
    return { emit: [frame], ceilingCrossed: false };
  }

  /** A content-bearing stream is a USABLE terminal only when the provider
   * emitted a done frame carrying a non-null stopReason. A premature EOF — no
   * done frame, or a synthetic done with stopReason == null (Anthropic yields
   * exactly this on a clean iterator end that never saw a terminal
   * message_delta) — means the generation was cut mid-output and must fail
   * closed. An exhausted-but-present stopReason (`max_tokens`/`length`) IS a
   * usable terminal here; the recap selector and the coach ceiling handle
   * exhaustion separately downstream. */
  private hasUsableTerminal(): boolean {
    return this.doneFrame !== null && this.stopReason !== null;
  }

  /** After the loop ends without a ceiling abort: returns the trailing frames
   * to emit (the held `done` frame, or an error) and finalizes the outcome.
   * `usageMissing` lets the caller log the missing-usage anomaly. A no-op after
   * a ceiling abort (outcome is already failed, no done frame). */
  finish(): { emit: AiGatewayStreamFrame[]; usageMissing: boolean } {
    if (this.outcome === "completed" && this.streamedContent && !this.usage) {
      this.outcome = "failed";
      this.noteFailureFrame(PROVIDER_USAGE_MISSING_ERROR_FRAME);
      return { emit: [PROVIDER_USAGE_MISSING_ERROR_FRAME], usageMissing: true };
    }
    // Premature EOF (P1-2): the stream emitted content (and, past the check
    // above, usage) but ended without a terminal stopReason. Fail closed with an
    // error frame and NO done, so the partial output can never be committed or
    // attached. Zero/whitespace output has its own explicit guard immediately
    // below, once the stronger incomplete-terminal condition is ruled out.
    if (this.outcome === "completed" && this.streamedContent && !this.hasUsableTerminal()) {
      this.outcome = "failed";
      this.noteFailureFrame(PROVIDER_STREAM_INCOMPLETE_ERROR_FRAME);
      return { emit: [PROVIDER_STREAM_INCOMPLETE_ERROR_FRAME], usageMissing: false };
    }
    if (this.outcome === "completed" && this.completionText.trim().length === 0) {
      this.outcome = "failed";
      this.noteFailureFrame(PROVIDER_OUTPUT_EMPTY_ERROR_FRAME);
      return { emit: [PROVIDER_OUTPUT_EMPTY_ERROR_FRAME], usageMissing: false };
    }
    if (this.doneFrame) {
      return { emit: [this.doneFrame], usageMissing: false };
    }
    return { emit: [], usageMissing: false };
  }

  private noteFailureFrame(frame: Extract<AiGatewayStreamFrame, { type: "error" }>) {
    this.failureDetail = {
      errorCode: frame.code,
      failurePhase: "stream",
      providerHttpStatus: null,
    };
  }
}
