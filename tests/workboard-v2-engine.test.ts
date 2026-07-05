import { describe, expect, it } from "vitest";

import { isClosingMessage } from "../apps/runtime/src/modules/workboard/index.ts";
import {
  WB,
  combineUrgency,
  computeFreeloader,
  computeQuality,
  computeValue,
  deriveTab,
  evaluateFan,
} from "../apps/runtime/src/modules/workboard/index.ts";
import type { FanSignals } from "../apps/runtime/src/modules/workboard/index.ts";

const FSM_CTX = { q: 0, qConfidence: "low" as const, freeloaderStatus: "none" as const };

const NOW = new Date("2026-05-29T12:00:00.000Z");
const DAY = 86_400_000;
const HOUR = 3_600_000;

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}
function hoursAgo(n: number): Date {
  return new Date(NOW.getTime() - n * HOUR);
}
function inDays(n: number): Date {
  return new Date(NOW.getTime() + n * DAY);
}
const dollars = (n: number): bigint => BigInt(Math.round(n * 1000));

function makeSignals(overrides: Partial<FanSignals> = {}): FanSignals {
  return {
    now: NOW,
    timeZone: "UTC",
    ltvMills: 0n,
    lastTransactionAt: null,
    spend30Mills: 0n,
    spend90Mills: 0n,
    alaCarteShare90: 0,
    isSubscriber: false,
    subscriptionExpiresAt: null,
    autoRenew: null,
    subscriptionPriceMills: null,
    followerSince: daysAgo(3),
    hasEverFanMessaged: false,
    flags: [],
    lastPurchaseAt: null,
    lastPurchaseNetMills: null,
    lastPurchaseType: null,
    lastMessageSenderRole: "unknown",
    lastFanMessageAt: null,
    lastModelMessageAt: null,
    tailContent: null,
    storedMessageCount: 0,
    messageCoverageStatus: "complete",
    modelMsgCount: 0,
    fanMsgCount: 0,
    unknownMsgCount: 0,
    initiatorRole: "unknown",
    avgReplyGapHours: null,
    priorQScore: null,
    l2NeedsReply: null,
    freeloaderConv90: 0,
    lifetimeFreeEpisodes: 0,
    convertedRecently: false,
    lastProductiveContactAt: null,
    externalPresenceAt: null,
    externalPresenceObservedAt: null,
    presenceFeedTruncated: false,
    snoozedUntil: null,
    refundCooldownUntil: null,
    massSubstate: null,
    reactivationAttemptedAt: null,
    freeloaderStatus: "none",
    ...overrides,
  };
}

describe("L1 closing detector", () => {
  it("treats openers / real questions as needing a reply", () => {
    for (const opener of ["hi", "hey", "you up?", "when?", "what are you doing tonight", "miss you 😘 call me?"]) {
      expect(isClosingMessage(opener)).toBe(false);
    }
  });

  it("treats closings, combos, and emoji-only as closing", () => {
    for (const closing of ["ok", "okay", "thanks", "ty", "thanks!", "ok thanks", "gn", "bye", "lol", "спасибо", "пока", "ага", "ty 😘", "😘", "👍", "❤️🙂"]) {
      expect(isClosingMessage(closing)).toBe(true);
    }
  });

  it("does not suppress on empty / missing content", () => {
    expect(isClosingMessage(null)).toBe(false);
    expect(isClosingMessage("")).toBe(false);
    expect(isClosingMessage("   ")).toBe(false);
  });

  it("does NOT suppress bare affirmatives — after a sales prompt they are a conversion (L2 judges them in context)", () => {
    for (const affirm of ["yes", "yeah", "yep", "yup", "sure", "да", "давай"]) {
      expect(isClosingMessage(affirm)).toBe(false);
    }
    // Pure acks that almost never answer a sales question stay closings (keep L1 useful).
    for (const ack of ["ok", "ладно", "ага", "thanks"]) {
      expect(isClosingMessage(ack)).toBe(true);
    }
  });
});

describe("value axis", () => {
  it("recency-decays a dormant whale below an actively-spending one of equal LTV", () => {
    const base = { ltvMills: dollars(2000) } as const;
    const active = computeValue(makeSignals({ ...base, lastTransactionAt: daysAgo(2), spend30Mills: dollars(200), spend90Mills: dollars(400), alaCarteShare90: 0.8 }));
    const dormant = computeValue(makeSignals({ ...base, lastTransactionAt: daysAgo(300) }));
    expect(active.score).toBeGreaterThan(dormant.score);
    expect(active.tier).toBe("whale");
  });

  it("applies flag bonuses and labels whales by flag even when dormant", () => {
    const withFlag = computeValue(makeSignals({ ltvMills: dollars(500), lastTransactionAt: daysAgo(10), flags: ["whale"] }));
    const without = computeValue(makeSignals({ ltvMills: dollars(500), lastTransactionAt: daysAgo(10) }));
    expect(withFlag.score).toBeGreaterThan(without.score);
    expect(withFlag.tier).toBe("whale");
  });

  it("gives a cold-start floor to a brand-new high-tier subscriber with no LTV", () => {
    const value = computeValue(makeSignals({ isSubscriber: true, subscriptionPriceMills: dollars(50), followerSince: daysAgo(1) }));
    expect(value.score).toBeGreaterThan(0);
    expect(value.confidence).toBe("low"); // no realized spend yet
  });
});

describe("urgency drivers", () => {
  it("SLA cap is structurally below imminent-expiry and fresh-purchase ceilings", () => {
    expect(WB.urgency.sla.cap).toBeLessThan(88); // expiry @1d
    expect(WB.urgency.sla.cap).toBeLessThan(WB.urgency.purchase.base); // purchase @0h
  });

  it("combine = dominant + capped bonus (never leaps a tier)", () => {
    const combined = combineUrgency([
      { code: "expiry", value: 80, whyValue: 3 },
      { code: "cadence", value: 40, whyValue: 20 },
      { code: "sla", value: 40, whyValue: 10 },
    ]);
    // max 80 + min(8, 0.25*(40+40)=20) = 88
    expect(combined.score).toBe(88);
    expect(combined.winner?.code).toBe("expiry");
  });

  it("ignores a refund/chargeback as a purchase spike (settlement-aware)", () => {
    const refunded = evaluateFan(makeSignals({
      ltvMills: dollars(150),
      lastPurchaseAt: hoursAgo(1),
      lastPurchaseType: "refund",
      lastPurchaseNetMills: dollars(-20),
    }));
    expect(refunded.isPurchaseFollowup).toBe(false);
  });
});

describe("tab derivation (FSM)", () => {
  it("routes by lifecycle state", () => {
    expect(deriveTab(makeSignals({ isSubscriber: true, subscriptionExpiresAt: inDays(10) }), FSM_CTX).tab).toBe("subscribers");
    expect(deriveTab(makeSignals({ ltvMills: dollars(250) }), FSM_CTX).tab).toBe("spenders");
  });

  it("routes any paying fan to spenders and never-paid to mass (spec: 'anyone who has ever paid')", () => {
    expect(deriveTab(makeSignals({ ltvMills: dollars(5), followerSince: daysAgo(2) }), FSM_CTX).tab).toBe("spenders");
    expect(deriveTab(makeSignals({ ltvMills: 0n, followerSince: daysAgo(2) }), FSM_CTX).tab).toBe("fresh_mass");
  });

  it("sends snoozed fans to service", () => {
    const r = deriveTab(makeSignals({ ltvMills: dollars(250), snoozedUntil: inDays(3) }), FSM_CTX);
    expect(r.tab).toBe("service");
    expect(r.serviceReason).toBe("snoozed");
  });
});

describe("hard cases (design §appendix)", () => {
  it("(1) renew-off sub expiring in 2d is a top-of-Subscribers ACT NOW", () => {
    const e = evaluateFan(makeSignals({
      isSubscriber: true,
      subscriptionExpiresAt: inDays(2),
      autoRenew: false,
      subscriptionPriceMills: dollars(20),
      ltvMills: dollars(1240),
      lastTransactionAt: daysAgo(60),
    }));
    expect(e.tab).toBe("subscribers");
    expect(e.urgencyScore).toBeGreaterThanOrEqual(85);
    expect(e.urgencySeverity).toBe("high");
    expect(e.reasonChips).toContain("renew_off");
    expect(e.reasonChips).toContain("expires_soon");
  });

  it("(3) mass 'hi' is visible but capped and lives in a DIFFERENT tab than the renew-off sub", () => {
    const massHi = evaluateFan(makeSignals({
      followerSince: daysAgo(2),
      hasEverFanMessaged: true,
      lastMessageSenderRole: "fan",
      lastFanMessageAt: hoursAgo(12),
      tailContent: "hi",
      storedMessageCount: 1,
      messageCoverageStatus: "partial_window",
    }));
    expect(massHi.tab).toBe("fresh_mass");
    expect(massHi.needsReply).toBe(true);
    expect(massHi.urgencyScore).toBeLessThanOrEqual(WB.urgency.sla.cap);
    // Structural anti-flattening: it cannot share a list with a subscriber.
    expect(massHi.tab).not.toBe("subscribers");
  });

  it("(5) a PPV bought 1h ago floats to the top as a purchase follow-up", () => {
    const e = evaluateFan(makeSignals({
      ltvMills: dollars(120),
      lastPurchaseAt: hoursAgo(1),
      lastPurchaseType: "message_purchase",
      lastPurchaseNetMills: dollars(25),
    }));
    expect(e.tab).toBe("spenders");
    expect(e.isPurchaseFollowup).toBe(true);
    expect(e.secondaryStatus).toBe("recent_purchase");
    expect(e.urgencyScore).toBeGreaterThanOrEqual(90);
  });

  it("(6) cold-start fan is hedged (no scary urgency, low confidence)", () => {
    const e = evaluateFan(makeSignals({
      isSubscriber: true,
      subscriptionExpiresAt: inDays(40),
      subscriptionPriceMills: dollars(50),
      storedMessageCount: 0,
      messageCoverageStatus: "pending_backfill",
    }));
    expect(e.valueConfidence).toBe("low");
    expect(e.reasonChips).toContain("cold_start");
  });
});

describe("conversation quality Q", () => {
  it("rewards a balanced, fan-initiated, fast 1:1 chat and penalizes a model-skewed monologue", () => {
    const healthy = computeQuality(makeSignals({
      modelMsgCount: 6,
      fanMsgCount: 7,
      initiatorRole: "fan",
      lastMessageSenderRole: "fan",
      tailContent: "what are you up to tonight?",
      avgReplyGapHours: 0.5,
      storedMessageCount: 13,
      messageCoverageStatus: "complete",
    }));
    const forced = computeQuality(makeSignals({
      modelMsgCount: 12,
      fanMsgCount: 2,
      initiatorRole: "model",
      lastMessageSenderRole: "model",
      avgReplyGapHours: 90,
      storedMessageCount: 14,
      messageCoverageStatus: "complete",
    }));
    expect(healthy.q).toBeGreaterThan(0.5);
    expect(healthy.breakdown.ratioHealth).toBe("balanced");
    expect(forced.q).toBeLessThan(0);
    expect(forced.breakdown.ratioHealth).toBe("model_skew");
  });

  it("damps Q to ~0 on thin coverage (a lone 'hi' has no quality opinion)", () => {
    const thin = computeQuality(makeSignals({
      fanMsgCount: 1,
      initiatorRole: "fan",
      lastMessageSenderRole: "fan",
      tailContent: "hi",
      storedMessageCount: 1,
      messageCoverageStatus: "partial_window",
    }));
    expect(thin.qConfidence).toBe("low");
    expect(thin.qEff).toBe(0);
  });
});

describe("freeloader sliding window", () => {
  it("throttles at the window cap with no conversion, and clears on a conversion", () => {
    const throttled = computeFreeloader({ conv90: 11, converted: false, qEff: 0, priorQ: null, latencyHours: 48, lifetime: 11 });
    expect(throttled.status).toBe("freeloader");
    expect(throttled.frequencyMultiplier).toBe(WB.freeloader.frequencyMultiplier);
    expect(throttled.rankPenalty).toBeGreaterThan(0);

    const converted = computeFreeloader({ conv90: 11, converted: true, qEff: 0, priorQ: null, latencyHours: 48, lifetime: 11 });
    expect(converted.status).toBe("none");
    expect(converted.frequencyMultiplier).toBe(1);
  });

  it("suppresses the suppression for an actively-converting fan (high/rising Q + fast replies)", () => {
    const hot = computeFreeloader({ conv90: 12, converted: false, qEff: 0.6, priorQ: 0.1, latencyHours: 2, lifetime: 12 });
    expect(hot.status).not.toBe("freeloader");
    expect(hot.status).not.toBe("ceiling");
  });

  it("has a cooling ramp between 7 and 10 conversation-days", () => {
    const cooling = computeFreeloader({ conv90: 8, converted: false, qEff: 0, priorQ: null, latencyHours: 48, lifetime: 8 });
    expect(cooling.status).toBe("cooling");
    expect(cooling.frequencyMultiplier).toBeLessThan(1);
    expect(cooling.frequencyMultiplier).toBeGreaterThanOrEqual(0.25);
  });
});

describe("L2 closing classifier → needs_reply", () => {
  const tail = (overrides: Partial<FanSignals>) =>
    makeSignals({
      hasEverFanMessaged: true,
      followerSince: daysAgo(3),
      lastMessageSenderRole: "fan",
      tailContent: "when are you free?",
      ...overrides,
    });

  it("fresh (<24h) tail defaults to needs-reply and is NOT marked unverified", () => {
    const e = evaluateFan(tail({ lastFanMessageAt: hoursAgo(2), l2NeedsReply: null }));
    expect(e.needsReply).toBe(true);
    expect(e.reasonChips).not.toContain("unverified");
  });

  it(">24h tail not yet classified → needs-reply but flagged unverified", () => {
    const e = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: null }));
    expect(e.needsReply).toBe(true);
    expect(e.reasonChips).toContain("unverified");
  });

  it(">24h tail the classifier marked closing → no needs-reply", () => {
    const e = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: false }));
    expect(e.needsReply).toBe(false);
    expect(e.reasonChips).not.toContain("replies_waiting");
  });

  it("a buy_signal tail outranks a plain stale need-reply and reads as critical", () => {
    const buy = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: true, l2State: "buy_signal" }));
    const plain = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: true, l2State: null }));
    expect(buy.whyNowCode).toBe("buy_signal");
    expect(buy.urgencyScore).toBeGreaterThan(plain.urgencyScore);
    expect(buy.urgencySeverity).toBe("critical");
    expect(buy.reasonChips).toContain("buy_signal");
  });

  it("a complaint tail is high-severity and surfaces its chip", () => {
    const e = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: true, l2State: "complaint" }));
    expect(e.whyNowCode).toBe("complaint");
    expect(e.urgencySeverity).toBe("high");
    expect(e.reasonChips).toContain("complaint");
  });

  it("a cold tail that still 'needs a reply' is damped below an equally-aged neutral one", () => {
    const cold = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: true, l2State: "cold" }));
    const neutral = evaluateFan(tail({ lastFanMessageAt: hoursAgo(48), l2NeedsReply: true, l2State: null }));
    expect(cold.needsReply).toBe(true);
    expect(cold.urgencyScore).toBeLessThan(neutral.urgencyScore);
  });

  it("a productive touch (Готово) at/after the fan's last message clears needs-reply (live board)", () => {
    const base = {
      hasEverFanMessaged: true,
      followerSince: daysAgo(3),
      lastMessageSenderRole: "fan" as const,
      tailContent: "when are you free?",
      lastFanMessageAt: hoursAgo(48),
    };
    expect(evaluateFan(makeSignals(base)).needsReply).toBe(true);
    // chatter pressed Готово 1h ago (after the fan's 48h-old message) → handled
    const handled = evaluateFan(makeSignals({ ...base, lastProductiveContactAt: hoursAgo(1) }));
    expect(handled.needsReply).toBe(false);
    expect(handled.reasonChips).not.toContain("replies_waiting");
  });
});
