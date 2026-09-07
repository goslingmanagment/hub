import { randomUUID } from "node:crypto";

import type { AiGatewayPromptBlock, AiGatewayUsage } from "@agency_hub_core/contracts";
import {
  sanitizeError,
  normalizeProviderStreamFailure,
  type AiProviderFailureClassification,
  type AiUsageFeature,
} from "@agency_hub_core/shared";
import {
  finalizeAiGatewayUsageEvent,
  getAiGatewayFeatureDailyTotals,
  insertAiGenerationContent,
  recordAiGatewayQuotaDenied,
  reserveAiGatewayUsageEvent,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import type { AiGatewayProvider } from "./ai-gateway.ts";
import type { AnthropicGatewayOutputFormat } from "./ai-gateway-anthropic.ts";
import {
  createAnthropicAiGatewayProvider,
  createDirectAnthropicClientResolver,
} from "./ai-gateway-anthropic-provider.ts";
import { AiGatewayTerminalStreamConsumer, parseAiGatewayFeatureLimits } from "./ai-gateway.ts";
import { reconcileAiProviderTerminalIncident } from "./ai-gateway-incidents.ts";
import { QuotaDeniedError, ServiceUnavailableError } from "./errors.ts";

// Kernel Stage 29 Task 5 — the internal completion lane. System-initiated
// gateway calls (the workboard closing classifier) go through the SAME
// reserve → provider → finalize → restricted-capture path as client
// streams, so their spend lands in the ledger under their feature and
// their content joins the restricted class.
//
// EXECUTION DECISIONS (recorded):
// - user_id NULL = system (Stage 9 credit-ledger precedent).
// - Egress is DIRECT (no page proxy) — byte-identical to the pre-gateway
//   classifier's own SDK call; page proxies are for page-attributed lanes.
// - The per-user/page daily quota does NOT apply (no user, no page); the
//   per-feature GLOBAL budget is this lane's guard — size it so scheduled
//   runs fit.

/** Narrow app view so page-scoped call sites (classifier orchestration)
 * can construct it from db + config without a full AppContext. */
export interface GatewayInternalApp {
  db: AppContext["db"];
  config: {
    anthropicApiKey?: string | null;
    chatMuseAiGatewayFeatureDailyMicroUsdLimits?: string;
  };
  logger: Pick<AppContext["logger"], "warn">;
}

export interface GatewayCompletionInput {
  feature: AiUsageFeature;
  /** Gateway model key, e.g. "anthropic:claude-haiku-4-5". */
  model: string;
  systemBlocks: AiGatewayPromptBlock[];
  userBlocks: AiGatewayPromptBlock[];
  maxTokens?: number;
  temperature?: number;
  /** Structured-outputs schema; the completion text is then schema-valid JSON. */
  outputFormat?: AnthropicGatewayOutputFormat;
  pageId?: number | null;
  conversationRef?: string | null;
  /** Test seam: replaces the direct-egress Anthropic provider. */
  providerOverride?: AiGatewayProvider;
}

export interface GatewayCompletionResult {
  text: string;
  usage: AiGatewayUsage | null;
  generationRef: string;
}

export async function runGatewayCompletion(
  app: GatewayInternalApp,
  input: GatewayCompletionInput,
): Promise<GatewayCompletionResult> {
  if (!app.config.anthropicApiKey) {
    throw new ServiceUnavailableError("AI gateway internal lane requires ANTHROPIC_API_KEY");
  }
  const now = new Date();
  const clientEventId = randomUUID();
  const reservationEvent = {
    clientEventId,
    feature: input.feature,
    model: input.model,
    pageId: input.pageId ?? null,
    provider: "anthropic" as const,
    conversationId: input.conversationRef ?? null,
    isRegeneration: false,
    reservedAt: now,
  };

  const featureLimits = parseAiGatewayFeatureLimits(
    app.config.chatMuseAiGatewayFeatureDailyMicroUsdLimits,
  );
  const featureLimit = featureLimits[input.feature];
  if (featureLimit !== undefined) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const totals = await getAiGatewayFeatureDailyTotals(app.db, {
      feature: input.feature,
      from,
      toExclusive: new Date(from.getTime() + 24 * 60 * 60 * 1000),
    });
    if (totals.costMicroUsd >= featureLimit) {
      await recordAiGatewayQuotaDenied(app.db, { userId: null, event: reservationEvent });
      throw new QuotaDeniedError(`AI gateway daily budget for ${input.feature} exceeded`);
    }
  }

  await reserveAiGatewayUsageEvent(app.db, { userId: null, event: reservationEvent });

  const provider = input.providerOverride ?? createAnthropicAiGatewayProvider({
    resolveClient: createDirectAnthropicClientResolver(app.config.anthropicApiKey),
  });
  const generationRef = randomUUID();
  const body = {
    clientRequestId: clientEventId,
    feature: input.feature,
    pageLabel: "internal",
    platform: "onlyfans" as const,
    platformUserId: "internal",
    conversationId: input.conversationRef ?? null,
    model: input.model,
    reasoningEffort: "off" as const,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    isRegeneration: false,
    prompt: {
      systemBlocks: input.systemBlocks,
      userBlocks: input.userBlocks,
    },
  };

  const startedAt = Date.now();
  // The SAME terminal-integrity folder the SSE pump and the CLI smoke path
  // use. This lane used to hand-roll frame folding and defaulted to
  // "completed", so a stream with no usage, no usable `done`, or empty output
  // settled as a SUCCESS: it billed zero, resolved the global provider
  // billing latch, and handed the workboard an empty completion that
  // `parseVerdicts` turned into all-needs_reply defaults — which then got
  // WRITTEN INTO `wb_closing_cache` under a content hash and never
  // recomputed. Terminal integrity now lives in exactly one place.
  const terminal = new AiGatewayTerminalStreamConsumer();
  let terminalFailure: AiProviderFailureClassification | null = null;
  const abort = new AbortController();
  try {
    for await (const frame of provider.stream({
      requestId: generationRef,
      principal: null as never, // unused by the direct resolver
      page: {
        id: input.pageId ?? 0,
        label: "internal",
        platform: "onlyfans",
        proxy: null,
        egressKey: "internal",
      },
      body,
      quota: { accepted: true, remainingRequestsToday: null, remainingMicroUsdToday: null },
      signal: abort.signal,
      ...(input.outputFormat ? { outputFormat: input.outputFormat } : {}),
    })) {
      // No SSE on this lane, so the frames the consumer wants emitted are
      // dropped; only the folded terminal state matters here.
      terminal.note(frame);
    }
    terminal.finish();
  } catch (error) {
    terminal.outcome = "failed";
    terminalFailure = normalizeProviderStreamFailure(error, {
      provider: provider.provider,
      ...(terminal.streamedContent ? { failurePhase: "stream" as const } : {}),
    });
    app.logger.warn(
      {
        feature: input.feature,
        observedError: sanitizeError(error, { format: "chain" }).message,
        code: terminalFailure.code,
        failurePhase: terminalFailure.failurePhase,
        providerHttpStatus: terminalFailure.providerHttpStatus,
      },
      "AI gateway internal completion failed",
    );
    throw error;
  } finally {
    const completedAt = new Date();
    const outcome: "completed" | "failed" = terminal.outcome === "completed"
      ? "completed"
      : "failed";
    const errorCode = outcome === "failed"
      ? terminalFailure?.code
        ?? terminal.failureDetail?.errorCode
        ?? "provider_stream_failed"
      : null;
    const failurePhase = outcome === "failed"
      ? terminalFailure?.failurePhase ?? terminal.failureDetail?.failurePhase ?? "stream"
      : null;
    const providerHttpStatus = outcome === "failed"
      ? terminalFailure?.providerHttpStatus ?? terminal.failureDetail?.providerHttpStatus ?? null
      : null;
    const settledUsage = terminal.usage ?? {
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      costMicroUsd: 0,
      costApproximate: false,
    };
    const usageEventId = await finalizeAiGatewayUsageEvent(app.db, {
      userId: null,
      event: {
        clientEventId,
        providerResponseId: terminal.providerResponseId,
        inputTokens: settledUsage.inputTokens,
        outputTokens: settledUsage.outputTokens,
        cacheWriteTokens: settledUsage.cacheWriteTokens,
        cacheReadTokens: settledUsage.cacheReadTokens,
        costMicroUsd: settledUsage.costMicroUsd,
        costApproximate: settledUsage.costApproximate,
        gatewayOutcome: outcome,
        errorCode,
        failurePhase,
        providerHttpStatus,
        durationMs: Date.now() - startedAt,
        isCacheHit: terminal.cacheHit,
        completedAt,
      },
    });
    await insertAiGenerationContent(app.db, {
      usageEventId,
      generationRef,
      feature: input.feature,
      model: input.model,
      provider: "anthropic",
      userId: null,
      pageId: input.pageId ?? null,
      conversationRef: input.conversationRef ?? null,
      // System-initiated generations carry no separate fan scope; erasure
      // reaches them (if ever needed) by conversation_ref.
      fanRef: null,
      promptBlocks: [
        { role: "system", blocks: input.systemBlocks },
        { role: "user", blocks: input.userBlocks },
      ],
      completion: terminal.completionText,
      params: {
        maxTokens: input.maxTokens ?? null,
        temperature: input.temperature ?? null,
        reasoningEffort: "off",
        isRegeneration: false,
        outcome,
        stopReason: terminal.stopReason,
      },
    });
    if (usageEventId !== null) {
      await reconcileAiProviderTerminalIncident(app, {
        provider: provider.provider,
        outcome,
        pageId: input.pageId ?? null,
        errorCode,
        failurePhase,
        providerHttpStatus,
        completedAt,
      });
    }
  }

  // Fail closed AFTER the ledger row, the restricted capture and the incident
  // reconcile have settled — an unusable terminal is a recorded failure, not a
  // silent one. Only reachable when the stream ended without throwing; a
  // provider exception already propagated from the catch above.
  if (terminal.outcome !== "completed") {
    throw new ServiceUnavailableError(
      "AI gateway internal completion produced an unusable terminal "
      + `(${terminal.failureDetail?.errorCode ?? "provider_stream_failed"})`,
    );
  }

  return { text: terminal.completionText, usage: terminal.usage, generationRef };
}
