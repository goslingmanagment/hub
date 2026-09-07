// MIGRATED (Stage 30) from chatgoose_desktop_fable
// packages/shared/src/features.ts + the per-feature parameter block of
// packages/shared/src/constants.ts @ 1db76a4ae13d (2026-07-06).
// Adapted in imports; the desktop's Settings-coupled message-count resolver
// is replaced by the kernel window defaults below (recorded deviation —
// per-feature windows become kernel config in Task 4's registry, seeded
// with the desktop defaults). Later policy changes are recorded in decisions.md.

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
/** hi-greeting is locked unless the conversation has at most this many messages. */
export const HI_GREETING_MAX_TRANSCRIPT = 10;

// ─── Model defaults (Decision #273) ────────────────────────────────────

/** Decision #273 owner follow-up (2026-09-07): Help, Review and Coach join
 * the reply features on Sonnet 5 at low effort without another model comparison.
 * Recap retains its separate Opus default. */
export const DEFAULT_MODEL_ID = 'anthropic:claude-sonnet-5';
export const DEFAULT_FAN_SUMMARY_MODEL_ID = 'anthropic:claude-opus-4-6';
/** improve-draft, hi-greeting and voice-script delegate to fast-reply. */
export const DEFAULT_REPLY_MODEL_ID = DEFAULT_MODEL_ID;

export const DEFAULT_FEATURE_MODELS: Record<ModelSelectableFeature, string> = {
  'fast-reply': DEFAULT_REPLY_MODEL_ID,
  'help-me': DEFAULT_MODEL_ID,
  'fan-summary': DEFAULT_FAN_SUMMARY_MODEL_ID,
  'chat-review': DEFAULT_MODEL_ID,
  'ping': DEFAULT_REPLY_MODEL_ID,
  'coach-chat': DEFAULT_MODEL_ID,
};

export const DEFAULT_FEATURE_REASONING: Record<ModelSelectableFeature, ReasoningEffort> = {
  'fast-reply': 'low',
  'help-me': 'low',
  'fan-summary': 'medium',
  'chat-review': 'low',
  'ping': 'low',
  'coach-chat': 'low',
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
    supportsReplyTone: true,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: false,
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
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: true,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: false,
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
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: true,
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
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: false,
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
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: false,
  },
  'ping': {
    surface: 'ai-dock',
    resultKind: 'reply',
    promptMode: 'reply',
    timeoutBucket: 'quick',
    messageCountBucket: 'ping',
    modelFeature: 'ping',
    includesEarnings: true,
    minMessages: 0,
    rerunAction: 'regenerate',
    supportsReplyMode: false,
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: true,
    usesFanProfile: true,
    includesFanBio: false,
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
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: true,
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
    supportsReplyTone: false,
    requiresDraft: false,
    usesPingSegment: false,
    usesFanProfile: true,
    includesFanBio: true,
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
    supportsReplyTone: true,
    requiresDraft: true,
    usesPingSegment: false,
    usesFanProfile: false,
    includesFanBio: false,
  },
} as const satisfies Record<OperationFeature, FeaturePolicy>;

export function isOperationFeature(feature: FeatureType): feature is OperationFeature {
  return feature !== 'compare';
}

export function getFeaturePolicy(feature: OperationFeature): FeaturePolicy {
  return FEATURE_POLICIES[feature];
}
