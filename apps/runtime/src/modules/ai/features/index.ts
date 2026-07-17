import type {
  AiFeatureDebugInputFrame,
  AiGatewayReasoningEffort,
} from "@agency_hub_core/contracts";
import { findAiPersonaByKey, findPageByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import {
  prepareAiGatewayStream,
  type AiGatewayStreamInput,
  type PreparedAiGatewayStream,
} from "../../../services/ai-gateway.ts";
import { canAccessPage, type AuthPrincipal } from "../../../services/auth.ts";
import {
  BadRequestError,
  NotFoundError,
  PersonaDefinitionChangedError,
  ProductGateError,
  UnknownAiFeatureError,
} from "../../../services/errors.ts";
import { loadEffectiveConfig } from "../../../services/effective-config.ts";
import { isPromptDebugEchoEnabled } from "../prompt-debug-echo.ts";
import { aiPersonaDefinitionId } from "../persona-definition.ts";
import {
  isFanProfileFeatureEnabled,
  loadFanBio,
  loadFanDisplayName,
  loadFanProfileContext,
  loadSpendingContext,
  loadSubscriptionContext,
  loadTranscriptContext,
  type AiTranscriptUnionMode,
  type FanProfilePromptContext,
} from "../context/index.ts";
import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  DEFAULT_MESSAGE_COUNT_BY_BUCKET,
  FEATURE_POLICIES,
  HI_GREETING_MAX_TRANSCRIPT,
  BUNDLED_LORA_PERSONALITY_ID,
  analyzePingSegment,
  buildPrompt,
  isOperationFeature,
  type OperationFeature,
  type Personality,
  type PingSegment,
  type ReplyMode,
  type ReplyTone,
} from "../prompts/index.ts";

// Kernel Stage 30 — feature services. Prompt assembly moves kernel-side:
// context loads from the kernel's own stores, the MIGRATED builder
// assembles byte-identical prompts, and the stream rides Stage 29's
// gateway internals (budgets, ledger, restricted capture, generation
// refs). No client cuts over here — the kernel becomes ABLE to serve them
// (Stages 31/32 do the cutovers).
//
// The registry is DERIVED from the migrated FEATURE_POLICIES — one source
// of truth for prompt behavior, model delegation, earnings inclusion,
// window buckets, and the desktop's product gates (draft required,
// deep-feature minimum, hi-greeting lock, ping segment analysis).

export interface AiFeatureRequestBody {
  clientRequestId: string;
  pageLabel: string;
  platform: "onlyfans" | "fansly";
  /** The fan conversation (OF: conversation id == fan id). */
  conversationRef: string;
  fanRef?: string | null;
  personaKey?: string | null;
  /** Optional cache/provenance precondition from the metadata catalog. */
  expectedPersonaDefinitionId?: string;
  model?: string;
  reasoningEffort?: AiGatewayReasoningEffort;
  replyTone?: ReplyTone;
  replyMode?: ReplyMode;
  messageCount?: number;
  draftText?: string;
  isRegeneration?: boolean;
  chatterQuestion?: string;
  coachHistory?: Array<{ question: string; answer: string }>;
  summaryMode?: "short";
  /** Stage 32: client-loaded context (Fansly — the kernel archive is
   * pull-cadenced: dm_conversations 30 min / dm_messages 24 h, no webhooks;
   * the extension reads the conversation live at generation time). */
  clientContext?: {
    transcript: string;
    messageCount: number;
    fanDisplayName: string;
    fanSpendingData: string;
    fanSubscriptionData: string;
    fanBio?: string;
    pingSegment?: PingSegment;
    transcriptCoverage?: "full-history" | "window";
  };
}

async function resolvePersona(
  app: Pick<AppContext, "db">,
  personaKey: string | null | undefined,
  expectedDefinitionId: string | undefined,
): Promise<{ personality: Personality; definitionId: string }> {
  // Omitted personaKey is the legacy spelling of the default bundled key, not
  // permission to bypass Core lifecycle state with source-code prompt bytes.
  const resolvedKey = personaKey || BUNDLED_LORA_PERSONALITY_ID;
  const stored = await findAiPersonaByKey(app.db, resolvedKey);
  if (!stored) {
    // A definition-aware client selected this catalog entry before it was
    // archived/deleted. Preserve the same structured refresh signal as a
    // byte-level definition mismatch; legacy callers retain their historical
    // 400 distinction for unavailable keys.
    if (expectedDefinitionId !== undefined) {
      throw new PersonaDefinitionChangedError();
    }
    if (personaKey) {
      throw new BadRequestError(`Unknown persona: ${personaKey}`);
    }
    throw new BadRequestError(
      `Default persona ${BUNDLED_LORA_PERSONALITY_ID} is unavailable; select an active persona`,
    );
  }
  return {
    personality: {
      id: stored.key,
      name: stored.displayName,
      content: stored.systemBlock,
      updatedAt: stored.updatedAt.getTime(),
    },
    definitionId: aiPersonaDefinitionId(stored),
  };
}

// Coach conversation history is a client-carried scratchpad (this repo assembles
// no history server-side). Bound the aggregate so a runaway client can't push an
// unbounded prompt through the feature lane; per-entry caps live in the contract
// schema, this caps their sum.
const COACH_HISTORY_AGGREGATE_MAX_CHARS = 120_000;

export async function prepareAiFeatureStream(
  app: AppContext,
  principal: AuthPrincipal,
  featureKey: string,
  body: AiFeatureRequestBody,
  options?: { debugPromptEcho?: boolean },
): Promise<PreparedAiGatewayStream> {
  if (!(featureKey in FEATURE_POLICIES) || !isOperationFeature(featureKey as never)) {
    throw new UnknownAiFeatureError(`Unknown AI feature: ${featureKey}`);
  }
  const feature = featureKey as OperationFeature;
  const policy = FEATURE_POLICIES[feature];

  if (policy.requiresDraft && !body.draftText?.trim()) {
    throw new ProductGateError(`${feature} requires draftText`, "gate_draft_required");
  }

  // Coach feature isolation (spec §7): coach-chat REQUIRES a question and bounds
  // its client-carried history; every other feature REFUSES the coach fields so
  // a stray field can never silently reshape a Reply/Ping/Summary prompt. The
  // summaryMode toggle is likewise fan-summary-only.
  if (feature === "coach-chat") {
    if (!body.chatterQuestion?.trim()) {
      throw new BadRequestError("coach-chat requires chatterQuestion");
    }
    const aggregate = (body.coachHistory ?? []).reduce(
      (sum, entry) => sum + entry.question.length + entry.answer.length,
      0,
    );
    if (aggregate > COACH_HISTORY_AGGREGATE_MAX_CHARS) {
      throw new BadRequestError(
        `coachHistory aggregate exceeds ${COACH_HISTORY_AGGREGATE_MAX_CHARS} chars`,
      );
    }
  } else if (body.chatterQuestion !== undefined || body.coachHistory !== undefined) {
    throw new BadRequestError(`${feature} does not accept coach fields`);
  }
  if (body.summaryMode !== undefined && feature !== "fan-summary") {
    throw new BadRequestError(`${feature} does not accept summaryMode`);
  }

  // Access is checked HERE, before any context loads — a principal without
  // the page must not pull its transcript/spend into a prompt (fastreply-
  // freshness PR2). Combined not-found shape mirrors the gateway's: page
  // existence, access, and platform mismatch are indistinguishable to the
  // caller. The gateway re-checks at stream time (canAccessPage needs only
  // principal + pageId — no state from the context loads).
  const stored = await findPageByLabel(app.db, body.pageLabel);
  if (
    !stored ||
    !canAccessPage(principal, stored.page.id) ||
    stored.page.platform !== body.platform
  ) {
    throw new NotFoundError("Page not found");
  }
  const pageId = stored.page.id;
  const fanRef = body.fanRef ?? body.conversationRef;

  const persona = await resolvePersona(
    app,
    body.personaKey,
    body.expectedPersonaDefinitionId,
  );
  if (
    body.expectedPersonaDefinitionId !== undefined
    && body.expectedPersonaDefinitionId !== persona.definitionId
  ) {
    throw new PersonaDefinitionChangedError();
  }

  let contextValues: {
    transcript: string;
    messageCount: number;
    fanSpendingData: string;
    fanSubscriptionData: string;
    fanDisplayName: string;
    fanBio: string | undefined;
    pingSegment: PingSegment | undefined;
  };
  // PR3: the per-generation transcript context manifest (kernel-context path
  // only); rides an INTERNAL argument into the gateway, never the body.
  let contextManifest: Record<string, unknown> | undefined;
  if (body.clientContext && stored.page.platform !== "fansly") {
    // The Stage 32 deviation is Fansly-motivated (no webhook lane; the kernel
    // archive is pull-cadenced). OnlyFans context is kernel-fresh — accepting
    // client values there would let a bearer fabricate transcript/spend.
    throw new BadRequestError("clientContext is only accepted for fansly pages");
  }
  if (body.clientContext) {
    // Client-loaded context path (Stage 32). The product gates run on the
    // client-reported counts/segment — the same values the client's own
    // pre-cutover assembly gated on; the kernel cannot know them fresher
    // (its Fansly archive is pull-cadenced by design).
    const clientContext = body.clientContext;
    if (policy.usesPingSegment && clientContext.pingSegment === undefined) {
      throw new BadRequestError(`${feature} requires clientContext.pingSegment`);
    }
    contextValues = {
      transcript: clientContext.transcript,
      messageCount: clientContext.messageCount,
      fanSpendingData: policy.includesEarnings ? clientContext.fanSpendingData : "",
      fanSubscriptionData: policy.includesEarnings ? clientContext.fanSubscriptionData : "",
      fanDisplayName: clientContext.fanDisplayName,
      fanBio: policy.includesFanBio ? clientContext.fanBio : undefined,
      pingSegment: policy.usesPingSegment ? clientContext.pingSegment : undefined,
    };
  } else {
    // PR3 (C6): read the union mode ONCE per generation, here, just before
    // the transcript load, via the live overlay (flips need no restart).
    // A failed read or an invalid stored value is NOT a silent archive
    // fallback — it degrades to "unknown" and the manifest records it.
    // The union read is OnlyFans-only (dm_message_archive is the OFAPI
    // post-settle store; Fansly has no webhook lane).
    let unionMode: AiTranscriptUnionMode = "off";
    if (stored.page.platform === "onlyfans") {
      try {
        const effective = await loadEffectiveConfig(app.db, app.config);
        const raw = effective.aiTranscriptFreshUnionMode;
        unionMode = raw === "off" || raw === "shadow" || raw === "serve" ? raw : "unknown";
      } catch {
        unionMode = "unknown";
      }
    }
    const transcript = await loadTranscriptContext(app, {
      pageId,
      conversationRef: body.conversationRef,
      limit: body.messageCount ?? DEFAULT_MESSAGE_COUNT_BY_BUCKET[policy.messageCountBucket],
      unionMode,
    });
    contextManifest = transcript.contextManifest;
    const spending = policy.includesEarnings
      ? await loadSpendingContext(app, { pageId, fanRef })
      : null;
    const subscription = policy.includesEarnings
      ? await loadSubscriptionContext(app, { pageId, fanRef })
      : null;
    contextValues = {
      transcript: transcript.transcript,
      messageCount: transcript.messages.length,
      fanSpendingData: spending?.block ?? "",
      fanSubscriptionData: subscription?.block ?? "",
      fanDisplayName: await loadFanDisplayName(app, { pageId, fanRef, platform: stored.page.platform }),
      fanBio: policy.includesFanBio
        ? await loadFanBio(app, { fanRef, platform: stored.page.platform })
        : undefined,
      pingSegment: policy.usesPingSegment
        ? analyzePingSegment(transcript.messages, Date.now()).segment
        : undefined,
    };
  }

  // Desktop product gates, carried (CG-FLOW-03 and the hi-greeting lock).
  if (policy.minMessages > 0 && contextValues.messageCount < policy.minMessages) {
    throw new ProductGateError(
      `${feature} requires at least ${policy.minMessages} messages in the conversation`,
      "gate_min_messages",
    );
  }
  if (feature === "hi-greeting" && contextValues.messageCount > HI_GREETING_MAX_TRANSCRIPT) {
    throw new ProductGateError(
      `hi-greeting is only available for conversations with at most ${HI_GREETING_MAX_TRANSCRIPT} messages`,
      "gate_hi_greeting_limit",
    );
  }
  // Desktop parity (CG-FLOW-05): pings are blocked while the fan is active.
  if (policy.usesPingSegment && contextValues.pingSegment === "active") {
    throw new ProductGateError("ping is blocked while the conversation is active", "gate_ping_active");
  }

  // Decision #136: policy-enabled features read the stored fan dossier (the
  // Scan profile the clients push to fan_profiles) into their prompt. The
  // dossier is optional enrichment and STRICTLY fail-open — on the Fansly
  // clientContext path this is the only fans-table read of the generation, so
  // a fan_profiles hiccup must degrade to "no section", never to a failed
  // Reply/Ping. The runtime allowlist is the no-deploy rollback switch.
  let fanProfile: FanProfilePromptContext | undefined;
  if (policy.usesFanProfile) {
    try {
      const effective = await loadEffectiveConfig(app.db, app.config);
      if (isFanProfileFeatureEnabled(effective.chatMuseAiFanProfileContextFeatures, feature)) {
        fanProfile = await loadFanProfileContext(app, {
          pageId,
          fanRef,
          platform: stored.page.platform,
          now: Date.now(),
        });
      }
    } catch (error) {
      app.logger.warn({ feature, pageId, error }, "ai feature dossier lookup failed");
    }
  }
  if (fanProfile) {
    // debug, not info — fast-reply is high-frequency; never log the body.
    app.logger.debug({
      feature,
      pageId,
      profileVersion: fanProfile.version,
      profileAgeDays: fanProfile.ageDays,
      profileChars: fanProfile.body.length,
      truncated: fanProfile.truncated,
      droppedSections: fanProfile.droppedSections,
    }, "ai feature dossier injected");
    // Rides the restricted generation record's params.contextManifest on BOTH
    // context paths — the Fansly clientContext lane has no transcript manifest,
    // but the dossier injection still needs a per-generation audit trail.
    contextManifest = {
      ...(contextManifest ?? {}),
      fanProfile: {
        version: fanProfile.version,
        generatedAt: fanProfile.generatedAt.toISOString(),
        ageDays: fanProfile.ageDays,
        chars: fanProfile.body.length,
        truncated: fanProfile.truncated,
        droppedSections: fanProfile.droppedSections,
      },
    };
  }

  const prompt = buildPrompt({
    feature,
    personality: persona.personality,
    platform: body.platform,
    transcript: contextValues.transcript,
    fanSpendingData: contextValues.fanSpendingData,
    fanSubscriptionData: contextValues.fanSubscriptionData,
    fanDisplayName: contextValues.fanDisplayName,
    fanBio: contextValues.fanBio,
    fanProfile: fanProfile
      ? { body: fanProfile.body, generatedAt: fanProfile.generatedAt }
      : undefined,
    draftText: body.draftText,
    pingSegment: contextValues.pingSegment,
    replyTone: policy.supportsReplyTone ? body.replyTone : undefined,
    replyMode: policy.supportsReplyMode ? body.replyMode : undefined,
  });

  const gatewayBody: AiGatewayStreamInput = {
    clientRequestId: body.clientRequestId,
    feature,
    pageLabel: body.pageLabel,
    platform: body.platform,
    platformUserId: fanRef,
    conversationId: body.conversationRef,
    model: body.model ?? DEFAULT_FEATURE_MODELS[policy.modelFeature],
    reasoningEffort: body.reasoningEffort ?? DEFAULT_FEATURE_REASONING[policy.modelFeature],
    isRegeneration: body.isRegeneration ?? false,
    // Two-slot recap selection (spec §5): only fan-summary rows carry the
    // summaryMode/coverage/count provenance the recap reader filters on.
    ...(feature === "fan-summary"
      ? {
        featureParams: {
          summaryMode: body.summaryMode ?? "full",
          transcriptCoverage: body.clientContext?.transcriptCoverage ?? null,
          requestedCount: body.messageCount ?? null,
          keptCount: body.clientContext?.messageCount ?? null,
        },
      }
      : {}),
    prompt: {
      systemBlocks: prompt.systemBlocks,
      userBlocks: prompt.userBlocks,
    },
  };
  let debugFrame: AiFeatureDebugInputFrame | undefined;
  if (options?.debugPromptEcho) {
    try {
      const effective = await loadEffectiveConfig(app.db, app.config);
      if (isPromptDebugEchoEnabled(effective.chatMuseAiPromptDebugEchoEnabled)) {
        debugFrame = {
          type: "debug_input_v1",
          systemBlocks: prompt.systemBlocks,
          userBlocks: prompt.userBlocks,
          contextManifest: contextManifest ?? null,
        };
        app.logger.info({
          feature,
          pageId,
          userId: principal.user.id,
          username: principal.user.username,
        }, "ai prompt debug echo emitted");
      }
    } catch {
      // The echo is a declassification, so it fails closed: a config-lookup
      // failure yields no frame and never affects the generation itself.
    }
  }
  return prepareAiGatewayStream(
    app,
    principal,
    gatewayBody,
    contextManifest !== undefined
      || debugFrame !== undefined
      || body.expectedPersonaDefinitionId !== undefined
      ? {
        ...(contextManifest !== undefined ? { contextManifest } : {}),
        ...(debugFrame !== undefined ? { debugFrame } : {}),
        ...(body.expectedPersonaDefinitionId !== undefined
          ? { personaDefinitionId: persona.definitionId }
          : {}),
      }
      : undefined,
  );
}
