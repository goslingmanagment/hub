import type { TransactionType } from "@agency_hub_core/shared";

// Workboard v2 priority engine — shared types.
// See docs/workboard-v2-priority-design.md.

export type WorkboardTab =
  | "subscribers"
  | "spenders"
  | "fresh_mass"
  | "old_mass"
  | "service";

export type MassSubstate = "fresh" | "gray" | "active" | "dead" | "archived";

export type SecondaryStatus =
  | "recent_purchase"
  | "need_reply"
  | "due_now"
  | "later"
  | "dont_touch_today";

export type DmSenderRole = "fan" | "model" | "system" | "unknown";
export type CoverageStatus = "pending_backfill" | "partial_window" | "complete";
export type FanFlag = "whale" | "vip" | "risky";
export type UrgencySeverity = "critical" | "high" | "medium" | "normal" | "muted";
export type ValueTier = "whale" | "vip" | "payer" | "new";
export type ValueConfidence = "high" | "low";
export type QConfidence = "high" | "medium" | "low";
export type FreeloaderStatus = "none" | "cooling" | "freeloader" | "ceiling";
export type RatioHealth = "balanced" | "model_skew" | "fan_heavy" | "unknown";
export type LatencyBand = "fast" | "warm" | "cooling" | "cold" | "unknown";

/**
 * L2 (Haiku) semantic read of the fan's tail in conversation context — what the
 * fan is actually doing, not just "needs a reply?". Drives both the closing
 * detector (needs_reply) AND the urgency axis (a buy signal outranks a stale ack).
 */
export type ConversationState =
  | "question" // fan asked something / wants info
  | "buy_signal" // interested / ready to buy / said yes to an offer
  | "smalltalk" // chatting, mild engagement, no clear ask
  | "closing" // ack / thanks / goodbye — conversation done
  | "cold" // disengaged / dismissive / "not interested" / "stop"
  | "complaint"; // problem / upset / refund / something broke

/**
 * Normalized per-(page, fan) signals the engine scores. Produced by the
 * repository layer; the engine itself is pure (no DB / no clock besides `now`),
 * so every formula and hard case is unit-testable.
 */
export interface FanSignals {
  /** Evaluation time. Day-math is pinned to `timeZone` (UTC, matching rollups). */
  now: Date;
  timeZone?: string;

  // ── Spend (mills; 1 mill = $0.001) ──────────────────────────────────────
  ltvMills: bigint;
  lastTransactionAt: Date | null;
  /** Settled (revenue-bucket) net over the trailing 30 / 90 days. */
  spend30Mills: bigint;
  spend90Mills: bigint;
  /** Share of trailing-90d settled net that is à-la-carte (PPV/tip/post/stream). [0,1] */
  alaCarteShare90: number;

  // ── Subscription ─────────────────────────────────────────────────────────
  isSubscriber: boolean;
  subscriptionExpiresAt: Date | null;
  autoRenew: boolean | null;
  subscriptionPriceMills: bigint | null;

  // ── Tenure / follow ───────────────────────────────────────────────────────
  followerSince: Date | null;
  hasEverFanMessaged: boolean;

  // ── Flags (global) ─────────────────────────────────────────────────────────
  flags: readonly FanFlag[];

  // ── Most recent settled purchase ────────────────────────────────────────────
  lastPurchaseAt: Date | null;
  lastPurchaseNetMills: bigint | null;
  lastPurchaseType: TransactionType | null;

  // ── Conversation / DM thread ──────────────────────────────────────────────────
  lastMessageSenderRole: DmSenderRole;
  lastFanMessageAt: Date | null;
  lastModelMessageAt: Date | null;
  /** Tail message text, for the L1 closing detector. */
  tailContent: string | null;
  storedMessageCount: number;
  messageCoverageStatus: CoverageStatus;
  // Conversation-quality aggregates over the ≤25 stored messages (Stage 1).
  modelMsgCount: number;
  fanMsgCount: number;
  unknownMsgCount: number;
  initiatorRole: DmSenderRole;
  avgReplyGapHours: number | null;
  priorQScore: number | null;
  // L2 closing-classifier verdict for the tail message (null = not yet classified).
  l2NeedsReply: boolean | null;
  // L2 semantic read of the conversation (null = not classified / disabled).
  l2State?: ConversationState | null;

  // ── Touch log (authoritative "we contacted them") ──────────────────────────────
  lastProductiveContactAt: Date | null;

  // ── Presence (best-effort) ────────────────────────────────────────────────────
  externalPresenceAt: Date | null;
  externalPresenceObservedAt: Date | null;
  presenceFeedTruncated: boolean;

  // ── Service gating ───────────────────────────────────────────────────────────────
  snoozedUntil: Date | null;
  refundCooldownUntil: Date | null;

  // ── Persisted lifecycle (prior state) ───────────────────────────────────────────────
  massSubstate: MassSubstate | null;
  reactivationAttemptedAt: Date | null;
  freeloaderStatus?: FreeloaderStatus;
  // Freeloader sliding window (service pre-computes from the persisted episode list).
  freeloaderConv90: number;
  lifetimeFreeEpisodes: number;
  convertedRecently: boolean;
}

export interface ConversationQuality {
  modelMsgs: number;
  fanMsgs: number;
  ratioHealth: RatioHealth;
  initiator: "fan" | "model" | "unknown";
  latencyBand: LatencyBand;
}

export interface UrgencyDriver {
  code:
    | "purchase"
    | "expiry"
    | "sla"
    | "cadence"
    | "presence"
    | "reactivation"
    // L2-intent drivers (the fan's tail, read in context by Haiku).
    | "buy_signal"
    | "complaint"
    | "question";
  value: number;
  /** The salient number for the human "why now" string (days / hours), if any. */
  whyValue: number | null;
}

export interface WorkboardEvaluation {
  tab: WorkboardTab;
  massSubstate: MassSubstate | null;
  valueScore: number;
  urgencyScore: number;
  rankScore: number;
  secondaryStatus: SecondaryStatus;
  urgencySeverity: UrgencySeverity;
  valueTier: ValueTier;
  valueConfidence: ValueConfidence;
  qScore: number;
  qConfidence: QConfidence;
  freeloaderStatus: FreeloaderStatus;
  conversationQuality: ConversationQuality;
  needsReply: boolean;
  needsHumanTriage: boolean;
  isPurchaseFollowup: boolean;
  whyNowCode: string | null;
  whyNowValue: number | null;
  reasonChips: string[];
  followupDueAt: Date | null;
  serviceReason: string | null;
}
