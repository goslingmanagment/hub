import type { AiGatewayReasoningEffort, AiGatewayStreamBody } from "@agency_hub_core/contracts";
import { findAiPersonaByKey, findPageByLabel } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import {
  prepareAiGatewayStream,
  type PreparedAiGatewayStream,
} from "../../../services/ai-gateway.ts";
import type { AuthPrincipal } from "../../../services/auth.ts";
import { BadRequestError, NotFoundError } from "../../../services/errors.ts";
import {
  loadFanBio,
  loadFanDisplayName,
  loadSpendingContext,
  loadSubscriptionContext,
  loadTranscriptContext,
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
    throw new BadRequestError(`${feature} requires draftText`);
  }

  // Page resolution + access control live in prepareAiGatewayStream (the
  // single gate); the context loads need the page id first, so resolve it
  // through the same lookup and let the gateway re-verify.
  const stored = await findPageByLabel(app.db, body.pageLabel);
  if (!stored || stored.page.platform !== body.platform) {
    throw new NotFoundError("Page not found");
  }
  const pageId = stored.page.id;
  const fanRef = body.fanRef ?? body.conversationRef;

  const persona = await resolvePersona(app, body.personaKey);
  const transcript = await loadTranscriptContext(app, {
    pageId,
    conversationRef: body.conversationRef,
    limit: body.messageCount ?? DEFAULT_MESSAGE_COUNT_BY_BUCKET[policy.messageCountBucket],
  });

  // Desktop product gates, carried (CG-FLOW-03 and the hi-greeting lock).
  if (policy.minMessages > 0 && transcript.messages.length < policy.minMessages) {
    throw new BadRequestError(
      `${feature} requires at least ${policy.minMessages} messages in the conversation`,
    );
  }
  if (feature === "hi-greeting" && transcript.messages.length > HI_GREETING_MAX_TRANSCRIPT) {
    throw new BadRequestError(
      `hi-greeting is only available for conversations with at most ${HI_GREETING_MAX_TRANSCRIPT} messages`,
    );
  }

  const spending = policy.includesEarnings
    ? await loadSpendingContext(app, { pageId, fanRef })
    : null;
  const subscription = policy.includesEarnings
    ? await loadSubscriptionContext(app, { pageId, fanRef })
    : null;
  const fanDisplayName = await loadFanDisplayName(app, { pageId, fanRef });
  const fanBio = feature === "hi-greeting"
    ? await loadFanBio(app, { fanRef })
    : undefined;
  const pingSegment = policy.usesPingSegment
    ? analyzePingSegment(transcript.messages, Date.now()).segment
    : undefined;

  const prompt = buildPrompt({
    feature,
    personality: persona,
    transcript: transcript.transcript,
    fanSpendingData: spending?.block ?? "",
    fanSubscriptionData: subscription?.block ?? "",
    fanDisplayName,
    fanBio,
    draftText: body.draftText,
    pingSegment,
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
  return prepareAiGatewayStream(app, principal, gatewayBody);
}
