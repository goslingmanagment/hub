import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizeFanslyStatsObservation,
  canParseFanslyStatsObservation,
  diagnoseFanslyStatsObservationRejection,
} from "../apps/runtime/src/services/canonicalize/fansly-stats.ts";
import type {
  CanonicalEventDraft,
  CanonicalizableObservation,
} from "../apps/runtime/src/services/canonicalize/types.ts";

// WP-F1 — the `fansly-stats` family, over SYNTHETIC fixtures.
//
// Every committed fixture is re-keyed and cut down; the 30 MB HAR the shapes
// came from holds session tokens and is never committed. What the fixtures
// preserve is the SHAPE, including the parts that are easy to get wrong:
// seconds vs milliseconds per field, a `totalNet` that is 0 rather than absent,
// a rollup row keyed (0, 0), and a `statValue` that is a string.

const FIXTURES = path.resolve("tests/fixtures/fansly-stats");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const RECEIVED_AT = new Date("2026-08-19T18:58:00.000Z");

function observation(
  kind: string,
  payload: unknown,
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalizableObservation {
  return {
    id: 4242,
    source: "pull",
    producer: "sync:fansly:stats_snapshot",
    platform: "fansly",
    accountId: 11,
    kind,
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function collect(
  kind: string,
  payload: unknown,
  diagnostics?: { record: (code: string) => void },
): CanonicalEventDraft[] {
  return canonicalizeFanslyStatsObservation(
    observation(kind, payload),
    diagnostics === undefined
      ? { nativeAccountRefByAccountId: new Map() }
      : { nativeAccountRefByAccountId: new Map(), diagnostics },
  );
}

function ofType(drafts: CanonicalEventDraft[], type: string): CanonicalEventDraft[] {
  return drafts.filter((draft) => draft.type === type);
}

const accountStats = () => fixture("stats-account-daily.json");

describe("fansly-stats shape gate — drift stays unstamped", () => {
  const reject = (kind: string, payload: unknown) =>
    diagnoseFanslyStatsObservationRejection(observation(kind, payload));

  it("refuses a dataset whose datapoints are not arrays — an 'empty window' nothing read", () => {
    // Every parser here reads a missing `datapoints` as "no datapoints", and
    // the lanes turn two empty windows into a floor claim. So the gate and the
    // lane classifier share ONE predicate.
    const notArray = { code: "datapoints_not_array" };
    expect(reject("account_stats", { dataset: {} })).toEqual(notArray);
    expect(reject("account_stats", { dataset: { datapoints: "x", profileDatapoints: [] } }))
      .toEqual(notArray);
    expect(reject("account_stats", { dataset: { datapoints: [], profileDatapoints: {} } }))
      .toEqual(notArray);
    expect(reject("media_offer_stats", { dataset: { datasetMediaOfferId: "1" } }))
      .toEqual(notArray);
    // The served shapes, empty ones included, still pass: the per-media route
    // carries no profileDatapoints at all.
    expect(reject("account_stats", accountStats())).toBeNull();
    expect(reject("account_stats", { dataset: { datapoints: [], profileDatapoints: [] } }))
      .toBeNull();
    expect(reject("account_stats", { dataset: { datapoints: [], profileDatapoints: null } }))
      .toBeNull();
    expect(reject("media_offer_stats", fixture("media-offer-stats.json"))).toBeNull();
    expect(reject("media_offer_stats", { dataset: { datapoints: [] } })).toBeNull();
  });

  it("gates each auxiliary kind on the container its parser actually reads", () => {
    // The served shapes (prod: all 1 321 aux observations), full and empty.
    expect(reject("tracking_links", fixture("tracking-links.json").rows)).toBeNull();
    expect(reject("tracking_links", [])).toBeNull();
    expect(reject("polls", fixture("polls.json").rows)).toBeNull();
    expect(reject("recapstats", fixture("recapstats.json").rows)).toBeNull();
    expect(reject("earnings_monthlystats_snapshot", fixture("earnings-monthlystats.json").rows))
      .toBeNull();
    expect(reject("broadcast_stats", fixture("broadcast-stats.json"))).toBeNull();
    expect(reject("broadcast_stats_deleted", { messages: [] })).toBeNull();
    expect(reject("broadcast_scheduled", fixture("broadcast-scheduled.json"))).toBeNull();
    expect(reject("broadcast_scheduled", { scheduledBroadcastMessages: [] })).toBeNull();
    // A wrapped list stays tolerated where `envelopeArray` reads one.
    expect(reject("polls", { polls: [] })).toBeNull();

    // Drift: each of these used to be stamped with zero events.
    expect(reject("tracking_links", {})).toEqual({ code: "payload_not_array" });
    expect(reject("tracking_links", { links: [] })).toEqual({ code: "payload_not_array" });
    for (const kind of ["polls", "recapstats", "earnings_monthlystats_snapshot"]) {
      expect(reject(kind, {})).toEqual({ code: "payload_not_collection" });
      expect(reject(kind, { error: "x" })).toEqual({ code: "payload_not_collection" });
    }
    // An array body is parsed as `{}` by the broadcast parsers.
    expect(reject("broadcast_stats", [])).toEqual({ code: "broadcast_messages_missing" });
    expect(reject("broadcast_stats_deleted", {})).toEqual({ code: "broadcast_messages_missing" });
    expect(reject("broadcast_scheduled", { messages: [] }))
      .toEqual({ code: "broadcast_scheduled_missing" });
    // Unchanged.
    expect(reject("earnings_stats_snapshot", {})).toBeNull();
  });
});

describe("earnings", () => {
  it("emits one breakdown event per served row, gross AND net in mills", () => {
    const rows = fixture("earnings-stats.json").rows;
    const drafts = ofType(
      collect("earnings_stats_snapshot", rows),
      "earnings.breakdown_observed",
    );
    expect(drafts).toHaveLength(5);
    const tips = drafts.find((draft) => draft.data.typeCode === 7101)!;
    expect(tips.data.grossMills).toBe("250000");
    expect(tips.data.netMills).toBe("200000");
    expect(tips.data.businessDate).toBe("2026-08-19");
    expect(tips.dedupKey).toMatch(/^earnbreak:v1:11:2026-08-19:7101:[0-9a-f]{64}$/);
    // A22-2: the legacy twin keeps its OWN code. Folding 2010 into 2110 at
    // storage time would erase every legacy row's provenance, and the ledger
    // reaches back to 2025-03.
    expect(drafts.some((draft) => draft.data.typeCode === 2010)).toBe(true);
    expect(drafts.some((draft) => draft.data.typeCode === 2110)).toBe(true);
    // Money is a decimal string, never a float.
    for (const draft of drafts) {
      expect(typeof draft.data.grossMills).toBe("string");
      expect(draft.data.grossMills).toMatch(/^\d+$/);
    }
  });

  it("emits one month event per served row INCLUDING the (0,0) rollup", () => {
    const rows = fixture("earnings-monthlystats.json").rows;
    const drafts = ofType(
      collect("earnings_monthlystats_snapshot", rows),
      "earnings.month_observed",
    );
    expect(drafts).toHaveLength(3);
    const rollup = drafts.find((draft) => draft.data.isRollup === true)!;
    expect(rollup.data.year).toBe(0);
    expect(rollup.data.month).toBe(0);
    expect(rollup.data.totalGrossMills).toBe("9886800");
    expect(rollup.dedupKey).toMatch(/^earnmonth:v1:11:0:0:[0-9a-f]{64}$/);
    // Percent fields are decimal STRINGS bound for `numeric`, never floats.
    expect(rollup.data.topPercent).toBe("1.2326951023634092");
    expect(typeof rollup.data.maxTopPercent).toBe("string");
    // Unnamed served fields survive verbatim.
    expect(drafts[2]!.data.servedExtras).toMatchObject({ brackets: null });
    // A restated month is a new hash ⇒ a new event ⇒ one head update.
    const restated = JSON.parse(JSON.stringify(rows)) as Array<Record<string, unknown>>;
    restated[1]!.totalNet = 5_259_999;
    const after = ofType(
      collect("earnings_monthlystats_snapshot", restated),
      "earnings.month_observed",
    );
    const before = new Set(drafts.map((draft) => draft.dedupKey));
    expect(after.filter((draft) => !before.has(draft.dedupKey))).toHaveLength(1);
  });
});

describe("tracking links", () => {
  it("keeps totalNet NULL when the platform served 0, and keeps the served value", () => {
    const rows = fixture("tracking-links.json").rows;
    const drafts = ofType(collect("tracking_links", rows), "tracking_link.snapshot_observed");
    expect(drafts).toHaveLength(2);
    const fyp = drafts[0]!;
    expect(fyp.data.totalGrossMills).toBe("53916240");
    // 0/null = UNPOPULATED, never a zero-revenue link. The projection must not
    // be able to render "$0.00 net" from this.
    expect(fyp.data.totalNetMills).toBeNull();
    // …and the number the platform actually sent is preserved beside it, so a
    // later populated capture is distinguishable from today's silence.
    expect(fyp.data.totalNetServed).toBe(0);
    expect(fyp.data.clicks).toBe(485);
    expect(fyp.data.businessDate).toBe("2026-08-19");
    // createdAt is MILLISECONDS on this route.
    expect(fyp.data.createdAtPlatform).toBe("2025-03-01T00:12:00.000Z");
    expect(fyp.dedupKey).toMatch(/^tracklink:v1:11:000900000000000029:2026-08-19:[0-9a-f]{64}$/);
  });

  it("promotes totalNet the moment the platform populates it", () => {
    const rows = JSON.parse(
      JSON.stringify(fixture("tracking-links.json").rows),
    ) as Array<Record<string, unknown>>;
    rows[0]!.totalNet = 43_132_992;
    const drafts = ofType(collect("tracking_links", rows), "tracking_link.snapshot_observed");
    expect(drafts[0]!.data.totalNetMills).toBe("43132992");
    expect(drafts[0]!.data.totalNetServed).toBe(43_132_992);
  });
});

describe("mass DM, polls and recap (A28-5)", () => {
  it("carries per-message delivery stats and the offered prices in mills", () => {
    const drafts = ofType(
      collect("broadcast_stats", fixture("broadcast-stats.json")),
      "broadcast.stats_observed",
    );
    expect(drafts).toHaveLength(2);
    const first = drafts[0]!;
    expect(first.data).toMatchObject({
      broadcastRef: "000900000000000004",
      sourceList: "live",
      groupRef: "000900000000000005",
      statsTotal: 1420,
      statsDelivered: 1391,
      statsRead: 806,
      totalTipAmountMills: "12000",
      offeredMediaRefs: ["000900000000000006"],
    });
    // A12: saleStats.total is NET.
    expect(first.data.salesNetMills).toBe("63200");
    const prices = first.data.offerPrices as Array<Record<string, unknown>>;
    expect((prices[0]!.permissionEntries as Array<Record<string, unknown>>)[0]!.priceMills)
      .toBe("79000");
    // A broadcast names a GROUP, never a fan — nothing here is a fan ref.
    expect(first.data).not.toHaveProperty("fanRef");
    expect(first.fanIdentityRef).toBeUndefined();
  });
});

describe("additive-field tolerance", () => {
  it("ignores keys it does not know without refusing the body", () => {
    const payload = accountStats();
    (payload.dataset as Record<string, unknown>).someNewPlane = [{ id: "x" }];
    ((payload.dataset as Record<string, unknown>).profileDatapoints as Array<
      Record<string, unknown>
    >)[0]!.somethingNew = 1;
    expect(canParseFanslyStatsObservation(observation("account_stats", payload))).toBe(true);
    expect(collect("account_stats", payload).length).toBeGreaterThan(0);
  });
});
