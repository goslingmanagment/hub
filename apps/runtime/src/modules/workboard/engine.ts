import {
  UTC_TIME_ZONE,
  getTransactionClassification,
  startOfBusinessDay,
} from "@agency_hub_core/shared";

import { isClosingMessage } from "./closing.ts";
import type {
  ConversationQuality,
  FanSignals,
  FreeloaderStatus,
  LatencyBand,
  MassSubstate,
  QConfidence,
  RatioHealth,
  SecondaryStatus,
  UrgencyDriver,
  UrgencySeverity,
  ValueTier,
  WorkboardEvaluation,
  WorkboardTab,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Coefficients (Stage 0 defaults). See docs/workboard-v2-priority-design.md §16.
// Exported so tests and a future per-page calibration layer can reference them.
// ─────────────────────────────────────────────────────────────────────────────
export const WB = {
  value: {
    ltvRefDollars: 1000,
    recencyDecayDays: 120, // recencyMult = 0.5 + 0.5*exp(-ageDays/120); half-life ≈ 83d
    velRefDollarsPerDay: 5,
    tierRefDollars: 50,
    weights: { ltv: 0.35, velocity: 0.35, tier: 0.2, potential: 0.1 },
    flagBonus: { whale: 20, vip: 12, risky: -15 } as Record<string, number>,
    potentialColdStartLtvDollars: 20,
    potentialFollowerWindowDays: 14,
    // Stage-0 fixed tier thresholds (reachable given the weight ceiling). The design
    // calls for per-page percentile calibration (§15); these are placeholders.
    whaleTierScore: 65,
    vipTierScore: 40,
  },
  urgency: {
    purchase: { base: 95, halfLifeHours: 36, bigBuyDollars: 50, bigBuyMult: 1.05, windowDays: 3 },
    expiryAnchors: [
      [1, 88],
      [3, 78],
      [5, 66],
      [7, 54],
      [10, 40],
      [14, 28],
      [21, 16],
    ] as ReadonlyArray<readonly [number, number]>,
    autoRenewMult: { off: 1.12, unknown: 1.05, on: 0.8 },
    sla: { cap: 80, base: 30, coef: 22, divisor: 6, pendingCoverageCap: 50, unverifiedFactor: 0.7 },
    cadence: {
      base: 20,
      slope: 6,
      cap: { subscribers: 60, spenders: 70, fresh_mass: 45, old_mass: 30 } as Record<WorkboardTab, number>,
    },
    presence: { freshMinutes: 30, recentMinutes: 120, freshBoost: 35, recentBoost: 20, observedMaxMinutes: 30 },
    reactivation: { boost: 25, windowDays: 7 },
    // L2-intent (Haiku read the fan's tail in conversation context). buy_signal sits
    // just under a fresh purchase (95) and above the SLA cap (80), so "yes, send it!"
    // tops the queue; complaint is high; a plain question is a moderate lift over bare
    // SLA. A cold tail that still "needs a reply" is damped so age alone can't float it
    // above a warm one.
    intent: { buySignal: 90, complaint: 85, question: 55, coldSlaFactor: 0.5 },
    bonusCap: 8,
    bonusFactor: 0.25,
  },
  rank: {
    qLever: 0.15,
    valueWeightByTab: {
      subscribers: 0.1,
      spenders: 0.3,
      fresh_mass: 0.05,
      old_mass: 0.05,
      service: 0,
    } as Record<WorkboardTab, number>,
  },
  status: { dueNow: 50, later: 25 },
  quality: {
    weights: { ratio: 0.35, initiator: 0.3, lastWriter: 0.1, latency: 0.25 },
    activeThreshold: 0.2, // Gray/Fresh -> Active needs Q >= this with >=medium confidence
    hcqFactor: 0.45, // T_eff = T_cad * (1 - 0.45 * qEff): hot chat shrinks the clock, model-skew stretches it
  },
  freeloader: {
    windowN: 10, // meaningful conversation-days / 90d (no conversion) -> throttle
    coolingStart: 7,
    frequencyMultiplier: 0.25, // quarter the cadence
    rankPenalty: 12,
    lifetimeCap: 25, // cumulative no-conversion episodes -> hard ceiling (anti re-entry abuse)
    intentQHigh: 0.4, // suppress the suppression if actively/healthily conversing
    intentRisePrior: 0.15,
    intentLatencyHours: 6,
  },
  fsm: {
    // Spec: "Spenders = anyone who has ever paid." Any settled payment (>= 1 cent) qualifies;
    // never-paid ($0) stays in mass. (Was $100 for v1 compatibility — lowered per product decision.)
    spenderMinDollars: 0.01,
    freshWindowDays: 30,
    grayAfterDays: 14,
    deadAfterDays: 45,
    sleepDays: 75,
    reactivationWindowDays: 7,
  },
  cadence: {
    targetDays: {
      subscribers: 7,
      subscribersRenewOff: 5,
      spenders: 14,
      spendersWhale: 10,
      fresh_mass: 4,
      old_mass: 30,
    },
    cooldownDays: 3,
  },
} as const;

const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

// ── small helpers ──────────────────────────────────────────────────────────────
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
function clamp01(value: number): number {
  return clamp(value, 0, 1);
}
function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
function millsToDollars(mills: bigint): number {
  return Number(mills) / 1000;
}
function tz(signals: FanSignals): string {
  return signals.timeZone ?? UTC_TIME_ZONE;
}
/** Whole calendar days between two instants, pinned to the engine timezone (a − b). */
function dayDiff(a: Date, b: Date, zone: string): number {
  return Math.round((startOfBusinessDay(a, zone).getTime() - startOfBusinessDay(b, zone).getTime()) / MS_PER_DAY);
}
function hoursSince(now: Date, then: Date): number {
  return (now.getTime() - then.getTime()) / MS_PER_HOUR;
}
function minutesSince(now: Date, then: Date): number {
  return (now.getTime() - then.getTime()) / (60 * 1000);
}

/** Piecewise-linear interpolation through ascending (x, y) anchors; 0 beyond the last. */
function interpolateAnchors(anchors: ReadonlyArray<readonly [number, number]>, x: number): number {
  const first = anchors[0];
  if (!first || x <= first[0]) {
    return first ? first[1] : 0;
  }
  for (let i = 0; i < anchors.length - 1; i += 1) {
    const [x0, y0] = anchors[i]!;
    const [x1, y1] = anchors[i + 1]!;
    if (x <= x1) {
      const t = (x - x0) / (x1 - x0);
      return y0 + (y1 - y0) * t;
    }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Value axis — "who matters" (slow). Output [0, 100].
// ─────────────────────────────────────────────────────────────────────────────
export function computeValue(signals: FanSignals): {
  score: number;
  confidence: "high" | "low";
  tier: ValueTier;
} {
  const zone = tz(signals);
  const ltvDollars = Math.max(0, millsToDollars(signals.ltvMills));

  // (1) realized LTV, log-normalized, recency-decayed.
  const lnRaw = Math.log(1 + ltvDollars) / Math.log(1 + WB.value.ltvRefDollars);
  const ageDays = signals.lastTransactionAt
    ? Math.max(0, dayDiff(signals.now, signals.lastTransactionAt, zone))
    : Number.POSITIVE_INFINITY;
  const recencyMult = 0.5 + 0.5 * Math.exp(-(Number.isFinite(ageDays) ? ageDays : 1e9) / WB.value.recencyDecayDays);
  const ln = clamp01(lnRaw) * recencyMult;

  // (2) run-rate velocity, à-la-carte-tilted.
  const rateDollarsPerDay = Math.max(
    millsToDollars(signals.spend30Mills) / 30,
    millsToDollars(signals.spend90Mills) / 90,
  );
  const velBase = clamp01(rateDollarsPerDay / WB.value.velRefDollarsPerDay);
  const typeTilt = clamp(0.8 + 0.6 * clamp01(signals.alaCarteShare90), 0.8, 1.4);
  const vel = clamp01(velBase * typeTilt);

  // (3) tier / price (subscribers only).
  const priceDollars = signals.subscriptionPriceMills != null ? millsToDollars(signals.subscriptionPriceMills) : 0;
  const tier = signals.isSubscriber ? clamp01(priceDollars / WB.value.tierRefDollars) : 0;

  // (4) cold-start potential floor.
  let potential = 0;
  const isFreshFollower = signals.followerSince != null
    && dayDiff(signals.now, signals.followerSince, zone) <= WB.value.potentialFollowerWindowDays;
  if (ltvDollars < WB.value.potentialColdStartLtvDollars && (signals.isSubscriber || isFreshFollower)) {
    potential = 0.5 * tier + 0.25;
  }

  const w = WB.value.weights;
  let score = 100 * clamp01(w.ltv * ln + w.velocity * vel + w.tier * tier + w.potential * potential);
  for (const flag of signals.flags) {
    score += WB.value.flagBonus[flag] ?? 0;
  }
  score = clamp(score, 0, 100);

  const confidence: "high" | "low" = signals.ltvMills > 0n || signals.spend90Mills > 0n ? "high" : "low";
  const hasWhaleFlag = signals.flags.includes("whale");
  const hasVipFlag = signals.flags.includes("vip");
  const tierLabel: ValueTier =
    score >= WB.value.whaleTierScore || hasWhaleFlag
      ? "whale"
      : score >= WB.value.vipTierScore || hasVipFlag
        ? "vip"
        : ltvDollars > 0
          ? "payer"
          : "new";

  return { score: round(score, 2), confidence, tier: tierLabel };
}

// ─────────────────────────────────────────────────────────────────────────────
// Urgency axis — "why today" (fast). Output [0, 100], dominant + capped bonus.
// ─────────────────────────────────────────────────────────────────────────────
function purchaseDriver(signals: FanSignals): UrgencyDriver | null {
  if (!signals.lastPurchaseAt || !signals.lastPurchaseType) {
    return null;
  }
  // Settlement-aware: only revenue-bucket types fire the spike (never refund/chargeback/payout_reversal).
  if (getTransactionClassification(signals.lastPurchaseType).bucket !== "revenue") {
    return null;
  }
  const h = hoursSince(signals.now, signals.lastPurchaseAt);
  if (h < 0 || h > WB.urgency.purchase.windowDays * 24) {
    return null;
  }
  let value = WB.urgency.purchase.base * Math.exp(-h / WB.urgency.purchase.halfLifeHours);
  const netDollars = signals.lastPurchaseNetMills != null ? millsToDollars(signals.lastPurchaseNetMills) : 0;
  if (netDollars >= WB.urgency.purchase.bigBuyDollars) {
    value *= WB.urgency.purchase.bigBuyMult;
  }
  return { code: "purchase", value: Math.min(100, value), whyValue: Math.round(h) };
}

function expiryDriver(signals: FanSignals): UrgencyDriver | null {
  if (!signals.isSubscriber || !signals.subscriptionExpiresAt) {
    return null;
  }
  const days = dayDiff(signals.subscriptionExpiresAt, signals.now, tz(signals));
  if (days < 0) {
    return null;
  }
  const base = interpolateAnchors(WB.urgency.expiryAnchors, days);
  if (base <= 0) {
    return null;
  }
  const mult =
    signals.autoRenew === false
      ? WB.urgency.autoRenewMult.off
      : signals.autoRenew === null
        ? WB.urgency.autoRenewMult.unknown
        : WB.urgency.autoRenewMult.on;
  return { code: "expiry", value: Math.min(100, base * mult), whyValue: days };
}

function slaDriver(signals: FanSignals, needsReply: boolean, unverified: boolean): UrgencyDriver | null {
  if (!needsReply || !signals.lastFanMessageAt) {
    return null;
  }
  const h = hoursSince(signals.now, signals.lastFanMessageAt);
  if (h < 0) {
    return null;
  }
  let value = Math.min(WB.urgency.sla.cap, WB.urgency.sla.base + WB.urgency.sla.coef * Math.log(1 + h / WB.urgency.sla.divisor));
  if (signals.messageCoverageStatus === "pending_backfill") {
    value = Math.min(value, WB.urgency.sla.pendingCoverageCap);
  }
  // Classifier-unverified need-reply ranks below confirmed (false positive insurance).
  if (unverified) {
    value *= WB.urgency.sla.unverifiedFactor;
  }
  // A fan who has gone cold (L2 read) shouldn't out-age a warm one on the SLA clock alone.
  if (signals.l2State === "cold") {
    value *= WB.urgency.intent.coldSlaFactor;
  }
  return { code: "sla", value, whyValue: Math.round(h) };
}

/**
 * L2-intent driver — what the fan is actually doing (Haiku read the tail in context).
 * Only the fan's own unanswered tail carries intent; smalltalk/closing/cold add no lift.
 */
function intentDriver(signals: FanSignals, needsReply: boolean): UrgencyDriver | null {
  if (!needsReply || signals.lastMessageSenderRole !== "fan" || !signals.l2State) {
    return null;
  }
  switch (signals.l2State) {
    case "buy_signal":
      return { code: "buy_signal", value: WB.urgency.intent.buySignal, whyValue: null };
    case "complaint":
      return { code: "complaint", value: WB.urgency.intent.complaint, whyValue: null };
    case "question":
      return { code: "question", value: WB.urgency.intent.question, whyValue: null };
    default:
      return null;
  }
}

function targetCadenceDays(signals: FanSignals, tab: WorkboardTab): number {
  const c = WB.cadence.targetDays;
  switch (tab) {
    case "subscribers":
      return signals.autoRenew === false ? c.subscribersRenewOff : c.subscribers;
    case "spenders":
      return signals.flags.includes("whale") ? c.spendersWhale : c.spenders;
    case "fresh_mass":
      return c.fresh_mass;
    case "old_mass":
      return c.old_mass;
    default:
      return c.spenders;
  }
}

function cadenceDriver(signals: FanSignals, tab: WorkboardTab, qEff: number, freeloaderFm: number): UrgencyDriver | null {
  if (tab === "service") {
    return null;
  }
  // Clock-bending: a hot 1:1 chat shrinks the interval (come back fast); model-skew
  // stretches it; a freeloader multiplier lengthens it (touch them less).
  const hcq = 1 - WB.quality.hcqFactor * qEff; // qEff in [-1,1] -> hcq in [0.55, 1.45]
  const target = (targetCadenceDays(signals, tab) * hcq) / Math.max(freeloaderFm, 0.05);
  const last = signals.lastProductiveContactAt ?? signals.lastModelMessageAt ?? signals.lastFanMessageAt;
  const cap = WB.urgency.cadence.cap[tab];
  if (!last) {
    // Never contacted → exactly due (base), so new fans surface but don't scream.
    return { code: "cadence", value: WB.urgency.cadence.base, whyValue: null };
  }
  const daysSince = dayDiff(signals.now, last, tz(signals));
  const over = daysSince - target;
  if (over < 0) {
    return null;
  }
  return { code: "cadence", value: Math.min(cap, WB.urgency.cadence.base + WB.urgency.cadence.slope * over), whyValue: daysSince };
}

function presenceDriver(signals: FanSignals): UrgencyDriver | null {
  if (!signals.externalPresenceAt || signals.presenceFeedTruncated) {
    return null;
  }
  // Require a fresh observation, else the feed may be stale/misleading (advisory only).
  if (!signals.externalPresenceObservedAt || minutesSince(signals.now, signals.externalPresenceObservedAt) > WB.urgency.presence.observedMaxMinutes) {
    return null;
  }
  const mins = minutesSince(signals.now, signals.externalPresenceAt);
  if (mins <= WB.urgency.presence.freshMinutes) {
    return { code: "presence", value: WB.urgency.presence.freshBoost, whyValue: Math.round(mins) };
  }
  if (mins <= WB.urgency.presence.recentMinutes) {
    return { code: "presence", value: WB.urgency.presence.recentBoost, whyValue: Math.round(mins) };
  }
  return null;
}

function reactivationDriver(signals: FanSignals, tab: WorkboardTab): UrgencyDriver | null {
  if (tab !== "old_mass" || signals.massSubstate !== "dead") {
    return null;
  }
  // One-shot: only while inside the reactivation window and not already attempted.
  if (signals.reactivationAttemptedAt) {
    const since = dayDiff(signals.now, signals.reactivationAttemptedAt, tz(signals));
    if (since > WB.fsm.reactivationWindowDays) {
      return null;
    }
  }
  return { code: "reactivation", value: WB.urgency.reactivation.boost, whyValue: null };
}

export function combineUrgency(drivers: UrgencyDriver[]): { score: number; winner: UrgencyDriver | null } {
  if (drivers.length === 0) {
    return { score: 0, winner: null };
  }
  let winner = drivers[0]!;
  for (const d of drivers) {
    if (d.value > winner.value) {
      winner = d;
    }
  }
  let othersSum = 0;
  for (const d of drivers) {
    if (d !== winner) {
      othersSum += d.value;
    }
  }
  const bonus = Math.min(WB.urgency.bonusCap, WB.urgency.bonusFactor * othersSum);
  return { score: clamp(winner.value + bonus, 0, 100), winner };
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation quality Q in [-1, +1] — a modulator (gates promotion, bends the
// cadence clock, applies a small ±lever on rank, feeds the freeloader counter).
// ─────────────────────────────────────────────────────────────────────────────
function ratioHealthLabel(m: number, f: number): RatioHealth {
  if (m + f === 0) {
    return "unknown";
  }
  const ratio = m / Math.max(f, 1);
  if (ratio >= 2) {
    return "model_skew";
  }
  if (ratio <= 0.6) {
    return "fan_heavy";
  }
  return "balanced";
}

function latencyBandLabel(gapHours: number | null): LatencyBand {
  if (gapHours == null) {
    return "unknown";
  }
  if (gapHours <= 6) {
    return "fast";
  }
  if (gapHours <= 24) {
    return "warm";
  }
  if (gapHours <= 72) {
    return "cooling";
  }
  return "cold";
}

export function computeQuality(signals: FanSignals): {
  q: number;
  qEff: number;
  qConfidence: QConfidence;
  roleConfidence: number;
  breakdown: ConversationQuality;
} {
  const m = signals.modelMsgCount;
  const f = signals.fanMsgCount;
  const u = signals.unknownMsgCount;

  // Reciprocity: ~1:1 ideal; model-skew penalized; fan-heavy floored (never bad).
  let rq = 0;
  if (m + f > 0) {
    const ratio = m / Math.max(f, 1);
    rq = clamp(1.2 - 0.5 * Math.abs(Math.log(ratio === 0 ? 1 : ratio)), -1, 1);
    if (m < f) {
      rq = Math.max(rq, 0.7);
    }
  }
  const iq = signals.initiatorRole === "fan" ? 1 : signals.initiatorRole === "model" ? -0.3 : 0;
  const tailClosing = isClosingMessage(signals.tailContent);
  const lq = signals.lastMessageSenderRole === "fan" ? (tailClosing ? -0.3 : 0.3)
    : signals.lastMessageSenderRole === "model" ? -0.1 : 0;
  const g = signals.avgReplyGapHours;
  const hq = g == null ? 0 : g <= 1 ? 1 : g <= 6 ? 0.6 : g <= 24 ? 0.2 : g <= 72 ? -0.2 : -0.6;

  const w = WB.quality.weights;
  const q = clamp(w.ratio * rq + w.initiator * iq + w.lastWriter * lq + w.latency * hq, -1, 1);

  const qConfidence: QConfidence =
    signals.messageCoverageStatus === "pending_backfill" || signals.storedMessageCount <= 1
      ? "low"
      : signals.messageCoverageStatus === "complete" || signals.storedMessageCount >= 6
        ? "high"
        : "medium";
  const qDamp = qConfidence === "high" ? 1 : qConfidence === "medium" ? 0.5 : 0;
  const total = m + f + u;
  const roleConfidence = total > 0 ? clamp(1 - 0.6 * (u / total), 0, 1) : 1;
  const qEff = q * qDamp * roleConfidence;

  return {
    q: round(q, 3),
    qEff,
    qConfidence,
    roleConfidence: round(roleConfidence, 3),
    breakdown: {
      modelMsgs: m,
      fanMsgs: f,
      ratioHealth: ratioHealthLabel(m, f),
      initiator: signals.initiatorRole === "fan" ? "fan" : signals.initiatorRole === "model" ? "model" : "unknown",
      latencyBand: latencyBandLabel(g),
    },
  };
}

/** A real two-way exchange (used for the freeloader episode counter + Active promotion). */
export function isMeaningfulConversation(signals: FanSignals): boolean {
  return signals.fanMsgCount >= 2 && signals.modelMsgCount >= 1;
}

export function computeFreeloader(input: {
  conv90: number;
  converted: boolean;
  qEff: number;
  priorQ: number | null;
  latencyHours: number | null;
  lifetime: number;
}): { status: FreeloaderStatus; frequencyMultiplier: number; rankPenalty: number } {
  if (input.converted) {
    return { status: "none", frequencyMultiplier: 1, rankPenalty: 0 };
  }
  const fl = WB.freeloader;
  const rising = input.priorQ != null && input.qEff - input.priorQ >= fl.intentRisePrior;
  const latencyFast = input.latencyHours != null && input.latencyHours <= fl.intentLatencyHours;
  // Don't abandon a fan who is actively, healthily conversing (classic pre-conversion behavior).
  const intentStrong = input.qEff >= fl.intentQHigh || (rising && latencyFast);

  if (input.lifetime >= fl.lifetimeCap && !intentStrong) {
    return { status: "ceiling", frequencyMultiplier: 0.1, rankPenalty: fl.rankPenalty + 6 };
  }
  if (input.conv90 >= fl.windowN && !intentStrong) {
    return { status: "freeloader", frequencyMultiplier: fl.frequencyMultiplier, rankPenalty: fl.rankPenalty };
  }
  if (input.conv90 >= fl.coolingStart) {
    const fm = 1 - 0.75 * (input.conv90 - fl.coolingStart) / (fl.windowN - fl.coolingStart);
    return { status: "cooling", frequencyMultiplier: clamp(fm, 0.25, 1), rankPenalty: 0 };
  }
  return { status: "none", frequencyMultiplier: 1, rankPenalty: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// FSM — tab + mass substate derivation (first match wins).
// ─────────────────────────────────────────────────────────────────────────────
interface FsmContext {
  q: number;
  qConfidence: QConfidence;
  freeloaderStatus: FreeloaderStatus;
}

function deriveServiceReason(signals: FanSignals, ctx: FsmContext): string | null {
  if (signals.snoozedUntil && signals.snoozedUntil.getTime() > signals.now.getTime()) {
    return "snoozed";
  }
  if (signals.refundCooldownUntil && signals.refundCooldownUntil.getTime() > signals.now.getTime()) {
    return "refund_cooldown";
  }
  if (signals.massSubstate === "archived") {
    return "archived";
  }
  if (ctx.freeloaderStatus === "ceiling") {
    return "freeloader_ceiling";
  }
  return null;
}

function deriveMassSubstate(signals: FanSignals, ctx: FsmContext): MassSubstate {
  const zone = tz(signals);
  if (signals.massSubstate === "archived") {
    return "archived";
  }
  // "Active" requires evidence of a real two-way conversation (Q >= Q_ACTIVE with
  // adequate confidence), NOT a lone "hi".
  const hasRealConversation =
    signals.fanMsgCount >= 2 && ctx.q >= WB.quality.activeThreshold && ctx.qConfidence !== "low";
  if (hasRealConversation || signals.massSubstate === "active" || signals.massSubstate === "dead") {
    if (signals.massSubstate === "dead") {
      return "dead";
    }
    const lastContact = signals.lastProductiveContactAt ?? signals.lastModelMessageAt ?? signals.lastFanMessageAt;
    const daysSince = lastContact ? dayDiff(signals.now, lastContact, zone) : WB.fsm.deadAfterDays + 1;
    return daysSince > WB.fsm.deadAfterDays ? "dead" : "active";
  }
  const followerAge = signals.followerSince ? dayDiff(signals.now, signals.followerSince, zone) : 0;
  return followerAge > WB.fsm.grayAfterDays ? "gray" : "fresh";
}

export function deriveTab(
  signals: FanSignals,
  ctx: FsmContext,
): { tab: WorkboardTab; massSubstate: MassSubstate | null; serviceReason: string | null } {
  const serviceReason = deriveServiceReason(signals, ctx);
  if (serviceReason) {
    return { tab: "service", massSubstate: signals.massSubstate, serviceReason };
  }
  if (signals.isSubscriber && signals.subscriptionExpiresAt && signals.subscriptionExpiresAt.getTime() > signals.now.getTime()) {
    return { tab: "subscribers", massSubstate: null, serviceReason: null };
  }
  const ltvDollars = millsToDollars(signals.ltvMills);
  if (ltvDollars >= WB.fsm.spenderMinDollars) {
    return { tab: "spenders", massSubstate: null, serviceReason: null };
  }
  const massSubstate = deriveMassSubstate(signals, ctx);
  const zone = tz(signals);
  const followerAge = signals.followerSince ? dayDiff(signals.now, signals.followerSince, zone) : 0;
  // Fresh vs Old is driven by RELATIONSHIP AGE (the first ~30d window), not by whether
  // they've replied: an engaged fan still inside the window is worked in Fresh.
  const isFreshTab = massSubstate !== "dead" && followerAge <= WB.fsm.freshWindowDays;
  return { tab: isFreshTab ? "fresh_mass" : "old_mass", massSubstate, serviceReason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rank + status + presentation.
// ─────────────────────────────────────────────────────────────────────────────
export function computeRankScore(
  tab: WorkboardTab,
  urgency: number,
  value: number,
  qEff = 0,
  freeloaderPenalty = 0,
): number {
  const valueWeight = WB.rank.valueWeightByTab[tab];
  return round(Math.max(0, urgency * (1 + WB.rank.qLever * qEff) + valueWeight * value - freeloaderPenalty), 3);
}

function deriveSecondaryStatus(input: {
  isPurchaseFollowup: boolean;
  needsReply: boolean;
  gated: boolean;
  urgency: number;
}): SecondaryStatus {
  if (input.isPurchaseFollowup) {
    return "recent_purchase";
  }
  if (input.needsReply) {
    return "need_reply";
  }
  if (input.gated) {
    return "dont_touch_today";
  }
  if (input.urgency >= WB.status.dueNow) {
    return "due_now";
  }
  if (input.urgency >= WB.status.later) {
    return "later";
  }
  return "dont_touch_today";
}

function deriveSeverity(winner: UrgencyDriver | null, status: SecondaryStatus): UrgencySeverity {
  if (status === "dont_touch_today") {
    return "muted";
  }
  if (!winner) {
    return "normal";
  }
  switch (winner.code) {
    case "purchase":
      return winner.whyValue != null && winner.whyValue < 2 ? "critical" : "high";
    case "expiry": {
      const d = winner.whyValue ?? 99;
      return d <= 1 ? "critical" : d <= 3 ? "high" : d <= 7 ? "medium" : "normal";
    }
    case "sla": {
      const h = winner.whyValue ?? 0;
      return h > 72 ? "critical" : h >= 24 ? "high" : "medium";
    }
    case "buy_signal":
      return "critical"; // hot — close the sale now
    case "complaint":
      return "high";
    case "question":
      return "medium";
    case "cadence":
      return "medium";
    default:
      return "normal";
  }
}

function buildReasonChips(signals: FanSignals, ctx: {
  tab: WorkboardTab;
  massSubstate: MassSubstate | null;
  isPurchaseFollowup: boolean;
  needsReply: boolean;
  replyUnverified: boolean;
  gated: boolean;
  freeloaderStatus: FreeloaderStatus;
  qConfidence: QConfidence;
}): string[] {
  const chips: string[] = [];
  if (ctx.isPurchaseFollowup) chips.push("recent_purchase");
  // L2-intent chips (high visibility — placed before the softer reasons).
  if (ctx.needsReply && signals.l2State === "buy_signal") chips.push("buy_signal");
  if (ctx.needsReply && signals.l2State === "complaint") chips.push("complaint");
  if (signals.isSubscriber && signals.autoRenew === false) chips.push("renew_off");
  if (signals.isSubscriber && signals.subscriptionExpiresAt) {
    const d = dayDiff(signals.subscriptionExpiresAt, signals.now, tz(signals));
    if (d >= 0 && d <= 7) chips.push("expires_soon");
  }
  if (ctx.needsReply) chips.push("replies_waiting");
  if (ctx.replyUnverified) chips.push("unverified");
  if (ctx.tab === "fresh_mass" && ctx.massSubstate === "fresh") chips.push("fresh_day_n");
  if (signals.flags.includes("whale") || signals.flags.includes("vip")) chips.push("vip_whale");
  if (ctx.freeloaderStatus === "freeloader" || ctx.freeloaderStatus === "ceiling") chips.push("freeloader");
  if (ctx.gated) chips.push("cooldown");
  // "Low data" only where we'd otherwise lean on conversation we can't read — not on
  // every never-messaged cold follower (which would be pure noise).
  if (ctx.qConfidence === "low" && (signals.isSubscriber || signals.hasEverFanMessaged)) chips.push("cold_start");
  return chips;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level evaluation.
// ─────────────────────────────────────────────────────────────────────────────
export function evaluateFan(signals: FanSignals): WorkboardEvaluation {
  const zone = tz(signals);

  const quality = computeQuality(signals);
  const freeloader = computeFreeloader({
    conv90: signals.freeloaderConv90,
    converted: signals.convertedRecently,
    qEff: quality.qEff,
    priorQ: signals.priorQScore,
    latencyHours: signals.avgReplyGapHours,
    lifetime: signals.lifetimeFreeEpisodes,
  });

  const { tab, massSubstate, serviceReason } = deriveTab(signals, {
    q: quality.q,
    qConfidence: quality.qConfidence,
    freeloaderStatus: freeloader.status,
  });

  const value = computeValue(signals);

  // needs_reply: fan wrote last AND not an L1 closing. For tails > 24h, defer to the
  // L2 classifier verdict; if not yet classified, default true but flag "unverified".
  let needsReply = false;
  let replyUnverified = false;
  if (signals.lastMessageSenderRole === "fan" && !isClosingMessage(signals.tailContent)) {
    // "Handled": a productive touch (Готово) at/after the fan's last message clears the
    // reply obligation immediately — even before the DM sync catches the model's reply.
    const handled = signals.lastProductiveContactAt != null
      && signals.lastFanMessageAt != null
      && signals.lastProductiveContactAt.getTime() >= signals.lastFanMessageAt.getTime();
    if (!handled) {
      const tailAgeHours = signals.lastFanMessageAt ? hoursSince(signals.now, signals.lastFanMessageAt) : null;
      if (tailAgeHours == null || tailAgeHours < 24) {
        needsReply = true; // fresh — give the chatter a chance to answer on time
      } else if (signals.l2NeedsReply != null) {
        needsReply = signals.l2NeedsReply; // classifier-confirmed verdict
      } else {
        needsReply = true; // > 24h, not yet classified → safe default, shown unverified
        replyUnverified = true;
      }
    }
  }
  const needsHumanTriage = signals.lastMessageSenderRole === "unknown"
    && signals.hasEverFanMessaged
    && (signals.lastFanMessageAt != null);

  // Cooldown gate: a productive touch within COOLDOWN days with no newer fan message.
  const lastTouch = signals.lastProductiveContactAt;
  const withinCooldown = lastTouch != null
    && hoursSince(signals.now, lastTouch) >= 0
    && dayDiff(signals.now, lastTouch, zone) < WB.cadence.cooldownDays
    && (!signals.lastFanMessageAt || signals.lastFanMessageAt.getTime() <= lastTouch.getTime());

  const drivers: UrgencyDriver[] = [];
  if (tab !== "service") {
    const purchase = purchaseDriver(signals);
    const expiry = expiryDriver(signals);
    const sla = slaDriver(signals, needsReply, replyUnverified);
    const intent = intentDriver(signals, needsReply);
    const cadence = withinCooldown ? null : cadenceDriver(signals, tab, quality.qEff, freeloader.frequencyMultiplier);
    const presence = presenceDriver(signals);
    const reactivation = reactivationDriver(signals, tab);
    for (const d of [purchase, expiry, sla, intent, cadence, presence, reactivation]) {
      if (d) drivers.push(d);
    }
  }

  const { score: urgencyScore, winner } = combineUrgency(drivers);
  const isPurchaseFollowup = winner?.code === "purchase" || drivers.some((d) => d.code === "purchase");

  const gated = tab !== "service" && withinCooldown && !isPurchaseFollowup;
  const secondaryStatus = tab === "service"
    ? "dont_touch_today"
    : deriveSecondaryStatus({ isPurchaseFollowup, needsReply, gated, urgency: urgencyScore });

  const rankScore = computeRankScore(tab, urgencyScore, value.score, quality.qEff, freeloader.rankPenalty);
  const severity = deriveSeverity(winner, secondaryStatus);

  const followupDueAt = isPurchaseFollowup && signals.lastPurchaseAt
    ? new Date(signals.lastPurchaseAt.getTime() + 20 * MS_PER_HOUR)
    : null;

  return {
    tab,
    massSubstate,
    valueScore: value.score,
    urgencyScore: round(urgencyScore, 2),
    rankScore,
    secondaryStatus,
    urgencySeverity: severity,
    valueTier: value.tier,
    valueConfidence: value.confidence,
    qScore: quality.q,
    qConfidence: quality.qConfidence,
    freeloaderStatus: freeloader.status,
    conversationQuality: quality.breakdown,
    needsReply,
    needsHumanTriage,
    isPurchaseFollowup,
    whyNowCode: winner?.code ?? null,
    whyNowValue: winner?.whyValue ?? null,
    reasonChips: buildReasonChips(signals, {
      tab,
      massSubstate,
      isPurchaseFollowup,
      needsReply,
      replyUnverified,
      gated,
      freeloaderStatus: freeloader.status,
      qConfidence: quality.qConfidence,
    }),
    followupDueAt,
    serviceReason,
  };
}
