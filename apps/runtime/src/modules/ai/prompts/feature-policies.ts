// MIGRATED from chatgoose_desktop_fable
// packages/shared/src/features.ts + the per-feature parameter block of
// packages/shared/src/constants.ts @ 1db76a4ae13d (2026-07-06).
// Adapted in imports; the desktop's Settings-coupled message-count resolver
// is replaced by the kernel window defaults below (recorded deviation —
// per-feature windows become kernel config in Task 4's registry, seeded
// with the desktop defaults).

import type {
  FeatureType,
  ModelSelectableFeature,
  PromptMode,
  ReasoningEffort,
  ResultKind,
} from './types.ts';

/** Features that run as a single operation. 'compare' orchestrates fast-reply per personality card. */
export type OperationFeature = Exclude<FeatureType, 'compare'>;

export type FeatureSurface = 'ai-dock' | 'panel-tab';
export type FeatureTimeoutBucket = 'quick' | 'deep';
export type FeatureMessageCountBucket = 'quick' | 'ping' | 'improve' | 'deep' | 'hi';
/** 'regenerate' re-runs the same prompt; 'refresh' forces regeneration (drops any cache). */
export type FeatureRerunAction = 'regenerate' | 'refresh';

export interface FeaturePolicy {
  surface: FeatureSurface;
  resultKind: ResultKind;
  promptMode: PromptMode;
  timeoutBucket: FeatureTimeoutBucket;
  messageCountBucket: FeatureMessageCountBucket;
  /** Model/reasoning selection delegation (improve-draft & hi-greeting → fast-reply). */
  modelFeature: ModelSelectableFeature;
  includesEarnings: boolean;
  /** 0 = no gate; deep features require MIN_MESSAGES_FOR_DEEP (CG-FLOW-03). */
  minMessages: number;
  rerunAction: FeatureRerunAction;
  supportsReplyMode: boolean;
  /** Split by capability (chat-extension H-10, architecture.md D-15): the
   * feature takes replyMode only when the request advertises `split-all-v1` on
   * a page whose owner switched the `splitAll` flag on. Released clients send
   * replyMode on every feature, so replyMode alone never turns it on. The
   * builder's PROMPT_POLICIES carries the same flag. */
  supportsSplitAll: boolean;
  supportsReplyTone: boolean;
  requiresDraft: boolean;
  usesPingSegment: boolean;
  /** Inject the stored fan dossier (fan_profiles) into the prompt. False for
   * fan-summary (it GENERATES the dossier — feeding it back is circular),
   * chat-review (must judge the chatter independently of a stored opinion)
   * and hi-greeting (a cold opener must not show unexplained familiarity).
   * Runtime allowlist chatMuseAiFanProfileContextFeatures narrows this set. */
  usesFanProfile: boolean;
  /** Inject the fan's own profile bio (a cold-open detail, distinct from the
   * stored dossier above). True for hi-greeting, help-me, and coach-chat;
   * false everywhere else. Replaces the former hard-coded feature check in
   * the feature service. */
  includesFanBio: boolean;
  /** AI media describer: fill ready image descriptions into the transcript's
   * numbered media labels. False for fan-summary (full and short): its recap
   * becomes the fan dossier, and image descriptions must never reach the
   * dossier (owner ruling). Flip here to change it. */
  usesImageNotes: boolean;
}

// ─── Message counts (research §5.1; desktop defaults carried) ───────────

export const QUICK_DEFAULT_MESSAGE_COUNT = 100;
export const IMPROVE_DEFAULT_MESSAGE_COUNT = 25;
export const DEEP_DEFAULT_MESSAGE_COUNT = 1500;
export const PING_DEFAULT_MESSAGE_COUNT = QUICK_DEFAULT_MESSAGE_COUNT;
/** Fixed for hi-greeting; not a user setting (legacy: one API page). */
export const HI_GREETING_MESSAGE_COUNT = 25;

// ─── Feature thresholds (research §1) ───────────────────────────────────

export const MIN_MESSAGES_FOR_DEEP = 30;
/** fan-notes-fill: any conversation with a message may be filled. The gate
 * only refuses an empty one; a chat without a single fan fact simply comes back
 * with every value empty. */
export const MIN_MESSAGES_FOR_NOTES_FILL = 1;
/** Ping needs at least this many messages in the conversation: personal
 * ones when the client reports them (`clientContext.personalMessageCount`),
 * every message otherwise (owner, 2026-10-21). Hi has no count limit. */
export const PING_MIN_MESSAGES = 10;

// ─── Model defaults ───────────────────────────────────────────────────

/** All text features share Opus 5.5 at high effort (owner, 2026-10-15, after a
 * blind bench of Opus 5.5 and Sonnet 5.5 / 5 / 4.6 at low, medium and high on
 * real prompts). The background image describer has its own independent model
 * setting. */
export const DEFAULT_MODEL_ID = 'anthropic:claude-opus-5-5';
export const DEFAULT_FAN_SUMMARY_MODEL_ID = DEFAULT_MODEL_ID;
/** improve-draft, hi-greeting and voice-script delegate to fast-reply. */
export const DEFAULT_REPLY_MODEL_ID = DEFAULT_MODEL_ID;
/** fan-notes-fill keeps its own model row; a request's `model` still overrides it. */
export const DEFAULT_FAN_NOTES_FILL_MODEL_ID = DEFAULT_MODEL_ID;

export const DEFAULT_FEATURE_MODELS: Record<ModelSelectableFeature, string> = {
  'fast-reply': DEFAULT_REPLY_MODEL_ID,
  'help-me': DEFAULT_MODEL_ID,
  'fan-summary': DEFAULT_FAN_SUMMARY_MODEL_ID,
  'chat-review': DEFAULT_MODEL_ID,
  'ping': DEFAULT_REPLY_MODEL_ID,
  'coach-chat': DEFAULT_MODEL_ID,
  'fan-notes-fill': DEFAULT_FAN_NOTES_FILL_MODEL_ID,
};

/** Coach, Recap and notes fill run at medium (owner, 2026-10-28, to cut spend
 * on Opus): Coach medium scored 7.47 against two prod high runs of 7.84 and
 * 7.53 in the 2026-10-22 bench; a full Recap thought ~7k tokens at high. */
export const DEFAULT_FEATURE_REASONING: Record<ModelSelectableFeature, ReasoningEffort> = {
  'fast-reply': 'high',
  'help-me': 'high',
  'fan-summary': 'medium',
  'chat-review': 'high',
  'ping': 'high',
  'coach-chat': 'medium',
  'fan-notes-fill': 'medium',
};

/** Operations whose effort differs from their model feature's default. Fix
 * (improve-draft) shares Reply's model but runs at medium: two blind benches of
 * prod prompts found it equal to high there (2026-10-15: 7.38 vs 7.33;
 * 2026-10-22: 7.45 vs 7.45 and 7.70) at about a third fewer output tokens. */
export const OPERATION_REASONING_OVERRIDES: Partial<Record<OperationFeature, ReasoningEffort>> = {
  'improve-draft': 'medium',
};

export const DEFAULT_MESSAGE_COUNT_BY_BUCKET: Record<FeatureMessageCountBucket, number> = {
  quick: QUICK_DEFAULT_MESSAGE_COUNT,
  ping: PING_DEFAULT_MESSAGE_COUNT,
  improve: IMPROVE_DEFAULT_MESSAGE_COUNT,
  deep: DEEP_DEFAULT_MESSAGE_COUNT,
  hi: HI_GREETING_MESSAGE_COUNT,
};

// ─── Policies (features.ts, verbatim values) ────────────────────────────

export const OPERATION_FEATURES = [
  'fast-reply',
  'improve-draft',
  'help-me',
  'fan-summary',
  'chat-review',
  'ping',
  'hi-greeting',
  'coach-chat',
  'voice-script',
  'fan-notes-fill',
] as const satisfies readonly OperationFeature[];

export const FEATURE_POLICIES = {
  'fast-reply': {
    surface: 'ai-dock',
    resultKind: 'reply',
    promptMode: 'reply',
    timeoutBucket: 'quick',
    messageCountBucket: 'quick',
    modelFeature: 'fast-reply',
    includesEarnings: true,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: true,
    supportsSplitAll: false,
    supportsReplyTone: true,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: false,
    usesImageNotes: true,
  },
  'improve-draft': {
    surface: 'ai-dock',
    resultKind: 'single-reply',
    promptMode: 'reply',
    timeoutBucket: 'quick',
    messageCountBucket: 'improve',
    modelFeature: 'fast-reply',
    includesEarnings: true,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: true,
    supportsSplitAll: false,
    supportsReplyTone: false,
    requiresDraft: true,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: false,
    usesImageNotes: true,
  },
  'help-me': {
    surface: 'panel-tab',
    resultKind: 'xml',
    promptMode: 'analysis',
    timeoutBucket: 'quick',
    messageCountBucket: 'quick',
    modelFeature: 'help-me',
    includesEarnings: true,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsSplitAll: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: true,
    usesImageNotes: true,
  },
  'fan-summary': {
    surface: 'panel-tab',
    resultKind: 'single-reply',
    promptMode: 'analysis',
    timeoutBucket: 'deep',
    messageCountBucket: 'deep',
    modelFeature: 'fan-summary',
    includesEarnings: true,
    minMessages: MIN_MESSAGES_FOR_DEEP,
    rerunAction: 'refresh',
    supportsReplyMode: false,
    supportsSplitAll: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: false,
    usesImageNotes: false,
  },
  'chat-review': {
    surface: 'panel-tab',
    resultKind: 'xml',
    promptMode: 'analysis',
    timeoutBucket: 'deep',
    messageCountBucket: 'deep',
    modelFeature: 'chat-review',
    includesEarnings: true,
    minMessages: MIN_MESSAGES_FOR_DEEP,
    rerunAction: 'refresh',
    supportsReplyMode: false,
    supportsSplitAll: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: false,
    usesImageNotes: true,
  },
  'ping': {
    surface: 'ai-dock',
    resultKind: 'reply',
    promptMode: 'reply',
    timeoutBucket: 'quick',
    messageCountBucket: 'ping',
    modelFeature: 'ping',
    includesEarnings: true,
    minMessages: PING_MIN_MESSAGES,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsSplitAll: true,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: true,
    usesFanProfile: true,
    includesFanBio: true,
    usesImageNotes: true,
  },
  'hi-greeting': {
    surface: 'ai-dock',
    resultKind: 'reply',
    promptMode: 'reply',
    timeoutBucket: 'quick',
    messageCountBucket: 'hi',
    modelFeature: 'fast-reply',
    includesEarnings: false,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsSplitAll: true,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: true,
    usesImageNotes: true,
  },
  'coach-chat': {
    surface: 'panel-tab',
    resultKind: 'text',
    promptMode: 'analysis',
    timeoutBucket: 'quick',
    messageCountBucket: 'quick',
    modelFeature: 'coach-chat',
    includesEarnings: true,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsSplitAll: true,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: true,
    usesImageNotes: true,
  },
  // Voice notes: adapt a chosen chat draft into a speakable ElevenLabs script.
  // One script text (single-reply, no [NEXT]/variants); delegates model
  // selection to fast-reply (improve-draft precedent). Tone presets re-run the
  // script step (UX decision 2026-07-18), so the template carries
  // {toneInstructions}. No earnings, no dossier, no ping segment.
  'voice-script': {
    surface: 'panel-tab',
    resultKind: 'single-reply',
    promptMode: 'reply',
    timeoutBucket: 'quick',
    messageCountBucket: 'quick',
    modelFeature: 'fast-reply',
    includesEarnings: false,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsSplitAll: false,
    supportsReplyTone: true,
    requiresDraft: true,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: false,
    usesImageNotes: true,
  },
  // The Fansly notes panel's «fill with AI»: the chatter's questionnaire labels
  // (noteFields) filled from the whole chat, one `Label: value` line each. Read
  // like the full Recap (deep window, spending and subscription data, the
  // client's full-history transcript), but a short single text with its own
  // model. No dossier: the stored dossier is an earlier model's summary, with
  // its inferences and strategy, and this note must hold only what the fan
  // stated; the whole chat it would summarize is in the prompt already. The
  // fan's own bio counts as his statement. No image notes: an automatic image
  // description is not a fact the fan stated.
  'fan-notes-fill': {
    surface: 'panel-tab',
    resultKind: 'text',
    promptMode: 'analysis',
    timeoutBucket: 'deep',
    messageCountBucket: 'deep',
    modelFeature: 'fan-notes-fill',
    includesEarnings: true,
    minMessages: MIN_MESSAGES_FOR_NOTES_FILL,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsSplitAll: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: true,
    usesImageNotes: false,
  },
} as const satisfies Record<OperationFeature, FeaturePolicy>;

export function isOperationFeature(feature: FeatureType): feature is OperationFeature {
  return feature !== 'compare';
}

export function getFeaturePolicy(feature: OperationFeature): FeaturePolicy {
  return FEATURE_POLICIES[feature];
}
