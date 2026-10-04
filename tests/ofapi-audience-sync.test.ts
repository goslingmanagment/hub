import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  getSyncStreamDependenciesForPage,
  getSyncStreamDependenciesForPlatform,
} from "@agency_hub_core/db";

import { parseOfapiSubscriptionPayload } from "../apps/runtime/src/services/ofapi-subscription-projection.ts";
import { toFansListPage } from "../apps/runtime/src/services/ofapi.ts";
import {
  filterOnlyFansAudienceStreams,
  isOfapiAudienceSyncEligiblePage,
  parseOfapiActiveFan,
} from "../apps/runtime/src/services/sync/ofapi-audience-sync.ts";

import { emptyOfapiAudienceCursorState, parseOfapiAudienceCursorState, ofapiAudienceQualityHoldFor } from "../apps/runtime/src/services/sync/cursor-state.ts";

describe("audience quality checkpoint", () => {
  it("defaults legacy checkpoints and preserves the durable hold and cross-chunk count", () => {
    const empty = emptyOfapiAudienceCursorState();
    expect(empty).toMatchObject({ observedFans: 0, lastSweepUnverifiedAt: null });
    const { observedFans: _count, lastSweepUnverifiedAt: _hold, ...legacy } = empty;
    expect(parseOfapiAudienceCursorState(legacy)).toEqual(empty);
    const held = { ...legacy, observedFans: 7, lastSweepUnverifiedAt: "2026-09-06T00:00:00.000Z" };
    expect(parseOfapiAudienceCursorState(held)).toEqual(held);
    expect(ofapiAudienceQualityHoldFor(held)).toBe("subscribers_empty_sweep_guard");
    expect(ofapiAudienceQualityHoldFor(empty)).toBeNull();
  });
});

const FIXTURES_DIR = path.resolve("tests/fixtures/ofapi-webhooks");

function loadFixturePayload(name: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(path.join(FIXTURES_DIR, name), "utf8")) as Record<string, unknown>;
  delete raw._meta;
  return raw.payload as Record<string, unknown>;
}

// The documented fans/active item from the OFAPI OpenAPI spec (trimmed to the
// fields the mapper reads, values from the spec example).
function specActiveFan(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 123,
    name: "name",
    username: "username",
    displayName: "",
    subscribePrice: 4.99,
    lastSeen: "2025-01-01T00:00:00+00:00",
    subscribedOnData: {
      price: 9.99,
      subscribePrice: 0,
      regularPrice: 12.5,
      subscribeAt: "2025-01-01T00:00:00+00:00",
      expiredAt: "2025-02-01T00:00:00+00:00",
      renewedAt: null,
      status: "Set to Expire",
      tipsSumm: 0,
      totalSumm: 0,
    },
    ...overrides,
  };
}

describe("parseOfapiActiveFan", () => {
  it("maps the documented fans/active item", () => {
    const fan = parseOfapiActiveFan(specActiveFan());
    expect(fan).toEqual({
      fanId: "123",
      username: "username",
      displayName: "name",
      priceDollars: 9.99,
      regularPriceDollars: 12.5,
      subscribeAt: new Date("2025-01-01T00:00:00+00:00"),
      renewedAt: null,
      expiredAt: new Date("2025-02-01T00:00:00+00:00"),
      status: "Set to Expire",
      autoRenew: false,
      lastSeenAt: new Date("2025-01-01T00:00:00+00:00"),
    });
  });

  it("treats statuses other than Set to Expire as auto-renewing", () => {
    const fan = parseOfapiActiveFan(specActiveFan({
      subscribedOnData: { status: "Active", subscribeAt: "2025-01-01T00:00:00+00:00" },
    }));
    expect(fan?.autoRenew).toBe(true);
  });

  it("leaves autoRenew unknown when subscribedOnData has no status", () => {
    const fan = parseOfapiActiveFan(specActiveFan({ subscribedOnData: null }));
    expect(fan?.autoRenew).toBeNull();
    // Falls back to the top-level subscribePrice when subscribedOnData is absent.
    expect(fan?.priceDollars).toBe(4.99);
    expect(fan?.subscribeAt).toBeNull();
  });

  it("returns null without a fan id", () => {
    expect(parseOfapiActiveFan(specActiveFan({ id: undefined }))).toBeNull();
  });
});

describe("toFansListPage", () => {
  const meta = {
    _credits: { used: 1, balance: 999 },
    _cache: { is_cached: false },
    _rate_limits: { remaining_minute: 99 },
  };

  it("unwraps the documented {data: {list, hasMore}} shape", () => {
    const page = toFansListPage({
      data: { list: [{ id: 1 }, { id: 2 }], hasMore: true },
      _pagination: { next_page: null },
      _meta: meta,
    });
    expect(page.items).toHaveLength(2);
    expect(page.hasNextPage).toBe(true);
    expect(page.meta?.creditsUsed).toBe(1);
  });

  it("falls back to a bare data array with _pagination", () => {
    const page = toFansListPage({
      data: [{ id: 1 }],
      _pagination: { next_page: "https://app.onlyfansapi.example/next" },
      _meta: meta,
    });
    expect(page.items).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
  });

  it("reports no next page when hasMore is false", () => {
    const page = toFansListPage({
      data: { list: [], hasMore: false },
      _pagination: { next_page: "https://app.onlyfansapi.example/ignored" },
      _meta: meta,
    });
    expect(page.items).toHaveLength(0);
    expect(page.hasNextPage).toBe(false);
  });
});

describe("audience eligibility and stream filtering", () => {
  const page = { platform: "onlyfans", ofapiAccountId: "acct_x" };

  it("requires the flag, the platform, and an OFAPI mapping", () => {
    expect(isOfapiAudienceSyncEligiblePage({ ofapiAudienceSyncEnabled: true }, page)).toBe(true);
    expect(isOfapiAudienceSyncEligiblePage({ ofapiAudienceSyncEnabled: false }, page)).toBe(false);
    expect(isOfapiAudienceSyncEligiblePage(undefined, page)).toBe(false);
    expect(isOfapiAudienceSyncEligiblePage(
      { ofapiAudienceSyncEnabled: true },
      { platform: "fansly", ofapiAccountId: "acct_x" },
    )).toBe(false);
    expect(isOfapiAudienceSyncEligiblePage(
      { ofapiAudienceSyncEnabled: true },
      { platform: "onlyfans", ofapiAccountId: null },
    )).toBe(false);
  });

  it("strips subscribers for non-eligible OnlyFans pages only", () => {
    const streams = ["light", "transactions", "subscribers"] as const;
    expect(filterOnlyFansAudienceStreams("fansly", streams)).toEqual([...streams]);
    expect(filterOnlyFansAudienceStreams(
      "onlyfans",
      streams,
      { ofapiAudienceSyncEnabled: true },
      { ofapiAccountId: "acct_x" },
    )).toEqual([...streams]);
    expect(filterOnlyFansAudienceStreams(
      "onlyfans",
      streams,
      { ofapiAudienceSyncEnabled: false },
      { ofapiAccountId: "acct_x" },
    )).toEqual(["light", "transactions"]);
    expect(filterOnlyFansAudienceStreams("onlyfans", streams)).toEqual(["light", "transactions"]);
  });
});

describe("platform-aware sync dependencies", () => {
  // Step 4, S4-24: the ordering is the legacy executor's, and it runs no
  // stream of a Fansly page. A Fansly page's rows are records with no
  // dependency to wait for.
  it("gives a Fansly page's streams no dependency: the executor runs none of them", () => {
    for (const stream of ["dm_conversations", "dm_messages", "top_spenders", "followers", "light"] as const) {
      expect(getSyncStreamDependenciesForPlatform("fansly", stream), stream).toEqual([]);
    }
  });

  it("keeps legacy/unmapped OnlyFans DM streams gated on their prerequisites", () => {
    expect(getSyncStreamDependenciesForPlatform("onlyfans", "dm_conversations"))
      .toEqual(["light", "top_spenders", "transactions", "subscribers"]);
    expect(getSyncStreamDependenciesForPlatform("onlyfans", "top_spenders"))
      .toEqual(["transactions"]);
    // The retired OnlyFans history crawler is no stream of the executor.
    expect(getSyncStreamDependenciesForPlatform("onlyfans", "dm_messages")).toEqual([]);
  });

  it("strips legacy prerequisites only for OFAPI-DM-eligible OnlyFans DM streams", () => {
    expect(getSyncStreamDependenciesForPage({
      platform: "onlyfans",
      stream: "dm_conversations",
      onlyFansOfapiDmEligible: true,
    })).toEqual([]);
    expect(getSyncStreamDependenciesForPage({
      platform: "onlyfans",
      stream: "top_spenders",
      onlyFansOfapiDmEligible: true,
    })).toEqual(["transactions"]);
  });
});

describe("parseOfapiSubscriptionPayload", () => {
  it("maps the live subscriptions.new payload", () => {
    const parsed = parseOfapiSubscriptionPayload(loadFixturePayload("subscriptions_new.json"));
    expect(parsed).not.toBeNull();
    expect(parsed?.fanId).toBe("1000032");
    expect(parsed?.username).toBe("fan021");
    expect(parsed?.occurredAt).toEqual(new Date("2026-06-10T18:40:00+00:00"));
    // The live capture is anonymized: subscribePrice 0 and a scrubbed {PRICE},
    // so no price claim is made.
    expect(parsed?.priceDollars).toBeNull();
    expect(parsed?.lastSeenAt).toEqual(new Date("2026-06-10T18:40:23+00:00"));
  });

  it("extracts the formatted price from the renewed docs example", () => {
    const parsed = parseOfapiSubscriptionPayload(
      loadFixturePayload("unverified_subscriptions_renewed.json"),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.fanId).toBe("34547118");
    expect(parsed?.priceDollars).toBe(4);
  });

  it("returns null when the subscriber object is missing", () => {
    expect(parseOfapiSubscriptionPayload({ user_id: "123" })).toBeNull();
  });
});
