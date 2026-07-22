import type {
  AiFeatureAttachedRecaps,
  AiFeatureDebugInputFrame,
  AiGatewayReasoningEffort,
} from "@agency_hub_core/contracts";
import {
  COACH_ANSWER_MAX_CHARS,
  FAN_SILENCE_DAYS_MAX,
} from "@agency_hub_core/contracts";
import {
  findAiPersonaByKey,
  findPageByLabel,
  getFreshestUsableRecaps,
  getVoiceProfile,
} from "@agency_hub_core/db";

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
import { isPageAllowlisted } from "../../../services/voice-notes.ts";
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
  type RecapAttach,
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
    /** Whole days since the fan's last text message (same clock as pingSegment). */
    fanSilenceDays?: number;
    transcriptCoverage?: "full-history" | "window";
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

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

// Short recap also bounds its INPUT window: the compact template promises the
// model "300 recent messages max are provided", so the archive lane must not
// pull the deep default (1500) — or a caller-supplied messageCount up to the
// 3000 schema max — under short mode. Only clamps DOWN; a smaller request wins.
const SHORT_SUMMARY_MESSAGE_COUNT = 300;

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
  // Fansly's conversationRef is the canonical groupId, NOT the fan — the
  // fan-erasure reachability fix keys off this in two spots (the coach-chat /
  // short-fan-summary fanRef gate and the persisted fan_ref fallback). Computed
  // once so it is a single platform-branch site (the access check below
  // guarantees body.platform matches stored.page.platform).
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
    if (!body.chatterQuestion?.trim()) {
      throw new BadRequestError("coach-chat requires chatterQuestion");
    }
  } else if (body.chatterQuestion !== undefined || body.coachHistory !== undefined) {
    throw new BadRequestError(`${feature} does not accept coach fields`);
  }
  if (body.summaryMode !== undefined && feature !== "fan-summary") {
    throw new BadRequestError(`${feature} does not accept summaryMode`);
  }
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

  // Decision #174: voice-script is part of the voice-notes lane, which ships
  // INERT (VOICE_NOTES_ENABLED default-off). Gate this PAID generation on the
  // SAME live flag + fail-closed page allowlist the voice-notes service admits
  // on — reusing its allowlist parser — so a disabled/unlisted lane spends no
  // Anthropic/OpenRouter budget. Checked HERE, before persona/context loads and
  // any gateway spend, against the RESOLVED canonical label.
  if (feature === "voice-script") {
    if (!isFanslyRequest) {
      throw new ProductGateError(
        "voice-script is available only for Fansly pages",
        "gate_voice_unsupported_platform",
      );
    }
    if (!body.fanRef?.trim() || body.conversationRef !== body.fanRef) {
      throw new ProductGateError(
        "voice-script requires matching, nonblank conversationRef and fanRef",
        "gate_voice_identity_required",
      );
    }
    const effective = await loadEffectiveConfig(app.db, app.config);
    if (
      effective.voiceNotesEnabled !== true
      || !isPageAllowlisted(effective.voiceNotesPageAllowlist, stored.page.label)
    ) {
      throw new ProductGateError(
        "voice-script is unavailable: the voice-notes lane is disabled for this page",
        "gate_voice_disabled",
      );
    }
    if (!app.voiceTtsProvider) {
      throw new ProductGateError(
        "voice-script is unavailable: the voice synthesis provider is not configured",
        "gate_voice_provider_unavailable",
      );
    }
    if (!await getVoiceProfile(app.db, pageId)) {
      throw new ProductGateError(
        "voice-script is unavailable: this page has no voice profile",
        "gate_voice_no_profile",
      );
    }
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

  let contextValues: {
    transcript: string;
    messageCount: number;
    fanSpendingData: string;
    fanSubscriptionData: string;
    fanDisplayName: string;
    fanBio: string | undefined;
    pingSegment: PingSegment | undefined;
    fanSilenceDays: number | undefined;
  };
  // PR3: the per-generation transcript context manifest (kernel-context path
  // only); rides an INTERNAL argument into the gateway, never the body.
  let contextManifest: Record<string, unknown> | undefined;
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
      pingSegment: policy.usesPingSegment ? clientContext.pingSegment : undefined,
      fanSilenceDays: policy.usesPingSegment ? clientContext.fanSilenceDays : undefined,
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
    // Uses the resolved window computed above (short fan-summary already clamped
    // DOWN to 300; every other request keeps its per-bucket default or the
    // caller-supplied messageCount).
    const transcript = await loadTranscriptContext(app, {
      pageId,
      conversationRef: body.conversationRef,
      limit: resolvedMessageLimit,
      unionMode,
    });
    contextManifest = transcript.contextManifest;
    const spending = policy.includesEarnings
      ? await loadSpendingContext(app, { pageId, fanRef })
      : null;
    const subscription = policy.includesEarnings
      ? await loadSubscriptionContext(app, { pageId, fanRef })
      : null;
    // One analysis call and one clock feed both values. A Date.now() per field
    // could disagree exactly at the 5-day segment boundary (Decision #127).
    const pingNowMs = Date.now();
    const pingAnalysis = policy.usesPingSegment
      ? analyzePingSegment(transcript.messages, pingNowMs)
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
      pingSegment: pingAnalysis?.segment,
      fanSilenceDays: pingAnalysis && pingAnalysis.latestFanTextAtMs !== null
        ? Math.min(
            FAN_SILENCE_DAYS_MAX,
            Math.max(0, Math.floor((pingNowMs - pingAnalysis.latestFanTextAtMs) / DAY_MS)),
          )
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

  // Two-slot recap attach (spec §5): coach-chat pulls the freshest usable full
  // and short fan-summary recaps for this conversation and dates them into the
  // prompt. Fail-open like the dossier — a recap-lookup hiccup degrades to "no
  // recaps", never to a failed coach answer.
  let recapAttach: RecapAttach | undefined;
  let attachedRecaps: AiFeatureAttachedRecaps | undefined;
  if (feature === "coach-chat") {
    attachedRecaps = { full: null, short: null };
    try {
      const conversationRefs = [
        body.conversationRef,
        ...(body.fanRef ? [body.fanRef] : []),
      ];
      const found = await getFreshestUsableRecaps(app.db, {
        pageId,
        conversationRefs,
        personaDefinitionId: persona.definitionId,
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
    fanSilenceDays: contextValues.fanSilenceDays,
    replyTone: policy.supportsReplyTone ? body.replyTone : undefined,
    replyMode: policy.supportsReplyMode ? body.replyMode : undefined,
    chatterQuestion: feature === "coach-chat" ? body.chatterQuestion : undefined,
    coachHistory: feature === "coach-chat" ? body.coachHistory : undefined,
    recapAttach,
    transcriptCoverage:
      feature === "coach-chat" || feature === "fan-summary"
        ? body.clientContext?.transcriptCoverage
        : undefined,
    summaryMode: feature === "fan-summary" ? body.summaryMode : undefined,
  });

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
    model: body.model ?? DEFAULT_FEATURE_MODELS[policy.modelFeature],
    reasoningEffort: body.reasoningEffort ?? DEFAULT_FEATURE_REASONING[policy.modelFeature],
    isRegeneration: body.isRegeneration ?? false,
    // Short fan-summary caps output at 2048 tokens (Task 8); every other
    // feature leaves maxTokens unset so the provider's per-feature tuning wins.
    // disableAdaptiveThinking keeps that 2048 a PURE output budget — the default
    // fan-summary model is adaptive, and Anthropic counts summarized thinking
    // inside max_tokens, so without it the recap truncates before it finishes.
    ...(feature === "fan-summary" && body.summaryMode === "short"
      ? { maxTokens: SHORT_SUMMARY_MAX_TOKENS, disableAdaptiveThinking: true }
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
          transcriptCoverage: body.clientContext?.transcriptCoverage ?? null,
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
      || attachedRecaps !== undefined
      ? {
        ...(contextManifest !== undefined ? { contextManifest } : {}),
        ...(debugFrame !== undefined ? { debugFrame } : {}),
        ...(body.expectedPersonaDefinitionId !== undefined
          ? { personaDefinitionId: persona.definitionId }
          : {}),
        ...(attachedRecaps !== undefined ? { attachedRecaps } : {}),
      }
      : undefined,
  );
}
