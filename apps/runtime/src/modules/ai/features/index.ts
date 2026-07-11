import type { AiGatewayReasoningEffort, AiGatewayStreamBody } from "@agency_hub_core/contracts";
import { findAiPersonaByKey, findPageByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import {
  prepareAiGatewayStream,
  type PreparedAiGatewayStream,
} from "../../../services/ai-gateway.ts";
import { canAccessPage, type AuthPrincipal } from "../../../services/auth.ts";
import { BadRequestError, NotFoundError, ProductGateError } from "../../../services/errors.ts";
import { loadEffectiveConfig } from "../../../services/effective-config.ts";
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
  analyzePingSegment,
  buildPrompt,
  createBundledPersonalities,
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
  model?: string;
  reasoningEffort?: AiGatewayReasoningEffort;
  replyTone?: ReplyTone;
  replyMode?: ReplyMode;
  messageCount?: number;
  draftText?: string;
  isRegeneration?: boolean;
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
  };
}

async function resolvePersona(
  app: Pick<AppContext, "db">,
  personaKey: string | null | undefined,
): Promise<Personality> {
  if (personaKey) {
    const stored = await findAiPersonaByKey(app.db, personaKey);
    if (!stored) {
      throw new BadRequestError(`Unknown persona: ${personaKey}`);
    }
    return {
      id: stored.key,
      name: stored.displayName,
      content: stored.systemBlock,
      updatedAt: stored.updatedAt.getTime(),
    };
  }
  return createBundledPersonalities()[0]!;
}

export async function prepareAiFeatureStream(
  app: AppContext,
  principal: AuthPrincipal,
  featureKey: string,
  body: AiFeatureRequestBody,
): Promise<PreparedAiGatewayStream> {
  if (!(featureKey in FEATURE_POLICIES) || !isOperationFeature(featureKey as never)) {
    throw new NotFoundError(`Unknown AI feature: ${featureKey}`);
  }
  const feature = featureKey as OperationFeature;
  const policy = FEATURE_POLICIES[feature];

  if (policy.requiresDraft && !body.draftText?.trim()) {
    throw new ProductGateError(`${feature} requires draftText`, "gate_draft_required");
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

  const persona = await resolvePersona(app, body.personaKey);

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
      fanBio: feature === "hi-greeting" ? clientContext.fanBio : undefined,
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
      fanBio: feature === "hi-greeting"
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
          volatileMaxAgeDays: effective.chatMuseAiFanProfileVolatileMaxAgeDays ?? 21,
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
    if (contextManifest !== undefined) {
      contextManifest = {
        ...contextManifest,
        fanProfile: {
          version: fanProfile.version,
          generatedAt: fanProfile.generatedAt.toISOString(),
          chars: fanProfile.body.length,
          truncated: fanProfile.truncated,
          droppedSections: fanProfile.droppedSections,
        },
      };
    }
  }

  const prompt = buildPrompt({
    feature,
    personality: persona,
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

  const gatewayBody: AiGatewayStreamBody = {
    clientRequestId: body.clientRequestId,
    feature,
    pageLabel: body.pageLabel,
    platform: body.platform,
    platformUserId: fanRef,
    conversationId: body.conversationRef,
    model: body.model ?? DEFAULT_FEATURE_MODELS[policy.modelFeature],
    reasoningEffort: body.reasoningEffort ?? DEFAULT_FEATURE_REASONING[policy.modelFeature],
    isRegeneration: body.isRegeneration ?? false,
    prompt: {
      systemBlocks: prompt.systemBlocks,
      userBlocks: prompt.userBlocks,
    },
  };
  return prepareAiGatewayStream(
    app,
    principal,
    gatewayBody,
    contextManifest !== undefined ? { contextManifest } : undefined,
  );
}
