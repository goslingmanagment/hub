import { describe, expect, it } from "vitest";

import { CLIENT_AUDIENCE_NEW_CLASSES, classifyClientAudienceNewEvent } from "@agency_hub_core/db";

import {
  CLIENT_AUDIENCE_SUBSCRIBE_AT_TOLERANCE_MS,
  audienceStatus,
  audienceStatusSource,
  audienceSubscribedAt,
  audienceSweepState,
  audienceThread,
  evaluateAudienceCoverage,
} from "../apps/runtime/src/services/client-audience-new.ts";
import { OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS } from "../apps/runtime/src/services/ofapi-delivery-history-signal.ts";

// chat-extension H-7c: the rules of the "new subscribers" list, as pure
// functions. The same rules over real rows are
// tests/client-audience-new.integration.test.ts.

const at = (iso: string) => new Date(iso);
const NOTIFIED = at("2026-10-04T23:08:00.000Z");

describe("which subscription events are rows", () => {
  it("classifies by the event type and OnlyFans' subType: new, new on trial, returning", () => {
    expect(classifyClientAudienceNewEvent("subscription.started", "new_subscriber")).toEqual({ kind: "new", trial: false });
    expect(classifyClientAudienceNewEvent("subscription.started", "new_subscriber_trial")).toEqual({ kind: "new", trial: true });
    expect(classifyClientAudienceNewEvent("subscription.renewed", "returning_subscriber")).toEqual({ kind: "returning", trial: false });
    expect(classifyClientAudienceNewEvent("subscription.started", "returning_subscriber")).toEqual({ kind: "returning", trial: false });
  });

  it("never lists the top-fan award, an unknown subType or an event without one (critic item 13)", () => {
    for (const [type, subType] of [
      ["subscription.started", "customer_award_for_model_top"],
      ["subscription.renewed", "customer_award_for_model_top"],
      ["subscription.started", "some_later_sub_type"],
      ["subscription.started", null],
      ["subscription.started", ""],
      ["subscription.renewed", null],
      ["subscription.ended", "new_subscriber"],
      ["message.received", "new_subscriber"],
    ] as const) {
      expect(classifyClientAudienceNewEvent(type, subType), `${type} / ${subType}`).toBeNull();
    }
  });

  it("a renewed event and a returning subType never become a row of kind new (critic item 13)", () => {
    // A renewed event that calls itself new contradicts itself: counted, not listed.
    expect(classifyClientAudienceNewEvent("subscription.renewed", "new_subscriber")).toBeNull();
    expect(classifyClientAudienceNewEvent("subscription.renewed", "new_subscriber_trial")).toBeNull();
    for (const entry of CLIENT_AUDIENCE_NEW_CLASSES) {
      if (entry.type === "subscription.renewed" || entry.subType === "returning_subscriber") {
        expect(entry.kind, `${entry.type} / ${entry.subType}`).toBe("returning");
      }
      // Only a trial subType is a trial.
      expect(entry.trial, entry.subType).toBe(entry.subType === "new_subscriber_trial");
    }
  });
});

describe("when the fan subscribed", () => {
  const swept = (start: string | null) => ({ lastSeenGeneration: 91, sourceCreatedAt: start === null ? null : at(start) });

  it("is the notification's time until a sweep has read the same subscription's own start", () => {
    // No subscription row, or one only the notification wrote (its start is the notification's time).
    expect(audienceSubscribedAt(NOTIFIED, null)).toEqual({ at: NOTIFIED, source: "notification" });
    expect(audienceSubscribedAt(NOTIFIED, { lastSeenGeneration: null, sourceCreatedAt: NOTIFIED }))
      .toEqual({ at: NOTIFIED, source: "notification" });
    // OnlyFans stamps the notification to the minute and the subscription to the second.
    expect(audienceSubscribedAt(NOTIFIED, swept("2026-10-04T23:08:41.000Z")))
      .toEqual({ at: at("2026-10-04T23:08:41.000Z"), source: "subscribeAt" });
    expect(audienceSubscribedAt(NOTIFIED, swept("2026-10-04T23:07:57.000Z")))
      .toEqual({ at: at("2026-10-04T23:07:57.000Z"), source: "subscribeAt" });
    // A sweep that read no start confirms nothing.
    expect(audienceSubscribedAt(NOTIFIED, swept(null))).toEqual({ at: NOTIFIED, source: "notification" });
  });

  it("never uses the stale start of a fan who came back, nor the start of a later subscription", () => {
    // The row still carries the start of the subscription that ended months ago.
    expect(audienceSubscribedAt(NOTIFIED, swept("2026-03-01T10:00:00.000Z")))
      .toEqual({ at: NOTIFIED, source: "notification" });
    // The fan left and subscribed again after this notification: the row describes the later one.
    expect(audienceSubscribedAt(NOTIFIED, swept("2026-10-05T09:00:00.000Z")))
      .toEqual({ at: NOTIFIED, source: "notification" });
    // The bound itself.
    const edge = new Date(NOTIFIED.getTime() + CLIENT_AUDIENCE_SUBSCRIBE_AT_TOLERANCE_MS);
    expect(audienceSubscribedAt(NOTIFIED, { lastSeenGeneration: 91, sourceCreatedAt: edge }).source).toBe("subscribeAt");
    expect(audienceSubscribedAt(NOTIFIED, { lastSeenGeneration: 91, sourceCreatedAt: new Date(edge.getTime() + 1) }).source)
      .toBe("notification");
  });
});

describe("the fan's subscription as the hub holds it", () => {
  const sweep = { generation: 91, inFlight: false };
  const subscription = (over: Record<string, unknown> = {}) => ({
    canonicalStatus: "active",
    isCurrent: true,
    endsAt: at("2026-11-04T23:08:41.000Z"),
    lastSeenAt: at("2026-10-05T00:06:33.000Z"),
    lastSeenGeneration: 91 as number | null,
    sourceCreatedAt: at("2026-10-04T23:08:41.000Z"),
    ...over,
  });

  it("says which collector the state rests on", () => {
    expect(audienceStatusSource(null, sweep)).toBe("none");
    // Only notifications ever wrote it.
    expect(audienceStatusSource(subscription({ lastSeenGeneration: null }), sweep)).toBe("webhook");
    expect(audienceStatusSource(subscription({ lastSeenGeneration: null }), null)).toBe("webhook");
    // The newest sweep saw the fan.
    expect(audienceStatusSource(subscription(), sweep)).toBe("sweep");
    // A fan who came back: an older sweep saw them, a notification reactivated the row since.
    expect(audienceStatusSource(subscription({ lastSeenGeneration: 60 }), sweep)).toBe("webhook");
    // While a sweep walks, the one before it is the newest whole one.
    expect(audienceStatusSource(subscription({ lastSeenGeneration: 90 }), { generation: 91, inFlight: true })).toBe("sweep");
    expect(audienceStatusSource(subscription({ lastSeenGeneration: 89 }), { generation: 91, inFlight: true })).toBe("webhook");
    // Not current: a notification marks the row expired, a sweep's end only retires it.
    expect(audienceStatusSource(subscription({ isCurrent: false, canonicalStatus: "expired" }), sweep)).toBe("webhook");
    expect(audienceStatusSource(subscription({ isCurrent: false, lastSeenGeneration: null }), sweep)).toBe("sweep");
  });

  it("answers the two projections side by side, and nothing where the hub holds no subscription", () => {
    expect(audienceStatus({ isSubscriber: true, subscription: subscription() }, sweep)).toEqual({
      isSubscriber: true,
      subscriptionStatus: "active",
      endsAt: "2026-11-04T23:08:41.000Z",
      asOf: "2026-10-05T00:06:33.000Z",
      source: "sweep",
    });
    expect(audienceStatus({
      isSubscriber: false,
      subscription: subscription({ isCurrent: false, canonicalStatus: "expired", endsAt: at("2026-10-05T01:00:00.000Z") }),
    }, sweep)).toMatchObject({ isSubscriber: false, subscriptionStatus: "expired", endsAt: "2026-10-05T01:00:00.000Z", source: "webhook" });
    // A row retired by a sweep keeps the status its last writer gave it, and is expired all the same.
    expect(audienceStatus({ isSubscriber: false, subscription: subscription({ isCurrent: false }) }, sweep))
      .toMatchObject({ subscriptionStatus: "expired", source: "sweep" });
    // A current row with a status the hub does not know is not called active.
    expect(audienceStatus({ isSubscriber: true, subscription: subscription({ canonicalStatus: "paused" }) }, sweep).subscriptionStatus)
      .toBe("unknown");
    // No subscription row: a fan record alone defaults to "not a subscriber" and says nothing.
    expect(audienceStatus({ isSubscriber: false, subscription: null }, sweep)).toEqual({
      isSubscriber: null, subscriptionStatus: "unknown", endsAt: null, asOf: null, source: "none",
    });
    // The fan record is missing beside a subscription: unknown, not false.
    expect(audienceStatus({ isSubscriber: null, subscription: subscription() }, sweep).isSubscriber).toBeNull();
  });

  it("never answers an instant the client's frozen pattern cannot read", () => {
    const far = audienceStatus({
      isSubscriber: true,
      subscription: subscription({ endsAt: new Date(Date.UTC(12026, 0, 1)), lastSeenAt: new Date(Number.NaN) }),
    }, sweep);
    expect(far.endsAt).toBeNull();
    expect(far.asOf).toBeNull();
  });
});

describe("the chat as the hub stores it", () => {
  it("reads the thread's own columns and names its coverage in the client's words", () => {
    expect(audienceThread(null)).toBeNull();
    const thread = {
      lastMessageAt: at("2026-10-04T23:09:00.000Z"),
      lastFanMessageAt: null,
      lastModelMessageAt: at("2026-10-04T23:09:00.000Z"),
      storedMessageCount: 1,
      messageCoverageStatus: "pending_backfill",
      messageBackfillComplete: false,
    };
    expect(audienceThread(thread)).toEqual({
      lastMessageAt: "2026-10-04T23:09:00.000Z",
      lastFanMessageAt: null,
      lastModelMessageAt: "2026-10-04T23:09:00.000Z",
      storedMessageCount: 1,
      coverage: "unknown",
      backfillComplete: false,
    });
    expect(audienceThread({ ...thread, messageCoverageStatus: "partial_window" })?.coverage).toBe("partial");
    expect(audienceThread({ ...thread, messageCoverageStatus: "complete", messageBackfillComplete: true }))
      .toMatchObject({ coverage: "complete", backfillComplete: true });
    // A status this code does not know, an object's own property name included, is unknown.
    for (const status of ["later_status", "constructor", "__proto__", ""]) {
      expect(audienceThread({ ...thread, messageCoverageStatus: status })?.coverage, status).toBe("unknown");
    }
  });
});

describe("the subscriber sweep's checkpoint", () => {
  it("reads the OFAPI audience checkpoint and nothing else", () => {
    expect(audienceSweepState({
      version: 1, mode: "ofapi_audience", generation: 91, offset: 0, pageCount: 3, observedFans: 240,
      sweepStartedAt: null, lastSweepCompletedAt: "2026-10-05T00:06:33.869Z", lastSweepUnverifiedAt: null,
    })).toEqual({ generation: 91, inFlight: false, lastCompletedAt: at("2026-10-05T00:06:33.869Z"), unverified: false });
    expect(audienceSweepState({
      version: 1, mode: "ofapi_audience", generation: 92, offset: 200, pageCount: 2, observedFans: 200,
      sweepStartedAt: "2026-10-06T00:06:00.000Z", lastSweepCompletedAt: "2026-10-05T00:06:33.869Z",
      lastSweepUnverifiedAt: "2026-10-05T00:06:33.869Z",
    })).toEqual({ generation: 92, inFlight: true, lastCompletedAt: at("2026-10-05T00:06:33.869Z"), unverified: true });
    // A first sweep still walking: nothing completed.
    expect(audienceSweepState({
      version: 1, mode: "ofapi_audience", generation: 1, offset: 100, pageCount: 1, observedFans: 100,
      sweepStartedAt: "2026-10-06T00:06:00.000Z", lastSweepCompletedAt: null, lastSweepUnverifiedAt: null,
    })).toMatchObject({ lastCompletedAt: null, inFlight: true });
    // No checkpoint, another platform's, or one that does not parse.
    for (const state of [undefined, null, {}, { version: 1, mode: "active", generation: 4318 }, "ofapi_audience"]) {
      expect(audienceSweepState(state), JSON.stringify(state)).toBeNull();
    }
    expect(audienceSweepState({
      version: 1, mode: "ofapi_audience", generation: 91, offset: 0, pageCount: 3,
      sweepStartedAt: null, lastSweepCompletedAt: "not a date", lastSweepUnverifiedAt: null,
    })?.lastCompletedAt).toBeNull();
  });
});

describe("whether the hub can vouch for the list", () => {
  const to = at("2026-10-05T12:00:00.000Z");
  const from = at("2026-10-03T12:00:00.000Z");
  const healthy = {
    from,
    to,
    delivery: { frontier: at("2026-10-05T11:52:00.000Z") },
    backlog: { pending: 0, failed: 0 },
    sweep: { lastCompletedAt: at("2026-10-05T00:06:33.869Z"), unverified: false },
  };

  it("is complete when the delivery history is current, nothing waits and a sweep has completed", () => {
    expect(evaluateAudienceCoverage(healthy)).toEqual({ state: "complete", reasons: [] });
    // The collector's normal lag is not a hole: up to its own "stuck" threshold behind the window's end.
    const atThreshold = new Date(to.getTime() - OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS);
    expect(evaluateAudienceCoverage({ ...healthy, delivery: { frontier: atThreshold } }).state).toBe("complete");
    // Checked past the window's end (a later page of an older walk).
    expect(evaluateAudienceCoverage({ ...healthy, delivery: { frontier: at("2026-10-05T12:30:00.000Z") } }).state)
      .toBe("complete");
  });

  it("is unknown without a delivery history that reaches the window", () => {
    expect(evaluateAudienceCoverage({ ...healthy, delivery: null }))
      .toEqual({ state: "unknown", reasons: ["delivery_history_off"] });
    expect(evaluateAudienceCoverage({ ...healthy, delivery: { frontier: null } }))
      .toEqual({ state: "unknown", reasons: ["delivery_history_pending"] });
    expect(evaluateAudienceCoverage({ ...healthy, delivery: { frontier: at("2026-10-03T11:59:59.999Z") } }))
      .toEqual({ state: "unknown", reasons: ["delivery_history_before_window"] });
  });

  it("is partial when the tail is unchecked, a notification is not applied or no sweep vouches", () => {
    const behind = new Date(to.getTime() - OFAPI_DELIVERY_HISTORY_AGE_THRESHOLD_MS - 1);
    expect(evaluateAudienceCoverage({ ...healthy, delivery: { frontier: behind } }))
      .toEqual({ state: "partial", reasons: ["delivery_history_behind"] });
    expect(evaluateAudienceCoverage({ ...healthy, backlog: { pending: 2, failed: 0 } }))
      .toEqual({ state: "partial", reasons: ["subscription_projection_pending"] });
    expect(evaluateAudienceCoverage({ ...healthy, backlog: { pending: 0, failed: 1 } }))
      .toEqual({ state: "partial", reasons: ["subscription_projection_failed"] });
    expect(evaluateAudienceCoverage({ ...healthy, sweep: null }))
      .toEqual({ state: "partial", reasons: ["audience_sweep_missing"] });
    expect(evaluateAudienceCoverage({ ...healthy, sweep: { lastCompletedAt: null, unverified: false } }))
      .toEqual({ state: "partial", reasons: ["audience_sweep_missing"] });
    expect(evaluateAudienceCoverage({ ...healthy, sweep: { ...healthy.sweep, unverified: true } }))
      .toEqual({ state: "partial", reasons: ["audience_sweep_unverified"] });
  });

  it("names every reason and answers the worst of them", () => {
    expect(evaluateAudienceCoverage({
      from, to, delivery: null, backlog: { pending: 1, failed: 1 }, sweep: null,
    })).toEqual({
      state: "unknown",
      reasons: [
        "delivery_history_off", "subscription_projection_pending", "subscription_projection_failed",
        "audience_sweep_missing",
      ],
    });
  });
});
