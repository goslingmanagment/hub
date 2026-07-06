import type { AiGatewayReasoningEffort, AiGatewayStreamBody } from "@agency_hub_core/contracts";
import { findAiPersonaByKey } from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import {
  prepareAiGatewayStream,
  type PreparedAiGatewayStream,
} from "../../../services/ai-gateway.ts";
import type { AuthPrincipal } from "../../../services/auth.ts";
import { BadRequestError, NotFoundError } from "../../../services/errors.ts";
import {
  loadFanDisplayName,
  loadSpendingContext,
  loadSubscriptionContext,
  loadTranscriptContext,
} from "../context/index.ts";
import {
  buildPrompt,
  createBundledPersonalities,
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
// Registry seeds = the desktop's own per-feature defaults at the snapshot
// commit (constants.ts): model Sonnet 4.6 (fan-summary Opus 4.6),
// reasoning 'medium', quick window 100 messages.

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
  isRegeneration?: boolean;
}

interface AiFeatureDefinition {
  feature: "fast-reply";
  defaults: {
    model: string;
    reasoningEffort: AiGatewayReasoningEffort;
    messageCount: number;
  };
  includesEarnings: boolean;
}

/** Pilot registry: fast-reply end-to-end; the remaining inventory lands
 * with Stage 30 Task 4. */
export const AI_FEATURE_REGISTRY: Record<string, AiFeatureDefinition> = {
  "fast-reply": {
    feature: "fast-reply",
    defaults: {
      model: "anthropic:claude-sonnet-4-6",
      reasoningEffort: "medium",
      messageCount: 100,
    },
    includesEarnings: true,
  },
};

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
  const definition = AI_FEATURE_REGISTRY[featureKey];
  if (!definition) {
    throw new NotFoundError(`Unknown AI feature: ${featureKey}`);
  }

  // Page resolution + access control live in prepareAiGatewayStream (the
  // single gate); the context loads need the page id first, so resolve it
  // through the same lookup and let the gateway re-verify.
  const { findPageByLabel } = await import("@agency_hub_core/db");
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
    limit: body.messageCount ?? definition.defaults.messageCount,
  });
  const spending = definition.includesEarnings
    ? await loadSpendingContext(app, { pageId, fanRef })
    : null;
  const subscription = definition.includesEarnings
    ? await loadSubscriptionContext(app, { pageId, fanRef })
    : null;
  const fanDisplayName = await loadFanDisplayName(app, { pageId, fanRef });

  const prompt = buildPrompt({
    feature: definition.feature,
    personality: persona,
    transcript: transcript.transcript,
    fanSpendingData: spending?.block ?? "",
    fanSubscriptionData: subscription?.block ?? "",
    fanDisplayName,
    replyTone: body.replyTone,
    replyMode: body.replyMode,
  });

  const gatewayBody: AiGatewayStreamBody = {
    clientRequestId: body.clientRequestId,
    feature: definition.feature,
    pageLabel: body.pageLabel,
    platform: body.platform,
    platformUserId: fanRef,
    conversationId: body.conversationRef,
    model: body.model ?? definition.defaults.model,
    reasoningEffort: body.reasoningEffort ?? definition.defaults.reasoningEffort,
    isRegeneration: body.isRegeneration ?? false,
    prompt: {
      systemBlocks: prompt.systemBlocks,
      userBlocks: prompt.userBlocks,
    },
  };
  return prepareAiGatewayStream(app, principal, gatewayBody);
}
