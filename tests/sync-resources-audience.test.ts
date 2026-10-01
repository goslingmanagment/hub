import { describe, expect, it } from "vitest";

import { mapFanslySubscriptionStatus } from "@agency_hub_core/fansly";

import {
  buildFanslySubscriptionRows,
  expectedFollowersReconcileTerminalPageCount,
  findUnmappedFollowerIds,
  isStatedEmptyActiveSnapshot,
  uniqueFollowerIds,
} from "../apps/runtime/src/services/sync/audience-rules.ts";
import { captureFanslyFollowerPayload } from "../apps/runtime/src/services/sync/shared.ts";
import { prepareJournalBody, fanslyCaptureCodec } from "../apps/runtime/src/sync/fansly/capture.ts";
import { demandToUpsert, type ResourceModule } from "../apps/runtime/src/sync/engine/resource.ts";
import { fanslyResourceSpec } from "../apps/runtime/src/sync/fansly/registry.ts";
import { accountModule } from "../apps/runtime/src/sync/fansly/resources/account.ts";
import {
  lookupFollowups,
  pendingLookupIds,
  probeResolution,
} from "../apps/runtime/src/sync/fansly/resources/fan-profiles.ts";
import {
  parseFollowersHeadCursor,
  parseFollowersReconcileCursor,
} from "../apps/runtime/src/sync/fansly/resources/followers.ts";
import { parseSubscribersCursor } from "../apps/runtime/src/sync/fansly/resources/subscribers.ts";
import { advanceShadowWalk, offsetPageDone, offsetWalkPages } from "../apps/runtime/src/sync/fansly/lib/offset-walk.ts";
import { ACCOUNT_COUNTERS_MAX_AGE_MS, accountCountersFresh } from "../apps/runtime/src/sync/fansly/lib/page-facts.ts";

// The pure parts of the audience resources (design §5.1, §5.11–§5.13): the
// walk arithmetic, the rules shared with the legacy chunks, the journal the
// engine writes, and cursors that survive whatever a row holds.

const NOW = new Date("2026-10-02T12:00:00Z");

describe("offset walks", () => {
  it("end on a short page, or on the page that reaches a stated total", () => {
    expect(offsetPageDone({ offset: 0, itemCount: 43, limit: 100, total: 43 })).toBe(true);
    expect(offsetPageDone({ offset: 0, itemCount: 100, limit: 100, total: 100 })).toBe(true);
    expect(offsetPageDone({ offset: 0, itemCount: 100, limit: 100, total: 150 })).toBe(false);
    expect(offsetPageDone({ offset: 0, itemCount: 100, limit: 100, total: null })).toBe(false);
    expect(offsetPageDone({ offset: 100, itemCount: 0, limit: 100, total: null })).toBe(true);
  });

  it("estimate their pages: a stated total ends on its page, an unstated list on a short one", () => {
    expect(offsetWalkPages({ total: 43, limit: 100, statedTotal: true })).toBe(1);
    expect(offsetWalkPages({ total: 0, limit: 100, statedTotal: true })).toBe(1);
    expect(offsetWalkPages({ total: 200, limit: 100, statedTotal: true })).toBe(2);
    expect(offsetWalkPages({ total: 200, limit: 100, statedTotal: false })).toBe(3);
    expect(offsetWalkPages({ total: 18_329, limit: 100, statedTotal: false })).toBe(184);
    expect(offsetWalkPages({ total: null, limit: 100, statedTotal: false })).toBe(1);
  });

  it("simulate a walk step by step in shadow", () => {
    const first = advanceShadowWalk(null, () => 3);
    expect(first).toEqual({ progress: { steps: 3, done: 1 }, finished: false });
    const second = advanceShadowWalk(first.progress, () => 99);
    expect(second).toEqual({ progress: { steps: 3, done: 2 }, finished: false });
    expect(advanceShadowWalk(second.progress, () => 99).finished).toBe(true);
    expect(advanceShadowWalk(null, () => 0)).toEqual({ progress: { steps: 1, done: 1 }, finished: true });
  });
});

describe("the audience rules both engines apply", () => {
  it("a stated zero is an accepted, terminal, empty first page whose active total is 0", () => {
    const state = { mode: "active" as const, offset: 0, observedCount: 0 };
    const page = { contractAccepted: true, total: 0, items: [], done: true };
    expect(isStatedEmptyActiveSnapshot(state, page, false)).toBe(true);
    expect(isStatedEmptyActiveSnapshot(state, page, true)).toBe(false);
    expect(isStatedEmptyActiveSnapshot(state, { ...page, total: null }, false)).toBe(false);
    expect(isStatedEmptyActiveSnapshot({ ...state, mode: "expired" }, page, false)).toBe(false);
    expect(isStatedEmptyActiveSnapshot({ ...state, offset: 100 }, page, false)).toBe(false);
  });

  it("the reconcile's terminal page: an exact multiple ends on the empty page after it", () => {
    expect(expectedFollowersReconcileTerminalPageCount(0)).toBe(1);
    expect(expectedFollowersReconcileTerminalPageCount(99)).toBe(1);
    expect(expectedFollowersReconcileTerminalPageCount(100)).toBe(2);
    expect(expectedFollowersReconcileTerminalPageCount(1_287)).toBe(13);
  });

  it("follower ids are unique and every one must map", () => {
    const followers = [{ id: "1", followerId: "a" }, { id: "2", followerId: "a" }, { id: "3", followerId: "b" }];
    expect(uniqueFollowerIds(followers)).toEqual(["a", "b"]);
    expect(findUnmappedFollowerIds(["a", "b"], new Map([["a", 1]]))).toEqual(["b"]);
  });

  it("a subscription row per mapped subscriber, the fan's page link on the active walk only", () => {
    const item = {
      id: "s1", historyId: "h1", subscriberId: "f1", subscriptionTierId: "t", subscriptionTierName: "Tier",
      subscriptionTierColor: "#fff", planId: "p", status: 3, price: 9990, renewPrice: 4990, autoRenew: 0,
      billingCycle: 30, duration: 30, renewDate: 1_700_000_000_000, createdAt: 1_690_000_000_000,
      updatedAt: 1_695_000_000_000, endsAt: 1_710_000_000_000,
    };
    const fanMap = new Map([["f1", 7]]);
    const active = buildFanslySubscriptionRows({ platformAccountId: 3, generation: 9, mode: "active", items: [item, { ...item, id: "s2", subscriberId: "unknown" }], fanMap });
    expect(active.subscriptions).toHaveLength(1);
    expect(active.subscriptions[0]).toMatchObject({
      platformSubscriptionId: "s1", platformAccountId: 3, fanId: 7, rawStatus: 3, canonicalStatus: mapFanslySubscriptionStatus(3),
      priceMills: 9990n, renewPriceMills: 4990n, autoRenew: false, lastSeenGeneration: 9, endsAt: new Date(1_710_000_000_000),
    });
    expect(active.fanPages).toEqual([{
      fanId: 7, platformAccountId: 3, isSubscriber: true, subscriberSince: new Date(1_690_000_000_000),
      subscriptionExpiresAt: new Date(1_710_000_000_000), autoRenew: false,
    }]);
    expect(buildFanslySubscriptionRows({ platformAccountId: 3, generation: 9, mode: "expired", items: [item], fanMap }).fanPages).toEqual([]);
  });
});

describe("the engine's Fansly journal", () => {
  const request = { spec: "followers.page" as const, params: { accountId: "1", offset: 0 } };
  const module = {} as ResourceModule;

  it("journals a followers page through the [A20] trim, as the legacy lane", () => {
    const served = {
      followers: [{ id: "10", followerId: "20", lastSeenAt: 123 }],
      aggregationData: { accounts: [{ id: "20", username: "fan", displayName: "Fan", lastSeenAt: 123, followCount: 5 }] },
    };
    const body = fanslyCaptureCodec.prepare({ spec: "followers.page", kind: "followers", response: served, contractAccepted: true, request, module });
    expect(body).toEqual(captureFanslyFollowerPayload(served, true));
    expect(JSON.stringify(body)).not.toContain("lastSeenAt");
    // The served object stays whole: presence reads it.
    expect(served.followers[0]!.lastSeenAt).toBe(123);
  });

  it("wraps a refused followers body the way legacy does", () => {
    const body = fanslyCaptureCodec.prepare({ spec: "followers.page", kind: "followers", response: { followers: "x" }, contractAccepted: false, request, module });
    expect(body).toMatchObject({ contractAccepted: false });
  });

  it("names the reply walk from the request", () => {
    const replies = { spec: "post.replies" as const, params: { postId: "p1", before: null } };
    const body = fanslyCaptureCodec.prepare({ spec: "post.replies", kind: "post_replies", response: { posts: [] }, contractAccepted: true, request: replies, module });
    expect(body).toEqual(prepareJournalBody({ kind: "post_replies" }, { response: { posts: [] }, walk: { postId: "p1", before: null } }).payload);
  });
});

describe("cursors survive whatever a row holds", () => {
  it("subscribers", () => {
    expect(parseSubscribersCursor(null)).toEqual({ generation: 0, walk: null, restartCount: 0, last: null, shadow: null });
    expect(parseSubscribersCursor({ generation: 3, walk: { generation: 4 } }).walk).toBeNull();
    const walk = { generation: 4, walkStartedAt: NOW.toISOString(), offset: 100, observedCount: 100, distinctObservedCount: 99, pageCount: 1, providerReportedTotal: 150, restartCount: 1 };
    expect(parseSubscribersCursor({ generation: 4, walk }).walk).toEqual(walk);
  });

  it("followers head and reconcile", () => {
    expect(parseFollowersHeadCursor("garbage")).toEqual({ knownFollowId: null, walk: null, last: null, shadow: null });
    expect(parseFollowersHeadCursor({ knownFollowId: "9", walk: { offset: 100 } }).walk).toMatchObject({ offset: 100, processed: 0 });
    expect(parseFollowersReconcileCursor([])).toMatchObject({ generation: 0, walk: null, snapshotRestartCount: 0, lastFullSweepStartedAt: null });
    expect(parseFollowersReconcileCursor({ walk: { generation: 2 } }).walk).toBeNull();
    expect(parseFollowersReconcileCursor({ shadow: { steps: 4, done: 1 } }).shadow).toBeNull();
    expect(parseFollowersReconcileCursor({ shadow: { steps: 4, done: 1, startedAt: NOW.toISOString() } }).shadow)
      .toEqual({ steps: 4, done: 1, startedAt: NOW.toISOString() });
  });

  it("the lookup's asked ids", () => {
    expect(pendingLookupIds({ params: { ids: ["1", 2, "", "1", "3"] } })).toEqual(["1", "3"]);
    expect(pendingLookupIds({ params: null })).toEqual([]);
  });
});

describe("fan profiles", () => {
  it("a probe answer: none is unresolved, the partner is resolved, anything else says nothing", () => {
    expect(probeResolution([], "p")).toBe("unresolved");
    expect(probeResolution([{ id: "p", username: null, displayName: null }], "p")).toBe("resolved");
    expect(probeResolution([{ id: "x", username: null, displayName: null }], "p")).toBe("unknown");
  });

  it("asks the lookup walk once per id, merged into its row's params", () => {
    expect(lookupFollowups([], "subscribers.poll")).toEqual([]);
    const [signal] = lookupFollowups(["2", "1", "2"], "subscribers.poll");
    expect(signal).toEqual({ resource: "fan-profiles.lookup", ids: ["2", "1"], demand: { reason: "subscribers.poll" } });
    const upsert = demandToUpsert(signal!, fanslyResourceSpec("fan-profiles.lookup")!, { pageId: 1, shadow: false, now: NOW });
    expect(upsert).toMatchObject({ resource: "fan-profiles.lookup", kind: "goal", class: "planned", mergeParamIds: { key: "ids", ids: ["2", "1"], cap: 1_000 } });
  });
});

describe("account", () => {
  it("an identity check without its candidate never reads the page's own credentials", async () => {
    const plan = await accountModule("identity").plan({ params: {} } as never, {} as never);
    expect(plan).toEqual({ kind: "quarantine", reason: "identity_candidate_missing" });
    const withCandidate = await accountModule("identity").plan({ params: { candidate: { generation: "g1" } } } as never, {} as never);
    expect(withCandidate).toEqual({ kind: "request", request: { spec: "account.me", params: {} } });
  });

  it("the counters a walk may rely on are at most 2 h old", () => {
    expect(accountCountersFresh(null, NOW)).toBe(false);
    expect(accountCountersFresh(new Date(NOW.getTime() - ACCOUNT_COUNTERS_MAX_AGE_MS), NOW)).toBe(true);
    expect(accountCountersFresh(new Date(NOW.getTime() - ACCOUNT_COUNTERS_MAX_AGE_MS - 1), NOW)).toBe(false);
  });
});
