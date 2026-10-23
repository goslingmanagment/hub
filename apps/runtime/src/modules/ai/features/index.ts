import type { z } from "zod";

import type {
  aiFeatureStreamBodySchema,
  AiFeatureAttachedRecaps,
  AiFeatureDebugInputFrame,
  AiStreamCapability,
} from "@agency_hub_core/contracts";
import { COACH_ANSWER_MAX_CHARS } from "@agency_hub_core/contracts";
import {
  findAiPersonaByKey,
  findPageByLabel,
  getFreshestUsableRecaps,
} from "@agency_hub_core/db";

import type { AppContext } from "../../../bootstrap.ts";
import {
  prepareAiGatewayStream,
  type AiFeatureContextFrameBody,
  type AiGatewayCompletionTrim,
  type AiGatewayStreamInput,
  type PreparedAiGatewayStream,
} from "../../../services/ai-gateway.ts";
import { resolveAiTranscriptMaxRows } from "../../../services/ai-transcript-depth.ts";
import { requiresAnthropicThinking } from "../../../services/ai-gateway-anthropic.ts";
import { canAccessPage, type HumanAuthPrincipal } from "../../../services/auth.ts";
import { isSplitAllOnForPage } from "../../../services/client-split-all.ts";
import {
  BadRequestError,
  NotFoundError,
  PersonaDefinitionChangedError,
  ProductGateError,
  UnknownAiFeatureError,
} from "../../../services/errors.ts";
import { loadEffectiveConfig } from "../../../services/effective-config.ts";
import { checkVoiceLanePage, isVoiceLanePlatform } from "../../../services/voice-lane.ts";
import { resolveVoiceScriptMaxChars } from "../../../services/voice-script-validation.ts";
import { platformHasLiveOverlay } from "@agency_hub_core/shared";
import { notesTrimPass } from "../notes-trim.ts";
import { isPromptDebugEchoEnabled } from "../prompt-debug-echo.ts";
import { aiPersonaDefinitionId } from "../persona-definition.ts";
import { personaLocalTime } from "../persona-local-time.ts";
import {
  applyFanslyArchiveMediaNotes,
  applyOnlyFansMediaNotes,
  listOnlyFansMediaNoteItems,
  loadFanslyMediaNoteItems,
  loadMediaNoteDescriptions,
  mediaNoteLimitsFor,
  renderFanslyMediaNotes,
  requestMediaDescriptionsInBackground,
  resolveMediaNotesGate,
  type MediaNoteDescription,
  type MediaNoteItem,
  type MediaNotesGate,
  type MediaNotesManifest,
  AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT,
  AI_LIVE_TEXT_SHARED_FEATURES,
  applyLivePpvContext,
  applyLiveTextContext,
  assertHiStartProofRequestShape,
  labelledLiveImages,
  liveImageLabels,
  liveImagesGuide,
  prepareLiveImages,
  type LiveImageAttachment,
  type LiveImagesManifest,
  assertLiveImagesRequestShape,
  assertLivePpvRequestShape,
  assertLiveTextRequestShape,
  chatUnavailableTranscriptNote,
  checkAiConversationPair,
  computePingSummary,
  findOnlyFansAutomatedMessageIds,
  hiStartProofManifestOf,
  isFanProfileFeatureEnabled,
  loadAiContextFrameBody,
  loadFanBio,
  loadFanDisplayName,
  loadFanProfileContext,
  markAutomatedMessages,
  fanslyClientPurchasesOf,
  isAiLivePpvAttachmentItem,
  loadFanslyAutomationInput,
  loadFanslySpendingContext,
  loadFanslySubscriptionContext,
  loadSpendingContext,
  loadSubscriptionContext,
  loadTranscriptContext,
  loadFanslyFanIdentity,
  readAiChatAccess,
  resolveLiveTextEnabled,
  readsTranscriptCoverage,
  resolveFanslyTranscriptCoverage,
  transcriptMessagesOmittedByBudget,
  type AiTranscriptLiveOverlay,
  type AiTranscriptUnionMode,
  type AppliedLiveText,
  type FanProfilePromptContext,
  type FanslyTranscriptCoverageManifest,
  type HubTranscriptCoverage,
  type TranscriptContext,
} from "../context/index.ts";
import {
  DEFAULT_FEATURE_MODELS,
  DEFAULT_FEATURE_REASONING,
  OPERATION_REASONING_OVERRIDES,
  DEFAULT_MESSAGE_COUNT_BY_BUCKET,
  FEATURE_POLICIES,
  BUNDLED_LORA_PERSONALITY_ID,
  COACH_PRESET_DRAFT_BLOCKS,
  buildPrompt,
  describeCoachSplitOutput,
  describeSplitOutput,
  formatTranscript,
  isOperationFeature,
  type GreetingVariantCount,
  type OperationFeature,
  type Personality,
  type PingSegment,
  type PromptClock,
  type RecapAttach,
  type TranscriptMessage,
} from "../prompts/index.ts";

// Feature services. Prompt assembly moves kernel-side:
// context loads from the kernel's own stores, the MIGRATED builder
// assembles byte-identical prompts, and the stream rides the gateway
// internals (budgets, ledger, restricted capture, generation refs). No
// client cuts over here — the kernel becomes ABLE to serve them.
//
// The registry is DERIVED from the migrated FEATURE_POLICIES — one source
// of truth for prompt behavior, model delegation, earnings inclusion,
// window buckets, and the desktop's product gates (draft required,
// deep-feature and Ping minimums, ping segment analysis).

// The service consumes the parsed HTTP body; the contract owns its shape.
export type AiFeatureRequestBody = z.infer<typeof aiFeatureStreamBodySchema>;

/** Whose clock the transcript's times are in, for the prompt's `Now:` line.
 * The hub renders its own transcript in UTC with day lines; a client's text
 * is UTC when the client says so (`clientContext.transcriptClock`, fansly-chat
 * E168), else in the clock of the device that wrote it. */
export function promptTranscriptClock(
  body: Pick<AiFeatureRequestBody, "clientContext">,
): PromptClock["transcript"] {
  if (!body.clientContext) {
    return "utc";
  }
  return body.clientContext.transcriptClock === "utc" ? "utc" : "client";
}

/** One hi-greeting feature with an explicit variant count instead
 * of a mode. An explicit variantCount always wins; the deprecated greetingMode
 * alias implies one message for the released clients that still send it; a
 * request with neither is the chat Hi button and gets three variants. */
export function resolveGreetingVariantCount(
  body: Pick<AiFeatureRequestBody, "variantCount" | "greetingMode">,
): GreetingVariantCount {
  return body.variantCount ?? (body.greetingMode === "new-follower" ? 1 : 3);
}

/** Request-shape rules for the greeting parameters. Pure, so the rules are
 * unit-testable without a database. `isFanslyRequest` comes from the caller.
 *
 * The deprecated alias keeps its validations verbatim for the
 * clients that still send it. Everything else (variantCount, the personal
 * count, avatar, username) is orthogonal and belongs to the hi-greeting
 * FEATURE, not to the mode: a stray one on any other feature is
 * refused so it can never silently reshape that feature's prompt or gate. */
export function assertGreetingRequestShape(
  feature: OperationFeature,
  body: Pick<AiFeatureRequestBody, "conversationRef" | "fanRef" | "variantCount" | "greetingMode" | "clientContext">,
  isFanslyRequest: boolean,
): void {
  if (body.greetingMode !== undefined) {
    if (feature !== "hi-greeting" || !body.fanRef || body.fanRef !== body.conversationRef) {
      throw new BadRequestError("new-follower mode requires hi-greeting and matching conversationRef and fanRef");
    }
    if (isFanslyRequest && !body.clientContext) {
      throw new BadRequestError("Fansly new-follower mode requires clientContext");
    }
    if (!isFanslyRequest && !/^[1-9]\d{0,29}$/.test(body.fanRef)) {
      throw new BadRequestError("OnlyFans new-follower mode requires a canonical positive numeric fanRef");
    }
    // OnlyFans follows the kernel-context path. The alias changes the default
    // variant count, never who may supply OF context.
  }
  // The personal count rides on Hi (the released clients still send it) and
  // on Ping, whose minimum counts it (PING_MIN_MESSAGES).
  if (
    feature !== "hi-greeting" && feature !== "ping"
    && body.clientContext?.personalMessageCount !== undefined
  ) {
    throw new BadRequestError(`${feature} does not accept clientContext.personalMessageCount`);
  }
  if (feature !== "hi-greeting") {
    if (body.variantCount !== undefined) {
      throw new BadRequestError(`${feature} does not accept variantCount`);
    }
    if (body.clientContext?.fanAvatarUrl !== undefined || body.clientContext?.fanUsername !== undefined) {
      throw new BadRequestError("fanAvatarUrl and fanUsername require hi-greeting");
    }
  }
}

/** fan-notes-fill (the Fansly notes panel's «fill with AI»): the questionnaire
 * labels are the whole task, so the feature REQUIRES `noteFields`, and every
 * other feature REFUSES them, so a stray list can never reshape a Reply or a
 * Recap prompt. The current values (`noteValues`, merge mode) are optional on
 * fan-notes-fill, one per label, so they never pair a value with the wrong
 * label; every other feature refuses them too. The lists' own rules (count,
 * length, characters, repeats) are the contract's. Pure, like the greeting
 * rules above. */
export function assertNoteFieldsRequestShape(
  feature: OperationFeature,
  body: Pick<AiFeatureRequestBody, "noteFields" | "noteValues">,
): void {
  if (feature === "fan-notes-fill") {
    if (body.noteFields === undefined || body.noteFields.length === 0) {
      throw new BadRequestError("fan-notes-fill requires noteFields");
    }
    if (body.noteValues !== undefined && body.noteValues.length !== body.noteFields.length) {
      throw new BadRequestError("noteValues must hold exactly one value per noteFields label");
    }
    return;
  }
  if (body.noteFields !== undefined) {
    throw new BadRequestError(`${feature} does not accept noteFields`);
  }
  if (body.noteValues !== undefined) {
    throw new BadRequestError(`${feature} does not accept noteValues`);
  }
}

/** The message minimum of a feature (`gate_min_messages`; Review and the full
 * Recap 30, Ping 10). It counts PERSONAL messages when the client reports
 * them — `clientContext.personalMessageCount`, accepted on Hi and Ping only
 * (the released Fansly extension's count of its window: fan messages and the
 * model's own, no welcome or mass sends) — and every message of the
 * transcript otherwise. Hi has no count limit (owner, 2026-10-21). */
export function assertMinMessages(
  feature: OperationFeature,
  body: Pick<AiFeatureRequestBody, "clientContext">,
  messageCount: number,
): void {
  const minMessages = FEATURE_POLICIES[feature].minMessages;
  const personalMessageCount = body.clientContext?.personalMessageCount;
  if (minMessages > 0 && (personalMessageCount ?? messageCount) < minMessages) {
    throw new ProductGateError(
      `${feature} requires at least ${minMessages} ${
        personalMessageCount !== undefined ? "personal messages" : "messages"
      } in the conversation`,
      "gate_min_messages",
    );
  }
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

// Fan-summary short variant (Task 8): the compact recap is deliberately capped
// so it stays cheap and terse — the cap reaches the provider on the gateway
// body (input.maxTokens ?? tuning.maxTokens, honored by both providers).
const SHORT_SUMMARY_MAX_TOKENS = 2048;
// Mandatory-thinking models need room for reasoning as well as the compact
// answer. This total cap is sent to both the provider and the quota estimator.
const SHORT_SUMMARY_THINKING_MAX_TOKENS = 4096;

// Short recap also bounds its INPUT window: the compact template promises the
// model "300 recent messages max are provided", so the archive lane must not
// pull the deep default (1500) — or a caller-supplied messageCount up to the
// 5000 schema max — under short mode. Only clamps DOWN; a smaller request wins.
const SHORT_SUMMARY_MESSAGE_COUNT = 300;

/**
 * The order the voice-script gate answers the voice-notes lane's refusals in
 * (voice-lane.ts), the profile last. The platform is checked before, ahead of
 * the identity check; the switch and the allowlist share one code.
 */
const VOICE_SCRIPT_LANE_ORDER = ["disabled", "not_allowlisted", "provider"] as const;

function voiceScriptLaneRefusal(
  refusal: (typeof VOICE_SCRIPT_LANE_ORDER)[number] | "no_profile",
): ProductGateError {
  switch (refusal) {
    case "disabled":
    case "not_allowlisted":
      return new ProductGateError(
        "voice-script is unavailable: the voice-notes lane is disabled for this page",
        "gate_voice_disabled",
      );
    case "provider":
      return new ProductGateError(
        "voice-script is unavailable: the voice synthesis provider is not configured",
        "gate_voice_provider_unavailable",
      );
    case "no_profile":
      return new ProductGateError(
        "voice-script is unavailable: this page has no voice profile",
        "gate_voice_no_profile",
      );
  }
}

/** The Help button became a coach preset turn. The canonical
 * question is kernel-side so prompt text never lives in clients (E3). Must
 * stay <=2000 chars: it replays through coachHistory[].question. */
const COACH_PRESET_QUESTIONS = {
  situation:
    "Разбери текущую ситуацию в переписке: что происходит у фана, что я упускаю и какой следующий ход. Дай два готовых варианта следующего сообщения: первый спокойный и тёплый, второй более флиртовый и эскалирующий.",
} as const;

export async function prepareAiFeatureStream(
  app: AppContext,
  principal: HumanAuthPrincipal,
  featureKey: string,
  body: AiFeatureRequestBody,
  options?: {
    debugPromptEcho?: boolean;
    /** Parsed `x-kernel-ai-capabilities` of the request (empty when absent). */
    capabilities?: ReadonlySet<AiStreamCapability>;
  },
): Promise<PreparedAiGatewayStream> {
  if (!(featureKey in FEATURE_POLICIES) || !isOperationFeature(featureKey as never)) {
    throw new UnknownAiFeatureError(`Unknown AI feature: ${featureKey}`);
  }
  const feature = featureKey as OperationFeature;
  const policy = FEATURE_POLICIES[feature];
  // Fansly's conversationRef is the canonical groupId, NOT the fan — the
  // fan-erasure reachability fix keys off this in two spots (the coach-chat /
  // short-fan-summary fanRef gate and the persisted fan_ref fallback). The
  // access check below guarantees body.platform matches stored.page.platform.
  const isFanslyRequest = body.platform === "fansly";

  if (policy.requiresDraft && !body.draftText?.trim()) {
    throw new ProductGateError(`${feature} requires draftText`, "gate_draft_required");
  }

  // Coach feature isolation (spec §7): coach-chat REQUIRES a question; every
  // other feature REFUSES the coach fields so a stray field can never silently
  // reshape a Reply/Ping/Summary prompt. The summaryMode toggle is likewise
  // fan-summary-only. There is deliberately NO aggregate-chars reject (option
  // "c"): per-entry answers are transport-bounded by COACH_ANSWER_MAX_CHARS in
  // the schema (and by the identical live-stream ceiling below), and prompt cost
  // is bounded by core's ≤10k per-entry replay projection plus the newest-first
  // 60k history budget in the prompt builder — a schema-valid client that trims
  // to its window setting must never be rejected.
  if (feature === "coach-chat") {
    if (body.preset !== undefined) {
      if (body.chatterQuestion?.trim()) {
        throw new BadRequestError("coach-chat preset forbids chatterQuestion");
      }
    } else if (!body.chatterQuestion?.trim()) {
      throw new BadRequestError("coach-chat requires chatterQuestion");
    }
  } else if (
    body.chatterQuestion !== undefined
    || body.coachHistory !== undefined
    || body.preset !== undefined
  ) {
    throw new BadRequestError(`${feature} does not accept coach fields`);
  }
  const effectiveChatterQuestion = feature === "coach-chat"
    ? body.preset !== undefined
      ? COACH_PRESET_QUESTIONS[body.preset]
      : body.chatterQuestion
    : undefined;
  const presetQuestion = feature === "coach-chat" && body.preset !== undefined
    ? effectiveChatterQuestion
    : undefined;
  if (body.summaryMode !== undefined && feature !== "fan-summary") {
    throw new BadRequestError(`${feature} does not accept summaryMode`);
  }
  assertNoteFieldsRequestShape(feature, body);
  // Blocker 2 / P1-1 (fan-erasure reachability): on Fansly the conversationRef is
  // the canonical groupId, NOT the fan — so a restricted row keyed only by
  // conversation_ref survives fan-scope erasure. REQUIRE the explicit fanRef on
  // the writer paths that NEW clients drive: coach-chat AND short fan-summary
  // (the short recap is the canonical two-slot writer). Only new clients send
  // coachHistory/summaryMode, so tightening this breaks no released client, and
  // canonical full recaps from new clients always send fanRef per spec. The
  // residual legacy-full lane keeps the `fanRef ?? conversationRef` fallback
  // below — correct because a legacy Fansly conversationRef IS the fanAccountId.
  // (summaryMode === "short" implies feature === "fan-summary" here: the check
  // above already rejects short on any other feature.)
  if (
    isFanslyRequest
    && !body.fanRef?.trim()
    && (feature === "coach-chat" || body.summaryMode === "short")
  ) {
    throw new BadRequestError(
      "fanRef is required on fansly for coach-chat and short fan-summary",
    );
  }
  // The same erasure rule for the notes fill: its record holds the facts of one
  // fan (name, age, location), so on Fansly, where conversationRef is the
  // groupId, the record must carry the fan. A new feature: no released client
  // sends it without fanRef.
  if (isFanslyRequest && !body.fanRef?.trim() && feature === "fan-notes-fill") {
    throw new BadRequestError("fanRef is required on fansly for fan-notes-fill");
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

  // chat-extension H-4c: fresh text is refused where it can never be used
  // (the feature, beside clientContext, without the frame that answers it),
  // before any context loads. The owner's switch is not a refusal: switched
  // off, the text is ignored further down. Either platform (R20 HF-8б): where
  // fresh text exists is its flag's.
  if (body.liveTextContext !== undefined) {
    assertLiveTextRequestShape({
      feature,
      hasClientContext: body.clientContext !== undefined,
      capabilities: options?.capabilities,
    });
  }
  // chat-extension X54: the PPV state rides where the fresh text does, in its
  // platform's shape (a Fansly page's: one item per paid attachment); refused
  // before any context loads.
  if (body.livePpvContext !== undefined) {
    assertLivePpvRequestShape({
      feature,
      isFanslyPage: isFanslyRequest,
      hasClientContext: body.clientContext !== undefined,
      items: body.livePpvContext.items,
    });
  }

  // Live images ride where the fan is answered from the open chat; beside
  // clientContext only on a Fansly page (the released Fansly extension).
  // Refused before any context loads.
  if (body.liveImages !== undefined) {
    assertLiveImagesRequestShape({
      feature,
      hasClientContext: body.clientContext !== undefined,
      isFanslyPage: isFanslyRequest,
    });
  }

  // chat-extension R20 HF-9: a Fansly request whose transcript the hub loads
  // itself names the group (`conversationRef`) and the fan (`fanRef`) apart.
  // A pair the page's capture contradicts is refused (409
  // `conversation_fan_mismatch`) before any context loads; a pair the hub
  // cannot vouch for yet is served, and the manifest and the context_v1 frame
  // say `unverified`. The client-context lane (the released Fansly extension
  // sends its own transcript) is not read here: its requests are unchanged.
  const conversationPair = isFanslyRequest && body.clientContext === undefined
    ? await checkAiConversationPair(app, { pageId, conversationRef: body.conversationRef, fanRef: body.fanRef })
    : null;

  // voice-script only: the live cap on the script, stated in its prompt (the
  // render refuses a longer script, a dead end for the chatter).
  let voiceScriptMaxChars: number | undefined;
  // Voice-script is part of the voice-notes lane, which ships
  // INERT (VOICE_NOTES_ENABLED default-off). Gate this PAID generation on the
  // SAME rule the voice-notes service admits on (voice-lane.ts), so a lane
  // that does not serve the page spends no Anthropic/OpenRouter budget.
  // Checked HERE, before persona/context loads and any gateway spend, against
  // the RESOLVED page.
  if (feature === "voice-script") {
    if (!isVoiceLanePlatform(stored.page.platform)) {
      throw new ProductGateError(
        "voice-script is available only for pages of the voice-notes lane",
        "gate_voice_unsupported_platform",
      );
    }
    // The script's record carries the fan (the render's source check and the
    // fan's erasure read it), so the fan is always named. chat-extension R20
    // HF-4а: a request whose transcript the hub loads itself may name the
    // group (`conversationRef`) and the fan apart, because its pair was
    // checked above (a contradicted pair is already 409). The client-context
    // lane keeps the one form the released Fansly extension sends, the fan's
    // id as both refs, and its refusal answers as before. On OnlyFans the chat
    // id is the fan id: no pair is checked there, so both refs name the fan.
    if (
      !body.fanRef?.trim()
      || (body.conversationRef !== body.fanRef && conversationPair === null)
    ) {
      throw new ProductGateError(
        "voice-script requires matching, nonblank conversationRef and fanRef",
        "gate_voice_identity_required",
      );
    }
    const effective = await loadEffectiveConfig(app.db, app.config);
    const lane = await checkVoiceLanePage(app, effective, stored.page, VOICE_SCRIPT_LANE_ORDER);
    if (lane.refusal !== null) {
      throw voiceScriptLaneRefusal(lane.refusal);
    }
    voiceScriptMaxChars = resolveVoiceScriptMaxChars(effective);
  }

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

  assertGreetingRequestShape(feature, body, isFanslyRequest);
  // chat-extension R20 HF-5: Hi on Fansly may carry the client's proof of the
  // conversation's start and the fan's avatar at the top level. Its body
  // fields are refused everywhere else; the proof gates nothing (Hi has no
  // count limit) and only leaves its counts in the manifest.
  assertHiStartProofRequestShape({
    feature,
    isFanslyRequest,
    hasClientContext: body.clientContext !== undefined,
    capabilities: options?.capabilities,
    body,
  });
  let contextValues: {
    transcript: string;
    messageCount: number;
    fanSpendingData: string;
    fanSubscriptionData: string;
    fanDisplayName: string;
    fanBio: string | undefined;
    fanCustomName: string | undefined;
    fanUsername: string | undefined;
    pingSegment: PingSegment | undefined;
    fanSilenceDays: number | undefined;
  };
  // PR3: the per-generation transcript context manifest (kernel-context path
  // only); rides an INTERNAL argument into the gateway, never the body.
  let contextManifest: Record<string, unknown> | undefined;
  // chat-extension H-4b: the transcript the hub loaded itself, kept for the
  // `context_v1` frame. Unset on the client-context lane, which has no frame.
  // `rendered` are the messages the prompt's transcript text was built from:
  // the loader's, or the same ones with their image notes filled in.
  let kernelTranscript: { context: TranscriptContext; rendered: readonly TranscriptMessage[] } | undefined;
  // chat-extension H-4c: what the hub did with the request's fresh text. Set
  // on the kernel-context lane only (fresh text never rides with clientContext).
  let liveText: AppliedLiveText<TranscriptContext> | undefined;
  // AI media describer: image notes rendered into the transcript (one config
  // read + one indexed select, no network), and the files to ask for after.
  let mediaNotes: {
    gate: MediaNotesGate;
    items: MediaNoteItem[];
    descriptions: MediaNoteDescription[];
    conversationRef: string;
    fanRef: string | null;
    manifest: MediaNotesManifest;
  } | undefined;
  // Live images: the fan's photos that ride with this generation as images
  // (context/live-images.ts), on either lane.
  let liveImages: { attachments: LiveImageAttachment[]; manifest: LiveImagesManifest } | undefined;
  // The transcript window this generation resolves to. Short fan-summary clamps
  // DOWN to the compact template's "300 recent messages max" promise; every
  // other request keeps the per-bucket default (fan-summary deep = 1500) or a
  // caller-supplied messageCount. Computed ONCE here (P2-5) so the archive loader
  // below and the fan-summary provenance (featureParams.requestedCount) agree —
  // the recap-status reader surfaces this as the requested count on BOTH lanes.
  const resolvedMessageLimit =
    feature === "fan-summary" && body.summaryMode === "short"
      ? Math.min(SHORT_SUMMARY_MESSAGE_COUNT, body.messageCount ?? SHORT_SUMMARY_MESSAGE_COUNT)
      : body.messageCount ?? DEFAULT_MESSAGE_COUNT_BY_BUCKET[policy.messageCountBucket];
  if (body.clientContext && stored.page.platform !== "fansly") {
    // The deviation is Fansly-motivated (no webhook lane; the kernel
    // archive is pull-cadenced). OnlyFans context is kernel-fresh — accepting
    // client values there would let a bearer fabricate transcript/spend.
    throw new BadRequestError("clientContext is only accepted for fansly pages");
  }
  // Arena "vanished chat" (plan §5): whether Fansly still serves this chat to
  // the page — read once, for both lanes. An established episode ends the
  // transcript with one line (below, after both lanes); on the kernel lane it
  // also labels the hub's socket messages of the chat. A failed read never
  // fails the generation: no line, and the manifest says so.
  const chatAccess = await readAiChatAccess(app, {
    pageId,
    conversationRef: body.conversationRef,
    fanRef: body.fanRef ?? null,
    groupRef: body.clientContext?.media?.groupRef ?? null,
  });
  // The kernel lane's labelled socket messages; null on the client-context
  // lane, whose transcript the hub keeps exactly as the client sent it.
  let unconfirmedSocketMessages: number | null = null;
  // chat-extension R20 HF-7д: the coverage of a Fansly transcript the hub
  // loaded itself, for the features whose released client sends it
  // (fansly-coverage.ts). Unset everywhere else: the client's value, or none.
  let hubTranscriptCoverage: HubTranscriptCoverage | undefined;
  let hubTranscriptCoverageManifest: FanslyTranscriptCoverageManifest | undefined;
  // Live images: decoded before either lane's image notes, whose labels name
  // the photos that ride as images (`[Photo #3: attached image 1]`).
  if (body.liveImages !== undefined) {
    liveImages = await prepareLiveImages(app, { pageId, platform: stored.page.platform, images: body.liveImages });
  }
  const attachedLabels = liveImages !== undefined && liveImages.attachments.length > 0
    ? liveImageLabels(liveImages.attachments)
    : undefined;
  if (body.clientContext) {
    // Client-loaded context path. The product gates run on the
    // client-reported counts/segment — the same values the client's own
    // pre-cutover assembly gated on; the kernel cannot know them fresher
    // (its Fansly archive is pull-cadenced by design).
    const clientContext = body.clientContext;
    // Blocker 3 (P1-3/P2-8): short-recap's 300-message window IS enforced on the
    // clientContext lane — the only lane coach/short-recap ships on. The kernel
    // can't count a pre-assembled string transcript, but it already trusts
    // clientContext.messageCount for the minMessages and hi-greeting gates, so it
    // gates on the same client-asserted count here: reject a short request whose
    // window exceeds 300 so the compact template's "300 recent messages max"
    // claim holds. The archive lane below applies the kernel-counted clamp.
    if (
      feature === "fan-summary"
      && body.summaryMode === "short"
      && clientContext.messageCount > SHORT_SUMMARY_MESSAGE_COUNT
    ) {
      throw new BadRequestError(
        `fan-summary short mode provides at most ${SHORT_SUMMARY_MESSAGE_COUNT} recent messages; `
          + `clientContext.messageCount was ${clientContext.messageCount}`,
      );
    }
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
      fanCustomName: clientContext.fanCustomName,
      fanUsername: clientContext.fanUsername,
      pingSegment: policy.usesPingSegment ? clientContext.pingSegment : undefined,
      fanSilenceDays: policy.usesPingSegment ? clientContext.fanSilenceDays : undefined,
    };
    const mediaItems = clientContext.media?.items ?? [];
    if (clientContext.media && mediaItems.length > 0) {
      // Numbered labels always come back: filled when notes are active, the
      // legacy bytes when not (flag off, page not allowed, fan-summary).
      const gate = await resolveMediaNotesGate(app, {
        pageLabel: stored.page.label,
        usesImageNotes: policy.usesImageNotes,
      });
      const descriptions = gate.active
        ? await loadMediaNoteDescriptions(app, { pageId, platform: "fansly", items: mediaItems })
        : [];
      const rendered = renderFanslyMediaNotes({
        transcript: contextValues.transcript,
        items: mediaItems,
        active: gate.active,
        descriptions,
        limits: mediaNoteLimitsFor(feature),
        ...(attachedLabels !== undefined ? { attached: attachedLabels } : {}),
      });
      contextValues.transcript = rendered.transcript;
      mediaNotes = {
        gate,
        items: rendered.manifest.mismatch ? [] : mediaItems,
        descriptions,
        conversationRef: clientContext.media.groupRef,
        fanRef: body.fanRef
          ?? (body.conversationRef !== clientContext.media.groupRef ? body.conversationRef : null),
        manifest: rendered.manifest,
      };
    }
  } else {
    // PR3 (C6): an OnlyFans transcript is the archive ∪ the webhook store
    // (dm_message_archive is the OFAPI post-settle store; Fansly has no
    // webhook lane). Fansly Sync Engine step 1 (plan §7.11): a Fansly
    // transcript is the archive ∪ its socket messages the archive does not
    // hold yet. Either falls back to the archive when its read fails, and the
    // manifest says so.
    const unionMode: AiTranscriptUnionMode = stored.page.platform === "onlyfans" ? "serve" : "off";
    const liveOverlay: AiTranscriptLiveOverlay = platformHasLiveOverlay(stored.page.platform) ? "serve" : "off";
    // chat-extension H-6, R20 HF-6: the readers cap every window at 1500 rows.
    // Only the full Recap, the notes fill and Review on Fansly of a context-v1
    // client read past it: the Recap and Review where the owner raised
    // `aiTranscriptDeepMaxRows`, the notes fill to at least 3000. For every
    // other request this is undefined and nothing is read.
    const maxRows = await resolveAiTranscriptMaxRows(app, {
      feature,
      platform: stored.page.platform,
      summaryMode: body.summaryMode,
      capabilities: options?.capabilities,
    });
    // chat-extension R20 HF-7д: Hi on Fansly marks the model's welcome and
    // mass messages in its transcript as the released Fansly extension's Hi
    // does (fansly-automation.ts); the page's welcome texts are one indexed
    // read of what the catalog captured. Every other load classifies nothing.
    const fanslyAutomation = isFanslyRequest && feature === "hi-greeting"
      ? await loadFanslyAutomationInput(app, { pageId })
      : undefined;
    // chat-extension `live-ppv-fansly-v1`: on a Fansly page the client's word
    // on the paid attachments joins where the hub marks them (the loader,
    // fansly-ppv.ts), under the fresh text's flag; switched off, it is
    // ignored, as on OnlyFans.
    const fanslyClientPurchases = isFanslyRequest && body.livePpvContext !== undefined
      && await resolveLiveTextEnabled(app, stored.page)
      ? fanslyClientPurchasesOf(body.livePpvContext.items.filter(isAiLivePpvAttachmentItem))
      : undefined;
    // Uses the resolved window computed above (short fan-summary already clamped
    // DOWN to 300; every other request keeps its per-bucket default or the
    // caller-supplied messageCount).
    const loaded = await loadTranscriptContext(app, {
      pageId,
      conversationRef: body.conversationRef,
      limit: resolvedMessageLimit,
      unionMode,
      liveOverlay,
      ...(maxRows !== undefined ? { maxRows } : {}),
      chatUnavailable: chatAccess.unavailable,
      ...(fanslyAutomation !== undefined ? { fanslyAutomation } : {}),
      ...(fanslyClientPurchases !== undefined ? { fanslyClientPurchases } : {}),
    });
    // chat-extension H-4c: the request's fresh text joins AFTER the loader
    // returns, never inside it. Without fresh text (or without the page's
    // `freshText` flag) `transcript` is the loaded one; otherwise it is the
    // merged one, so everything below (the gates, the Ping analysis, the image
    // notes, the frame) reads what the model reads.
    liveText = await applyLiveTextContext(app, {
      principal,
      page: stored.page,
      conversationRef: body.conversationRef,
      feature,
      limit: resolvedMessageLimit,
      transcript: loaded,
      liveTextContext: body.liveTextContext,
    });
    // chat-extension X54: the PPV state applies to what the generation reads,
    // fresh text included, under the same flag; it scopes the generation
    // like served fresh text when it changed a mark.
    const livePpv = await applyLivePpvContext(app, {
      page: stored.page,
      transcript: liveText.transcript,
      livePpvContext: body.livePpvContext,
    });
    // A Fansly mark the client's word changed scopes the generation the same
    // way, but for the shared recap (AI_LIVE_TEXT_SHARED_FEATURES), as fresh
    // text does.
    const fanslyPpvScope = (loaded.fanslyClientPurchasesChanged ?? 0) > 0
      && !(AI_LIVE_TEXT_SHARED_FEATURES as readonly string[]).includes(feature)
      ? AI_CONTEXT_SCOPE_PRINCIPAL_DRAFT
      : undefined;
    const ppvScope = livePpv.contextScope ?? fanslyPpvScope;
    liveText = {
      ...liveText,
      transcript: livePpv.transcript,
      ...(liveText.contextScope === undefined && ppvScope !== undefined ? { contextScope: ppvScope } : {}),
    };
    const transcript = liveText.transcript;
    contextManifest = transcript.contextManifest;
    kernelTranscript = { context: transcript, rendered: transcript.messages };
    // chat-extension R20 HF-7д: on Fansly the coverage comes from the hub's
    // chain and the window it served, not from the client. OnlyFans keeps
    // what it had: no coverage on this lane.
    if (isFanslyRequest && readsTranscriptCoverage(feature)) {
      const coverage = await resolveFanslyTranscriptCoverage(app, {
        pageId,
        conversationRef: body.conversationRef,
        messages: transcript.messages,
        liveOverlay: transcript.served.source === "live_union",
      });
      hubTranscriptCoverage = coverage.value;
      hubTranscriptCoverageManifest = coverage.manifest;
    }
    // chat-extension R20 HF-7г: on Fansly the two blocks are the released
    // extension's own shape, from the ledger and the captured subscriptions
    // (context/fansly-money.ts); a deep feature also reads its months by type.
    // OnlyFans keeps its loaders and its bytes.
    const spending = !policy.includesEarnings
      ? null
      : isFanslyRequest
        ? await loadFanslySpendingContext(app, { pageId, fanRef, deep: policy.messageCountBucket === "deep" })
        : await loadSpendingContext(app, { pageId, fanRef });
    const subscription = !policy.includesEarnings
      ? null
      : isFanslyRequest
        ? await loadFanslySubscriptionContext(app, { pageId, fanRef })
        : await loadSubscriptionContext(app, { pageId, fanRef });
    // One clock for the segment and the silence; readers
    // that show the conversation call the same helper.
    const pingSummary = policy.usesPingSegment
      ? computePingSummary(transcript.messages, Date.now())
      : null;
    // chat-extension R20 HF-7б: on Fansly the hub forms the fan's identity as
    // the released extension sends it in clientContext: the name by its rule,
    // the username beside it for Hi, the page's saved name, the stored bio
    // (context/fansly-fan-identity.ts). OnlyFans keeps its loaders: one name,
    // no saved name and no username line.
    const fanslyFan = isFanslyRequest
      ? await loadFanslyFanIdentity(app, { pageId, fanRef, feature, includesFanBio: policy.includesFanBio })
      : null;
    contextValues = {
      transcript: transcript.transcript,
      messageCount: transcript.messages.length,
      fanSpendingData: spending?.block ?? "",
      fanSubscriptionData: subscription?.block ?? "",
      ...(fanslyFan !== null
        ? {
          fanDisplayName: fanslyFan.identity.fanDisplayName,
          fanBio: fanslyFan.identity.fanBio,
          fanCustomName: fanslyFan.identity.fanCustomName,
          fanUsername: fanslyFan.identity.fanUsername,
        }
        : {
          fanDisplayName: await loadFanDisplayName(app, { pageId, fanRef, platform: stored.page.platform }),
          fanBio: policy.includesFanBio
            ? await loadFanBio(app, { fanRef, platform: stored.page.platform })
            : undefined,
          fanCustomName: undefined,
          fanUsername: undefined,
        }),
      pingSegment: pingSummary?.segment,
      fanSilenceDays: pingSummary?.fanSilenceDays ?? undefined,
    };
    if (fanslyFan !== null) {
      // Where the name came from and how old the hub's copies are, never the
      // values. Only on this lane: every other generation records what it did.
      contextManifest = { ...(contextManifest ?? {}), fanIdentity: fanslyFan.manifest };
    }
    // Image notes on OnlyFans: the hub builds the labels itself, so the
    // inactive path leaves the migrated normalizer's bytes untouched.
    const ofItems = listOnlyFansMediaNoteItems(transcript.messages, transcript.mediaByMessage);
    if (ofItems.length > 0) {
      const gate = await resolveMediaNotesGate(app, {
        pageLabel: stored.page.label,
        usesImageNotes: policy.usesImageNotes,
      });
      if (gate.active) {
        const descriptions = await loadMediaNoteDescriptions(app, { pageId, platform: "onlyfans", items: ofItems });
        const applied = applyOnlyFansMediaNotes({
          messages: transcript.messages,
          items: ofItems,
          descriptions,
          limits: mediaNoteLimitsFor(feature),
          ...(attachedLabels !== undefined ? { attached: attachedLabels } : {}),
        });
        if (!applied.manifest.mismatch) {
          contextValues.transcript = formatTranscript(applied.messages);
          kernelTranscript.rendered = applied.messages;
        }
        mediaNotes = {
          gate,
          items: applied.manifest.mismatch ? [] : ofItems,
          descriptions,
          conversationRef: body.conversationRef,
          fanRef,
          manifest: applied.manifest,
        };
      }
    }
    // Image notes on Fansly (regression №2 of the 2026-10-20 audit): the hub
    // numbers the media of the transcript it loaded itself as the Fansly
    // extension numbers them in clientContext.media, and only while notes are
    // active, so the inactive path keeps the loader's bytes.
    if (isFanslyRequest && transcript.fanslyMedia !== undefined) {
      const gate = await resolveMediaNotesGate(app, {
        pageLabel: stored.page.label,
        usesImageNotes: policy.usesImageNotes,
      });
      const items = gate.active
        ? await loadFanslyMediaNoteItems(app, { pageId, messages: transcript.messages, served: transcript.fanslyMedia })
        : [];
      if (items.length > 0) {
        const descriptions = await loadMediaNoteDescriptions(app, { pageId, platform: "fansly", items });
        const applied = applyFanslyArchiveMediaNotes({
          messages: transcript.messages,
          items,
          descriptions,
          limits: mediaNoteLimitsFor(feature),
          ...(attachedLabels !== undefined ? { attached: attachedLabels } : {}),
        });
        if (!applied.manifest.mismatch) {
          contextValues.transcript = formatTranscript(applied.messages);
          kernelTranscript.rendered = applied.messages;
        }
        mediaNotes = {
          gate,
          items: applied.manifest.mismatch ? [] : items,
          descriptions,
          // Fansly's conversationRef is the groupId: the fan is only the
          // request's own fanRef (the thread check runs on it).
          conversationRef: body.conversationRef,
          fanRef: body.fanRef ?? null,
          manifest: applied.manifest,
        };
      }
    }
    // Hi: the welcome and mass messages the loader could not mark
    // (context/automated-marks.ts), after the image notes, so the mark comes
    // first on the line as the loader puts it and the notes' numbering never
    // sees it.
    if (feature === "hi-greeting") {
      const automatedIds = isFanslyRequest
        ? new Set(body.startProof?.automatedIds ?? [])
        : await findOnlyFansAutomatedMessageIds(app, { pageId, messages: kernelTranscript.rendered });
      const marks = markAutomatedMessages(kernelTranscript.rendered, automatedIds);
      if (marks.marked > 0) {
        contextValues.transcript = formatTranscript(marks.messages);
        kernelTranscript.rendered = marks.messages;
        contextManifest = {
          ...(contextManifest ?? {}),
          automatedMarks: { source: isFanslyRequest ? "start-proof" : "repeated-text", marked: marks.marked },
        };
      }
    }
    unconfirmedSocketMessages = transcript.unconfirmedSocketMessages;
  }
  // The images follow the conversation, on either lane: the lines after it say
  // which is which, by its label where the conversation shows one, else by its
  // time.
  if (liveImages !== undefined && liveImages.attachments.length > 0) {
    const shown = labelledLiveImages(mediaNotes, attachedLabels);
    liveImages.manifest.labelled = shown.size;
    contextValues.transcript += liveImagesGuide(liveImages.attachments, shown);
  }
  // Arena "vanished chat" (plan §5), both lanes: a chat Fansly no longer
  // serves to the page says so after its transcript, whichever step rendered
  // it last. The client's own transcript is appended to, never relabelled.
  // Manifest keys only then (or on a failed read), so every other generation
  // records what it did before.
  if (chatAccess.unavailable) {
    contextValues.transcript += chatUnavailableTranscriptNote({ unconfirmed: unconfirmedSocketMessages });
    contextManifest = {
      ...(contextManifest ?? {}),
      chatAccess: { state: "established", unconfirmed: unconfirmedSocketMessages },
    };
  } else if (chatAccess.error) {
    contextManifest = { ...(contextManifest ?? {}), chatAccessError: true };
  }
  if (mediaNotes) {
    contextManifest = { ...(contextManifest ?? {}), mediaNotes: mediaNotes.manifest };
  }
  if (liveImages) {
    contextManifest = { ...(contextManifest ?? {}), liveImages: liveImages.manifest };
  }
  if (conversationPair !== null) {
    contextManifest = { ...(contextManifest ?? {}), conversationPair };
  }

  // Desktop product gates, carried (CG-FLOW-03), and Ping's minimum.
  assertMinMessages(feature, body, contextValues.messageCount);
  if (feature === "hi-greeting" && body.startProof !== undefined) {
    contextManifest = { ...(contextManifest ?? {}), hiStartProof: hiStartProofManifestOf(body.startProof) };
  }
  // Ping is manual outreach at the chatter's discretion on both platforms (OnlyFans since #295, Fansly since the owner,
  // 2026-10-22): a fan who wrote within five days is no refusal. The real segment still goes to the prompt.

  // Policy-enabled features read the stored fan dossier (the
  // Scan profile the clients push to fan_profiles) into their prompt. The
  // dossier is optional enrichment and STRICTLY fail-open — on the Fansly
  // clientContext path this is the only fans-table read of the generation, so
  // a fan_profiles hiccup must degrade to "no section", never to a failed
  // Reply/Ping. The runtime allowlist is the no-deploy rollback switch.
  let fanProfile: FanProfilePromptContext | undefined;
  /** The switch let this feature read the dossier and the lookup answered, with one or without. */
  let dossierRead = false;
  // The chatter unticked «с Recap» for this chat (chat-extension, `recap-off-v1`): no dossier, no attached recaps.
  const recapOff = body.recap === "off";
  if (recapOff && (policy.usesFanProfile || feature === "coach-chat")) {
    contextManifest = { ...(contextManifest ?? {}), recapOff: true };
  }
  if (policy.usesFanProfile && !recapOff) {
    try {
      const effective = await loadEffectiveConfig(app.db, app.config);
      if (isFanProfileFeatureEnabled(effective.chatMuseAiFanProfileContextFeatures, feature)) {
        fanProfile = await loadFanProfileContext(app, {
          pageId,
          fanRef,
          platform: stored.page.platform,
          now: Date.now(),
          feature,
        });
        dossierRead = true;
      }
    } catch (error) {
      app.logger.warn({ feature, pageId, error }, "ai feature dossier lookup failed");
    }
  }
  if (fanProfile) {
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

  // Two-slot recap attach (spec §5): coach-chat pulls the freshest usable full
  // and short fan-summary recaps for this conversation and dates them into the
  // prompt. Fail-open like the dossier — a recap-lookup hiccup degrades to "no
  // recaps", never to a failed coach answer.
  let recapAttach: RecapAttach | undefined;
  let attachedRecaps: AiFeatureAttachedRecaps | undefined;
  if (feature === "coach-chat") {
    attachedRecaps = { full: null, short: null };
  }
  if (feature === "coach-chat" && !recapOff) {
    try {
      const conversationRefs = [
        body.conversationRef,
        ...(body.fanRef ? [body.fanRef] : []),
      ];
      // R20 HF-10: with a pair the hub checked (HF-9: a Fansly request whose
      // transcript the hub loads itself), only the recaps stored about its fan,
      // as the client's recaps read selects them for the same pair. Every other
      // request attaches what it did before.
      const pairFanRef = conversationPair !== null ? body.fanRef ?? undefined : undefined;
      const found = await getFreshestUsableRecaps(app.db, {
        pageId,
        conversationRefs,
        personaDefinitionId: persona.definitionId,
        ...(pairFanRef !== undefined ? { fanRef: pairFanRef } : {}),
      });
      const fullAt = found.full?.createdAt?.getTime() ?? null;
      const shortAt = found.short?.createdAt?.getTime() ?? null;
      const now = Date.now();
      // Attach rule (spec §5): the full recap is attached whenever present; the
      // short recap only when it is strictly newer than the full (an older short
      // adds nothing the fuller, fresher recap does not already carry).
      recapAttach = {
        full: found.full
          ? { body: found.full.completion, ageMs: Math.max(0, now - fullAt!) }
          : null,
        short:
          found.short && (fullAt === null || shortAt! > fullAt)
            ? { body: found.short.completion, ageMs: Math.max(0, now - shortAt!) }
            : null,
      };
      // Dossier dedupe (P2-10): when the injected dossier came from the same
      // summary as the full recap, keep the dated dossier section and drop the
      // duplicate recap. Compare the RAW dossier body against the raw recap
      // completion — the compiled body drops the financial section (and can shed
      // others), so comparing compiled-vs-raw would almost never match on a real
      // sectioned summary and the recap would double up. Fail-open: any lookup
      // hiccup already degrades to "no recaps" in the surrounding catch.
      if (recapAttach.full && fanProfile?.rawBody === recapAttach.full.body) {
        recapAttach.full = null;
      }
      attachedRecaps = {
        full: recapAttach.full && found.full
          ? {
            generatedAt: found.full.createdAt.toISOString(),
            ageMs: recapAttach.full.ageMs,
          }
          : null,
        short: recapAttach.short && found.short
          ? {
            generatedAt: found.short.createdAt.toISOString(),
            ageMs: recapAttach.short.ageMs,
          }
          : null,
      };
      contextManifest = {
        ...(contextManifest ?? {}),
        recapAttach: {
          full: recapAttach.full ? fullAt : null,
          short: recapAttach.short ? shortAt : null,
        },
      };
    } catch (error) {
      app.logger.warn({ err: error }, "coach-chat recap attach failed open");
      contextManifest = {
        ...(contextManifest ?? {}),
        recapAttach: { lookupFailed: true },
      };
    }
  }

  // What a Reply or a Ping stood on, told to the client the way a Coach answer's Recaps are (the meta frame's
  // `attachedRecaps`; chat-extension says «с Recap от …» under the answer): the stored dossier is the latest saved
  // full Recap, dated by its generation. Absent — the switch keeps this feature off the dossier, or the lookup failed:
  // nothing is claimed; `full: null` — the fan has none, or the chatter switched the Recap off.
  if (recapOff && policy.usesFanProfile && feature !== "coach-chat") {
    attachedRecaps = { full: null, short: null };
  }
  if (dossierRead && feature !== "coach-chat") {
    attachedRecaps = {
      full: fanProfile
        ? { generatedAt: fanProfile.generatedAt.toISOString(), ageMs: Math.max(0, Date.now() - fanProfile.generatedAt.getTime()) }
        : null,
      short: null,
    };
  }

  // chat-extension H-10 (architecture.md D-15): Split for Ping, Hi and the
  // drafts of a Coach answer. On only for a request that advertises
  // split-all-v1, on a page whose owner switched the splitAll flag on.
  // replyMode alone never turns it on: released clients send it on every
  // feature and keep their prompts.
  const splitAll = policy.supportsSplitAll
    && body.replyMode === "preferSplit"
    && options?.capabilities?.has("split-all-v1") === true
    && await isSplitAllOnForPage(app, pageId);
  const greetingVariantCount = feature === "hi-greeting" ? resolveGreetingVariantCount(body) : undefined;
  // One clock for every build of this prompt: the `Now:` line of the uncached
  // task block.
  const clock: PromptClock = {
    nowMs: app.aiPromptClock?.() ?? Date.now(),
    transcript: promptTranscriptClock(body),
    modelLocal: personaLocalTime(persona.personality.id),
  };

  // The transcript's media labels are numbered: the template explains them.
  const mediaNotesGuide = mediaNotes !== undefined
    && mediaNotes.gate.active
    && mediaNotes.items.length > 0
    && !mediaNotes.manifest.mismatch;
  const buildFeaturePrompt = (transcriptCoverage: HubTranscriptCoverage | undefined) => buildPrompt({
    feature,
    personality: persona.personality,
    platform: body.platform,
    transcript: contextValues.transcript,
    fanSpendingData: contextValues.fanSpendingData,
    fanSubscriptionData: contextValues.fanSubscriptionData,
    fanDisplayName: contextValues.fanDisplayName,
    fanBio: contextValues.fanBio,
    fanCustomName: contextValues.fanCustomName,
    fanUsername: contextValues.fanUsername,
    greetingVariantCount,
    fanProfile: fanProfile
      ? { body: fanProfile.body, generatedAt: fanProfile.generatedAt }
      : undefined,
    draftText: body.draftText,
    pingSegment: contextValues.pingSegment,
    fanSilenceDays: contextValues.fanSilenceDays,
    replyTone: policy.supportsReplyTone ? body.replyTone : undefined,
    replyMode: policy.supportsReplyMode || splitAll ? body.replyMode : undefined,
    splitAll,
    chatterQuestion: effectiveChatterQuestion,
    coachHistory: feature === "coach-chat" ? body.coachHistory : undefined,
    preset: feature === "coach-chat" ? body.preset : undefined,
    recapAttach,
    transcriptCoverage:
      feature === "coach-chat" || feature === "fan-summary" || feature === "fan-notes-fill"
        ? body.clientContext?.transcriptCoverage ?? transcriptCoverage
        : undefined,
    summaryMode: feature === "fan-summary" ? body.summaryMode : undefined,
    noteFields: feature === "fan-notes-fill" ? body.noteFields : undefined,
    noteValues: feature === "fan-notes-fill" ? body.noteValues : undefined,
    voiceScriptMaxChars,
    mediaNotesGuide,
    clock,
  });
  let prompt = buildFeaturePrompt(hubTranscriptCoverage);
  if (hubTranscriptCoverageManifest !== undefined) {
    // chat-extension R20 HF-7д: the Coach budget cut the oldest lines of the
    // hub's transcript, so the model reads less than the hub holds: the note
    // says `window`, as the released client's does after its own cut.
    if (hubTranscriptCoverage !== "window" && (prompt.coachTranscriptOmittedChars ?? 0) > 0) {
      hubTranscriptCoverage = "window";
      prompt = buildFeaturePrompt(hubTranscriptCoverage);
      hubTranscriptCoverageManifest = { ...hubTranscriptCoverageManifest, value: "window", promptBudgetCut: true };
    }
    contextManifest = { ...(contextManifest ?? {}), transcriptCoverage: hubTranscriptCoverageManifest };
  }

  // The whole-Coach prompt budget may shed a recap after repository selection.
  // Metadata must describe what the provider actually receives, not the
  // pre-budget candidates. The builder reports exact final wrapper presence;
  // fan-derived wrappers cannot spoof it because prompt values are escaped.
  if (attachedRecaps && prompt.coachRecapSlots) {
    attachedRecaps = {
      full: prompt.coachRecapSlots.full ? attachedRecaps.full : null,
      short: prompt.coachRecapSlots.short ? attachedRecaps.short : null,
    };
    const recapManifest = contextManifest?.["recapAttach"];
    if (
      typeof recapManifest === "object"
      && recapManifest !== null
      && ("full" in recapManifest || "short" in recapManifest)
    ) {
      const slots = recapManifest as Record<string, unknown>;
      contextManifest = {
        ...(contextManifest ?? {}),
        recapAttach: {
          ...slots,
          full: prompt.coachRecapSlots.full ? slots["full"] : null,
          short: prompt.coachRecapSlots.short ? slots["short"] : null,
        },
      };
    }
  }
  // The same what-the-provider-actually-received rule for the DOSSIER (review
  // round 6): the pre-build fanProfile manifest entry claims injection, but the
  // coach reducer may shed the dossier (e.g. displaced by a kept draft) — record
  // the post-budget truth exactly like the recap slots above.
  if (feature === "coach-chat" && prompt.coachDossierIncluded !== undefined) {
    const fanProfileManifest = contextManifest?.["fanProfile"];
    if (typeof fanProfileManifest === "object" && fanProfileManifest !== null) {
      contextManifest = {
        ...(contextManifest ?? {}),
        fanProfile: {
          ...(fanProfileManifest as Record<string, unknown>),
          included: prompt.coachDossierIncluded,
        },
      };
    }
  }
  if (fanProfile) {
    // debug, not info — fast-reply is high-frequency; never log the body.
    // Logged POST-budget (review round 8) so the log and the manifest cannot
    // contradict each other about the same generation.
    app.logger.debug({
      feature,
      pageId,
      profileVersion: fanProfile.version,
      profileAgeDays: fanProfile.ageDays,
      profileChars: fanProfile.body.length,
      truncated: fanProfile.truncated,
      droppedSections: fanProfile.droppedSections,
      ...(feature === "coach-chat"
        ? { included: prompt.coachDossierIncluded === true }
        : {}),
    }, feature === "coach-chat" && prompt.coachDossierIncluded !== true
      ? "ai feature dossier omitted by prompt budget"
      : "ai feature dossier injected");
  }
  // The same what-the-provider-actually-received rule for the chatter draft: a
  // supplied draft the coach budget reducer shed leaves an audit trace (its
  // chars and final inclusion), like the recaps and the dossier above. Additive
  // manifest key — no contract change, no client re-vendor.
  if (feature === "coach-chat" && typeof body.draftText === "string" && body.draftText.trim() !== "") {
    contextManifest = {
      ...(contextManifest ?? {}),
      chatterDraft: {
        chars: body.draftText.length,
        included: prompt.coachDraftIncluded === true,
      },
    };
  }

  const model = body.model ?? DEFAULT_FEATURE_MODELS[policy.modelFeature];
  // The fan's avatar for Hi, as an image for the provider: the released Fansly
  // extension's inside `clientContext`, the new one's at the top level (R20
  // HF-5: only Hi on a Fansly page under `hi-start-proof-v1`, refused
  // elsewhere above). Never both, never fetched.
  const fanAvatarUrl = body.clientContext?.fanAvatarUrl ?? body.fanAvatarUrl;
  const gatewayBody: AiGatewayStreamInput = {
    clientRequestId: body.clientRequestId,
    feature,
    pageLabel: body.pageLabel,
    platform: body.platform,
    platformUserId: fanRef,
    conversationId: body.conversationRef,
    // Off-wire: the fan this generation is ABOUT, stored as the restricted
    // record's fan_ref so fan-scope erasure reaches coach/recap rows whose
    // conversation_ref is the canonical Fansly groupId (spec §5). Round-4 P1-3
    // dropped the old `isFanslyRequest ? conversationRef` fallback: a legacy row
    // (conversationRef = fanAccountId) is ALREADY reachable through the erasure
    // predicate's conversation_ref arm, so the fallback added nothing for it —
    // while POISONING a canonical row by stamping its groupId into fan_ref (a
    // non-fan id the erasure of some OTHER fan could never match, and the erasure
    // of THIS fan already reaches via conversation_ref). Persist the real fan or
    // NULL. The gate above already REQUIRES an explicit fanRef on the canonical
    // writer paths (coach-chat / short fan-summary), so those rows always carry
    // a true fan identity.
    fanRef: body.fanRef ?? null,
    model,
    reasoningEffort: body.reasoningEffort
      ?? OPERATION_REASONING_OVERRIDES[feature]
      ?? DEFAULT_FEATURE_REASONING[policy.modelFeature],
    isRegeneration: body.isRegeneration ?? false,
    // Short recap turns thinking off where supported. Opus 5.5 uses low effort
    // and a larger total cap instead, since thinking cannot be disabled.
    ...(feature === "fan-summary" && body.summaryMode === "short"
      ? {
          maxTokens: requiresAnthropicThinking(model)
            ? SHORT_SUMMARY_THINKING_MAX_TOKENS
            : SHORT_SUMMARY_MAX_TOKENS,
          disableAdaptiveThinking: true,
        }
      : {}),
    // Coach transport ceiling (spec §3/§7, option "c"): the coach keeps its
    // adaptive 16k thinking budget (no output-token cap games), but the SSE pump
    // aborts a coach generation whose accumulated visible output crosses
    // COACH_ANSWER_MAX_CHARS — the SAME number the wire schema enforces on a
    // replayed coachHistory answer. A crossing errors without a `done` frame and
    // records a failed (never completed) outcome, so an over-ceiling answer can
    // never be attached/committed, and every committed answer replays verbatim
    // within schema. Off the wire (never on aiFeatureStreamBodySchema), coach
    // only — mirrors the featureParams / disableAdaptiveThinking pattern.
    ...(feature === "coach-chat"
      ? { visibleOutputCeilingChars: COACH_ANSWER_MAX_CHARS }
      : {}),
    // Two-slot recap selection (spec §5): only fan-summary rows carry the
    // summaryMode/persona/coverage/count provenance the recap reader filters on.
    ...(feature === "fan-summary"
      ? {
        featureParams: {
          summaryMode: body.summaryMode ?? "full",
          // Recaps are persona-scoped inputs. Persist the exact resolved
          // definition (not merely the caller-supplied key) so a later coach
          // turn cannot attach a recap generated under another revision.
          personaDefinitionId: persona.definitionId,
          // R20 HF-7д: on the Fansly lane without clientContext, the hub's own.
          transcriptCoverage: body.clientContext?.transcriptCoverage ?? hubTranscriptCoverage ?? null,
          // P2-5: provenance from the RESOLVED request window (after the short
          // clamp) and the ACTUAL kept count — populated on BOTH lanes so an
          // archive-generated recap no longer reports null through recap-status.
          // keptCount is contextValues.messageCount, which already IS the
          // client's reported count on the clientContext lane (client values
          // win where present) and the kernel-counted transcript length on the
          // archive lane.
          requestedCount: resolvedMessageLimit,
          keptCount: contextValues.messageCount,
        },
      }
      : {}),
    prompt: {
      systemBlocks: prompt.systemBlocks,
      userBlocks: prompt.userBlocks,
      ...(fanAvatarUrl ? { images: [{ url: fanAvatarUrl }] } : {}),
    },
    ...(liveImages !== undefined && liveImages.attachments.length > 0
      ? { inlineImages: liveImages.attachments.map((attachment) => attachment.image) }
      : {}),
  };
  // chat-extension H-4c: featureParams for every feature, not fan-summary
  // alone. A generation whose transcript held text only the caller's client
  // supplied is scoped, so no shared reader ever selects it. Without served
  // fresh text nothing is added and the recorded params are what they were.
  if (liveText?.contextScope !== undefined) {
    gatewayBody.featureParams = { ...gatewayBody.featureParams, contextScope: liveText.contextScope };
  }
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
          ...(fanAvatarUrl ? { images: [{ url: fanAvatarUrl }] } : {}),
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
  // chat-extension H-4b: only a caller that advertised `context-v1` gets the
  // frame (and pays its two indexed reads), so every other stream stays byte
  // for byte what it was. The page was admitted above, before any context load.
  // The same what-the-provider-actually-received rule as the recaps above: the
  // Coach budget may have cut the oldest transcript lines, and the frame's
  // window is what is left.
  let contextFrame: AiFeatureContextFrameBody | undefined;
  if (kernelTranscript && options?.capabilities?.has("context-v1")) {
    contextFrame = await loadAiContextFrameBody(app, {
      pageId,
      platform: stored.page.platform,
      conversationRef: body.conversationRef,
      served: kernelTranscript.context.served,
      messages: kernelTranscript.context.messages,
      omittedByPromptBudget: transcriptMessagesOmittedByBudget({
        transcript: contextValues.transcript,
        messages: kernelTranscript.rendered,
        omittedChars: prompt.coachTranscriptOmittedChars ?? 0,
      }),
      requestedCount: resolvedMessageLimit,
      ...(body.knownFanMessageIds !== undefined ? { knownFanMessageIds: body.knownFanMessageIds } : {}),
      // chat-extension R20 HF-8в: answered only to a caller that advertised
      // `coverage-check-v1`; anyone else gets the frame it got before.
      ...(body.coverageCheck !== undefined && options?.capabilities?.has("coverage-check-v1") === true
        ? { coverageCheck: body.coverageCheck }
        : {}),
      ...(liveText !== undefined ? { live: liveText.live } : {}),
      ...(conversationPair !== null ? { pair: conversationPair } : {}),
    });
  }
  if (mediaNotes?.gate.active && mediaNotes.gate.policy && mediaNotes.items.length > 0) {
    requestMediaDescriptionsInBackground(app, {
      pageId,
      platform: stored.page.platform,
      policy: mediaNotes.gate.policy,
      conversationRef: mediaNotes.conversationRef,
      fanRef: mediaNotes.fanRef,
      verifyThread: isFanslyRequest,
      items: mediaNotes.items,
      descriptions: mediaNotes.descriptions,
      now: new Date(),
    });
  }
  // The questionnaire fill's cut-only second pass (owner 2026-10-17): merge
  // mode only, behind its live switch, and fail-open like every enrichment
  // here — a switch lookup that fails leaves the fill as it always was.
  let trimCompletion: AiGatewayCompletionTrim | undefined;
  if (feature === "fan-notes-fill" && body.noteFields !== undefined && body.noteValues !== undefined) {
    try {
      const effective = await loadEffectiveConfig(app.db, app.config);
      if (effective.aiNotesTrimEnabled === true) {
        trimCompletion = notesTrimPass(body.noteFields, body.noteValues);
      }
    } catch (error) {
      app.logger.warn({ feature, pageId, error }, "ai notes trim switch lookup failed");
    }
  }
  return prepareAiGatewayStream(
    app,
    principal,
    gatewayBody,
    contextManifest !== undefined
      || debugFrame !== undefined
      || contextFrame !== undefined
      || body.expectedPersonaDefinitionId !== undefined
      || attachedRecaps !== undefined
      || presetQuestion !== undefined
      || splitAll
      || trimCompletion !== undefined
      ? {
        ...(contextManifest !== undefined ? { contextManifest } : {}),
        ...(debugFrame !== undefined ? { debugFrame } : {}),
        ...(contextFrame !== undefined ? { contextFrame } : {}),
        ...(body.expectedPersonaDefinitionId !== undefined
          ? { personaDefinitionId: persona.definitionId }
          : {}),
        ...(attachedRecaps !== undefined ? { attachedRecaps } : {}),
        ...(presetQuestion !== undefined ? { presetQuestion } : {}),
        // Written on the finished text only: nothing already streamed changes.
        // A Coach answer is advice with draft blocks in it, so it has its own reader.
        ...(splitAll
          ? {
            describeOutput: feature === "coach-chat"
              ? (completion: string) =>
                describeCoachSplitOutput(completion, body.preset !== undefined ? COACH_PRESET_DRAFT_BLOCKS : null)
              : (completion: string) => describeSplitOutput(completion, greetingVariantCount ?? 1),
          }
          : {}),
        ...(trimCompletion !== undefined ? { trimCompletion } : {}),
      }
      : undefined,
  );
}
