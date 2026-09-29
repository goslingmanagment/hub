import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  FANSLY_MEDIA_STAT_TYPES,
  FANSLY_PROFILE_STAT_FAMILIES,
  FANSLY_STAT_LABEL_VERSION,
  mediaStatLabel,
  profileStatFamily,
  profileStatLabel,
  profileStatMeasure,
} from "@agency_hub_core/shared";

import {
  canonicalizeFanslyStatsObservation,
  canParseFanslyStatsObservation,
  diagnoseFanslyStatsObservationRejection,
  FANSLY_STATS_CANONICALIZED_KINDS,
  FANSLY_STATS_CANONICALIZER_VERSION,
  FANSLY_STATS_UNKNOWN_TYPE_DIAGNOSTIC,
} from "../apps/runtime/src/services/canonicalize/fansly-stats.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
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

describe("fansly-stats family registration", () => {
  it("is registered projection-only, with a unique lane, ahead of the broad pull family", () => {
    const stats = CANONICALIZER_FAMILIES.find((family) => family.lane === "stats");
    expect(stats).toBeDefined();
    expect(stats?.source).toBe("pull");
    expect(stats?.projectionOnly).toBe(true);
    expect(stats?.mixed).toBeUndefined();
    expect(stats?.parseRejection).toBe(diagnoseFanslyStatsObservationRejection);
    expect(FANSLY_STATS_CANONICALIZER_VERSION).toBe(2);
    expect(stats?.version).toBe(2);
    expect([...(stats?.kinds ?? [])]).toEqual([...FANSLY_STATS_CANONICALIZED_KINDS]);
    // The broad `sync` family claims `kinds` of its own, but ordering is what
    // guarantees a stats kind is never swallowed by a wider entry.
    const laneIndex = CANONICALIZER_FAMILIES.findIndex((family) => family.lane === "stats");
    const resultIndex = CANONICALIZER_FAMILIES.findIndex((family) => family.lane === "result");
    expect(laneIndex).toBeLessThan(resultIndex);
  });

  it("refuses a drifted body rather than consuming it with zero events", () => {
    // The driver STAMPS an observation whether or not the family produced
    // events, so a family that silently yields nothing consumes its corpus
    // irreversibly. `canParse` is what keeps a drifted payload replayable.
    expect(canParseFanslyStatsObservation(observation("account_stats", { nope: true }))).toBe(false);
    expect(canParseFanslyStatsObservation(observation("account_stats", accountStats()))).toBe(true);
    // …but an EMPTY window IS parseable: it is the retention-floor evidence,
    // and refusing to stamp it would make the sweep re-read it forever.
    expect(
      canParseFanslyStatsObservation(observation("account_stats", {
        dataset: { period: 86400000, datapoints: [], profileDatapoints: [] },
      })),
    ).toBe(true);
    expect(canParseFanslyStatsObservation(observation("account_stats", accountStats(), {
      accountId: null,
    }))).toBe(false);
  });

  it("consumes only the exact content-free account-stats terminal-null shape", () => {
    const terminalNull = { dataset: null, aggregationData: null };
    expect(canParseFanslyStatsObservation(observation("account_stats", terminalNull))).toBe(true);
    expect(collect("account_stats", terminalNull)).toEqual([]);
    expect(diagnoseFanslyStatsObservationRejection(
      observation("account_stats", terminalNull),
    )).toBeNull();

    const nearMisses = [
      { dataset: null },
      { dataset: null, aggregationData: {} },
      { dataset: null, aggregationData: null, futureField: null },
      { dataset: [], aggregationData: null },
    ];
    for (const payload of nearMisses) {
      expect(canParseFanslyStatsObservation(observation("account_stats", payload))).toBe(false);
      expect(diagnoseFanslyStatsObservationRejection(
        observation("account_stats", payload),
      )).not.toBeNull();
    }

    // The live proof is account-scoped; per-media nulls remain replayable drift.
    expect(canParseFanslyStatsObservation(
      observation("media_offer_stats", terminalNull),
    )).toBe(false);
  });
});

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

describe("profile stat labels", () => {
  it("pins the 8-code census against §2.1", () => {
    expect(FANSLY_STAT_LABEL_VERSION).toBe(2);
    expect(FANSLY_PROFILE_STAT_FAMILIES).toEqual({
      10000: "direct_timeline",
      44000: "fyp_promotion",
      44010: "suggestions",
      44030: "search",
    });
    expect(FANSLY_MEDIA_STAT_TYPES).toEqual({ 0: "fyp", 1: "direct" });
    expect([10000, 10001, 44000, 44001, 44010, 44011, 44030, 44031].map(profileStatLabel)).toEqual([
      "direct_timeline_dwell",
      "direct_timeline_visits",
      "fyp_promotion_dwell",
      "fyp_promotion_visits",
      "suggestions_dwell",
      "suggestions_visits",
      "search_dwell",
      "search_visits",
    ]);
    expect(profileStatFamily(44031)).toBe(44030);
    expect(profileStatMeasure(44031)).toBe("visits");
    expect(profileStatMeasure(44030)).toBe("dwell");
    expect([0, 1].map(mediaStatLabel)).toEqual(["fyp", "direct"]);
  });

  // THE ORDER IS THE TEST. A new member of a KNOWN family must fall to
  // `unknown:<code>`, not be absorbed into that family's label by the family
  // lookup — absorbing it relabels a metric nobody has ever seen as one we
  // understand, and the anomaly would be its only remaining trace.
  it("fires the unknown guard BEFORE the family lookup", () => {
    expect(profileStatLabel(10002)).toBe("unknown:10002");
    expect(profileStatLabel(44002)).toBe("unknown:44002");
    expect(profileStatLabel(44032)).toBe("unknown:44032");
    // …and a wholly unknown family is unknown for the ordinary reason too.
    expect(profileStatLabel(55001)).toBe("unknown:55001");
    expect(mediaStatLabel(7)).toBe("unknown:7");
  });
});

describe("account statistics → events", () => {
  it("emits one traffic datapoint per profile stat row, keyed by the RAW code", () => {
    const drafts = ofType(collect("account_stats", accountStats()), "traffic.datapoint_observed");
    expect(drafts).toHaveLength(8);
    const codes = drafts.map((draft) => draft.data.rawType).sort((a, b) => Number(a) - Number(b));
    expect(codes).toEqual([10000, 10001, 44000, 44001, 44010, 44011, 44030, 44031]);
    const timeline = drafts.find((draft) => draft.data.rawType === 10000)!;
    expect(timeline.data.views).toBe(86);
    expect(timeline.data.uniqueViewers).toBe(31);
    expect(timeline.data.interactionMs).toBe(2036202);
    expect(timeline.data.mappingVersion).toBe(FANSLY_STAT_LABEL_VERSION);
    expect(timeline.data.subjectKind).toBe("account_profile");
    // ms on this field: a seconds reading would land in 1970.
    expect(timeline.data.bucketTs).toBe("2026-08-17T00:00:00.000Z");
    expect(timeline.dedupKey).toMatch(
      /^traffic:v1:11:86400000:2026-08-17T00:00:00\.000Z:10000:[0-9a-f]{64}$/,
    );
  });

  it("writes the row for an unknown code AND raises the anomaly", () => {
    const payload = accountStats();
    const dataset = payload.dataset as Record<string, unknown>;
    const points = dataset.profileDatapoints as Array<Record<string, unknown>>;
    (points[0]!.stats as Array<Record<string, unknown>>).push({
      type: 10002,
      views: 4,
      interactionTime: 900,
      uniqueViewers: 4,
    });
    const codes: string[] = [];
    const drafts = ofType(
      collect("account_stats", payload, { record: (code) => codes.push(code) }),
      "traffic.datapoint_observed",
    );
    // A1: journaled and surfaced, NEVER dropped.
    expect(drafts).toHaveLength(9);
    const unknown = drafts.find((draft) => draft.data.rawType === 10002)!;
    expect(unknown.data.views).toBe(4);
    expect(unknown.data.knownType).toBe(false);
    expect(codes).toEqual([FANSLY_STATS_UNKNOWN_TYPE_DIAGNOSTIC]);
  });

  it("carries all eleven media metrics, with the percent stored as a raw SUM", () => {
    const drafts = ofType(
      collect("account_stats", accountStats()),
      "media_traffic.datapoint_observed",
    );
    expect(drafts).toHaveLength(2);
    const direct = drafts.find((draft) => draft.data.rawType === 1)!;
    expect(direct.data).toMatchObject({
      subjectKind: "account_media",
      views: 618,
      previewViews: 56,
      uniqueViewers: 97,
      previewUniqueViewers: 6,
      videoViews: 209,
      previewVideoViews: 7,
      interactionMs: 3393438,
      previewInteractionMs: 183616,
    });
    // `totalVideoPercentWatched` is ALREADY a sum across views on the wire (max
    // observed 1275). It is stored raw, as a decimal STRING, and divided only
    // at read time — dividing here would bake in the wrong divisor forever.
    expect(direct.data.videoPercentWatchedSum).toBe("116.01066406189152");
    expect(typeof direct.data.videoPercentWatchedSum).toBe("string");
    expect(direct.data.previewVideoPercentWatchedSum).toBe("2.584367049046767");
  });

  it("emits ONE event per top-N plane, with the window as the identity", () => {
    const drafts = ofType(collect("account_stats", accountStats()), "stats.window_top_observed");
    expect(drafts.map((draft) => draft.data.plane)).toEqual([
      "top_media",
      "top_fyp_media",
      "top_fyp_tags",
    ]);
    const topMedia = drafts[0]!;
    expect((topMedia.data.rows as unknown[])).toHaveLength(2);
    expect(topMedia.data.requestedStart).toBe("2026-08-17T00:00:00.000Z");
    expect(topMedia.data.requestedEnd).toBe("2026-08-18T00:00:00.000Z");
    expect(topMedia.dedupKey).toContain("statstop:v1:11:top_media:86400000:");
    const topTags = drafts.find((draft) => draft.data.plane === "top_fyp_tags")!;
    expect(topTags.data.tagNames).toEqual({
      "000900000000000014": "stockings",
      "000900000000000019": "lingerie",
    });
  });

  it("samples platform-global tag counters from the aggregation sidecar", () => {
    const drafts = ofType(collect("account_stats", accountStats()), "tag.counters_observed");
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.data).toMatchObject({
      tagRef: "000900000000000014",
      tagName: "stockings",
      viewCount: 1436080,
      postCount: 32196,
      source: "stats_agg",
      businessDate: "2026-08-19",
    });
    // tags[].createdAt is MILLISECONDS.
    expect(drafts[0]!.data.tagCreatedAt).toBe("2022-10-11T17:46:11.000Z");
  });

  it("emits sale stats only for the rows that carry them", () => {
    const drafts = ofType(collect("account_stats", accountStats()), "media.sale_stats_observed");
    // 1 of 2 in the fixture; 2 of 85 in the real capture. A sparse saleStats is
    // "not served", so it produces no event at all rather than a zero row.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.data).toMatchObject({
      mediaOfferRef: "000900000000000006",
      salesCount: 5,
      // A12: saleStats.total is the creator's NET share, as a mills string.
      salesNetMills: "115976",
      salesPendingMills: "0",
    });
  });

  it("re-emits the media plane with first_origin stats_agg, in F0's shapes", () => {
    const drafts = ofType(collect("account_stats", accountStats()), "media.observed");
    // 2 media + 1 bundle. Without these, creator_media.first_origin='stats_agg'
    // would name an origin no event can produce.
    expect(drafts).toHaveLength(3);
    const media = drafts.find((draft) => draft.data.subject === "media")!;
    expect(media.data.firstOrigin).toBe("stats_agg");
    expect(media.data.priceMills).toBe("35000");
    expect(media.dedupKey).toMatch(/^media:v1:11:000900000000000006:[0-9a-f]{64}$/);
    // accountMedia[].createdAt is SECONDS on these rows — the media-plane rule.
    expect(media.data.createdAtPlatform).toBe("2026-07-21T14:06:47.000Z");
    // Delivery URLs exist in the payload and must never reach an event.
    expect(JSON.stringify(media.data)).not.toContain("/000900000000000003/");
    const bundle = drafts.find((draft) => draft.data.subject === "bundle")!;
    expect(bundle.dedupKey).toMatch(/^mediabundle:v1:11:000900000000000025:[0-9a-f]{64}$/);
  });

  it("stores creatorMediaOfferLocations parsed, as pure id-relations (A17-5)", () => {
    const drafts = ofType(
      collect("account_stats", accountStats()),
      "media.offer_location_observed",
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.data).toMatchObject({
      locationRef: "000900000000000027",
      mediaOfferRef: "000900000000000006",
      mediaOfferType: 2001,
      mediaRef: "000900000000000010",
      mediaType: 2,
      correlationRef: "000900000000000028",
    });
    // This row's createdAt is MILLISECONDS, unlike accountMedia's seconds.
    expect(drafts[0]!.data.createdAtPlatform).toBe("2026-08-16T21:42:05.000Z");
  });

  it("dedups an unchanged re-fetch and mints exactly one event on a change", () => {
    const first = collect("account_stats", accountStats());
    const again = collect("account_stats", accountStats());
    expect(again.map((draft) => draft.dedupKey)).toEqual(first.map((draft) => draft.dedupKey));

    const revised = accountStats();
    const dataset = revised.dataset as Record<string, unknown>;
    const points = dataset.profileDatapoints as Array<Record<string, unknown>>;
    (points[0]!.stats as Array<Record<string, unknown>>)[0]!.views = 117;
    const changed = collect("account_stats", revised);
    const before = new Set(first.map((draft) => draft.dedupKey));
    const minted = changed.filter((draft) => !before.has(draft.dedupKey));
    expect(minted).toHaveLength(1);
    expect(minted[0]!.type).toBe("traffic.datapoint_observed");
    expect(minted[0]!.data.rawType).toBe(10001);
  });

  it("keeps every event payload under the 64 KiB sanity ceiling", () => {
    // The largest event this family can mint is a 50-row ranking. Widen the
    // fixture to the platform's own page size and check the real worst case.
    const payload = accountStats();
    const dataset = payload.dataset as Record<string, unknown>;
    const top = dataset.topMediaOffers as Array<Record<string, unknown>>;
    while (top.length < 50) {
      top.push({
        mediaOfferId: `9000000000000${String(top.length).padStart(5, "0")}`,
        mediaOfferBundleId: "0",
        views: 100 + top.length,
        previewViews: 0,
        interactionTime: 1000 * top.length,
        previewInteractionTime: 0,
      });
    }
    for (const draft of collect("account_stats", payload)) {
      expect(Buffer.byteLength(JSON.stringify(draft.data), "utf8")).toBeLessThan(64 * 1024);
    }
  });
});

describe("per-media statistics → events (WP-F4)", () => {
  const mediaStats = () => fixture("media-offer-stats.json");

  it("attributes every bucket to dataset.datasetMediaOfferId", () => {
    // THE KEY THE ROUTE ACTUALLY SERVES (6/6 live responses). The two other
    // spellings are accepted after it; a body that names the subject nowhere has
    // unattributable buckets and yields nothing — it stays in the journal.
    const drafts = ofType(collect("media_offer_stats", mediaStats()), "media_traffic.datapoint_observed");
    expect(drafts).toHaveLength(2);
    for (const draft of drafts) {
      expect(draft.data.subjectKind).toBe("media_offer");
      expect(draft.data.subjectRef).toBe("000900000000004001");
    }

    const anonymous = mediaStats();
    delete (anonymous.dataset as Record<string, unknown>).datasetMediaOfferId;
    expect(collect("media_offer_stats", anonymous)).toEqual([]);
    // …but the shape gate still accepts it, so the row stays UNSTAMPED and
    // replayable rather than being consumed with zero events.
    expect(canParseFanslyStatsObservation(observation("media_offer_stats", anonymous))).toBe(true);
  });

  it("types the seven served keys and leaves every video field NULL [E5]", () => {
    const drafts = ofType(collect("media_offer_stats", mediaStats()), "media_traffic.datapoint_observed");
    const first = drafts[0]!;
    expect(first.data.rawType).toBe(0);
    expect(first.data.views).toBe(2);
    expect(first.data.previewViews).toBe(0);
    expect(first.data.uniqueViewers).toBe(2);
    expect(first.data.previewUniqueViewers).toBe(0);
    expect(first.data.interactionMs).toBe(11856);
    expect(first.data.previewInteractionMs).toBe(0);
    // ABSENCE IS ABSENCE. All six observed responses carried NO video fields at
    // all, even for a video asset, so these are NULL and the read layer must not
    // coalesce them to 0 — that would mint a measurement nobody made.
    expect(first.data.videoViews).toBeNull();
    expect(first.data.previewVideoViews).toBeNull();
    expect(first.data.videoPercentWatchedSum).toBeNull();
    expect(first.data.previewVideoPercentWatchedSum).toBeNull();
    // The WINDOW identity travels inline — A21 deleted the per-call window
    // event, so the row carries its own window or nothing does.
    expect(first.data.periodMs).toBe(21600000);
    expect(first.data.requestedStart).toBe("2026-08-12T12:00:00.000Z");
    expect(first.data.requestedEnd).toBe("2026-08-19T12:00:00.000Z");
    expect(first.dedupKey).toContain("000900000000004001");
    expect(first.dedupKey).toContain("21600000");
  });

  it("preserves an unknown media type code AND raises the anomaly", () => {
    const payload = mediaStats();
    const points = (payload.dataset as Record<string, unknown>).datapoints as Array<
      Record<string, unknown>
    >;
    (points[0]!.stats as Array<Record<string, unknown>>)[0]!.type = 4242;
    const codes: string[] = [];
    const drafts = ofType(
      collect("media_offer_stats", payload, { record: (code) => codes.push(code) }),
      "media_traffic.datapoint_observed",
    );
    // A1: the row is written ANYWAY. Dropping it would make a platform change
    // look like silence, and the RAW code is what makes it re-derivable.
    expect(drafts.some((draft) => draft.data.rawType === 4242)).toBe(true);
    expect(drafts.find((draft) => draft.data.rawType === 4242)?.data.knownType).toBe(false);
    expect(codes).toContain(FANSLY_STATS_UNKNOWN_TYPE_DIAGNOSTIC);
  });

  it("emits one media_tag event per topFypTags row, name joined or NULL", () => {
    const drafts = ofType(collect("media_offer_stats", mediaStats()), "media_tag.stats_observed");
    expect(drafts).toHaveLength(3);
    expect(drafts.map((draft) => draft.data.tagRef)).toEqual([
      "000900000000004101",
      "000900000000004102",
      "000900000000004199",
    ]);
    expect(drafts.map((draft) => draft.data.rank)).toEqual([0, 1, 2]);
    expect(drafts[0]!.data.tagName).toBe("fixturetag-one");
    expect(drafts[0]!.data.mediaOfferRef).toBe("000900000000004001");
    expect(drafts[0]!.data.views).toBe(1);
    expect(drafts[0]!.data.interactionMs).toBe(5636);
    // THE JOIN MISSED for the third tag: aggregationData.tags[] does not carry
    // it. NULL, never fabricated from the id.
    expect(drafts[2]!.data.tagName).toBeNull();
    // The WINDOW is part of the identity: rank 2 of one window is not the same
    // fact as rank 2 of the next.
    expect(drafts[0]!.data.periodMs).toBe(21600000);
    expect(drafts[0]!.dedupKey).toContain("2026-08-19T12:00:00.000Z");
  });

  it("dedups an unchanged re-fetch and mints exactly one event on a change", () => {
    const first = collect("media_offer_stats", mediaStats());
    const again = collect("media_offer_stats", mediaStats());
    expect(again.map((draft) => draft.dedupKey)).toEqual(first.map((draft) => draft.dedupKey));

    const revised = mediaStats();
    const points = (revised.dataset as Record<string, unknown>).datapoints as Array<
      Record<string, unknown>
    >;
    (points[0]!.stats as Array<Record<string, unknown>>)[0]!.views = 9;
    const changed = collect("media_offer_stats", revised);
    const before = new Set(first.map((draft) => draft.dedupKey));
    const minted = changed.filter((draft) => !before.has(draft.dedupKey));
    // ONE new event for one changed bucket — which is what makes the head
    // update a correction rather than a rewrite.
    expect(minted).toHaveLength(1);
    expect(minted[0]!.type).toBe("media_traffic.datapoint_observed");
  });

  it("dates a pre-2024 window at RECEIPT time with no clamp marker", () => {
    // §3.2b. A receipt-time draft is by construction inside
    // clampDraftOccurredAt's window, so this family can never carry the marker —
    // its PRESENCE is the failure signal. The failure it prevents is concrete:
    // `domain_events` is monthly-partitioned, and a historical append dated at
    // provider time aims an insert at a cold or detached partition and fails
    // ExecFindPartition (23514) forever. This lane walks backwards by design, so
    // it is the one most likely to produce such an append.
    const payload = mediaStats();
    const dataset = payload.dataset as Record<string, unknown>;
    dataset.dateAfter = Date.UTC(2022, 5, 1);
    dataset.dateBefore = Date.UTC(2022, 6, 2);
    const points = dataset.datapoints as Array<Record<string, unknown>>;
    points[0]!.timestamp = Date.UTC(2022, 5, 1);
    points[1]!.timestamp = Date.UTC(2022, 5, 2);

    const drafts = collect("media_offer_stats", payload);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.occurredAt.toISOString()).toBe(RECEIVED_AT.toISOString());
      expect(draft.data).not.toHaveProperty("occurredAtClamped");
      expect(draft.data).not.toHaveProperty("occurredAtRaw");
    }
    // The TRUE provider date survives, typed, in `data` — which is what the
    // projection dates its row from.
    const traffic = ofType(drafts, "media_traffic.datapoint_observed")[0]!;
    expect(traffic.data.bucketTs).toBe("2022-06-01T00:00:00.000Z");
    expect(traffic.dedupKey).toContain("2022-06-01T00:00:00.000Z");
    expect(ofType(drafts, "media_tag.stats_observed")[0]!.data.requestedEnd).toBe(
      "2022-07-02T00:00:00.000Z",
    );
  });

  it("keeps every per-media event under the 64 KiB sanity ceiling", () => {
    // The worst case here is a full 100-bucket window (`datapointLimit: 100`)
    // with the platform's own 25-row tag page. Every event is PER ROW, so the
    // ceiling is never close — which is exactly what the assertion is for.
    const payload = mediaStats();
    const dataset = payload.dataset as Record<string, unknown>;
    const points = dataset.datapoints as Array<Record<string, unknown>>;
    while (points.length < 100) {
      points.push({
        timestamp: 1787140800000 - points.length * 21_600_000,
        stats: [{
          type: 0,
          views: points.length,
          previewViews: 0,
          interactionTime: 1000 * points.length,
          previewInteractionTime: 0,
          uniqueViewers: points.length,
          previewUniqueViewers: 0,
        }],
      });
    }
    const tags = dataset.topFypTags as Array<Record<string, unknown>>;
    while (tags.length < 25) {
      tags.push({
        tagId: `00090000000042${String(100 + tags.length)}`,
        views: tags.length,
        previewViews: 0,
        interactionTime: 100 * tags.length,
        previewInteractionTime: 0,
      });
    }
    const drafts = collect("media_offer_stats", payload);
    expect(drafts.length).toBe(125);
    for (const draft of drafts) {
      expect(Buffer.byteLength(JSON.stringify(draft.data), "utf8")).toBeLessThan(64 * 1024);
    }
  });
});

describe("time semantics (§3.2b)", () => {
  // A receipt-time draft is by construction inside clampDraftOccurredAt's
  // window, so this family can NEVER produce a clamp marker. The marker's
  // PRESENCE would prove the family dated its drafts at provider time after
  // all — which is what aims a historical append at a detached partition.
  it("dates every event at receipt time and keeps the provider instant in data", () => {
    const payload = accountStats();
    const dataset = payload.dataset as Record<string, unknown>;
    // A pre-2024 provider window: 2022-06-01 → 2022-06-02.
    dataset.dateAfter = Date.UTC(2022, 5, 1);
    dataset.dateBefore = Date.UTC(2022, 5, 2);
    const points = dataset.profileDatapoints as Array<Record<string, unknown>>;
    points[0]!.timestamp = Date.UTC(2022, 5, 1);
    const mediaPoints = dataset.datapoints as Array<Record<string, unknown>>;
    mediaPoints[0]!.timestamp = Date.UTC(2022, 5, 1);

    const drafts = collect("account_stats", payload);
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) {
      expect(draft.occurredAt.toISOString()).toBe(RECEIVED_AT.toISOString());
      // No clamp marker, and no preserved raw instant — their presence is the
      // failure signal for a receipt-time family.
      expect(draft.data).not.toHaveProperty("occurredAtClamped");
      expect(draft.data).not.toHaveProperty("occurredAtRaw");
    }
    const traffic = ofType(drafts, "traffic.datapoint_observed")[0]!;
    // The TRUE provider date survives, typed, in `data` — which is what the
    // projection dates its row from.
    expect(traffic.data.bucketTs).toBe("2022-06-01T00:00:00.000Z");
    expect(traffic.dedupKey).toContain("2022-06-01T00:00:00.000Z");
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

describe("discovery feed", () => {
  it("takes the tag counters and nothing else from the sample", () => {
    const drafts = collect("discovery_feed", fixture("discovery-feed.json"));
    expect(new Set(drafts.map((draft) => draft.type))).toEqual(new Set(["tag.counters_observed"]));
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.data.source).toBe("discovery");
    expect(drafts[0]!.data.viewCount).toBe(16037372);
    // The same tag observed through both sources on the same day is ONE row per
    // (page, tag, date) — the later capture wins on captured_at.
    expect(drafts[1]!.data.tagRef).toBe("000900000000000014");
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

  it("keeps the withdrawn list distinguishable from the live one", () => {
    const drafts = ofType(
      collect("broadcast_stats_deleted", fixture("broadcast-stats.json")),
      "broadcast.stats_observed",
    );
    expect(drafts[0]!.data.sourceList).toBe("deleted");
    // Same broadcast, different list ⇒ a different content hash ⇒ a new event
    // and a head update, not a silent overwrite of the live row.
    const live = ofType(
      collect("broadcast_stats", fixture("broadcast-stats.json")),
      "broadcast.stats_observed",
    );
    expect(drafts[0]!.dedupKey).not.toBe(live[0]!.dedupKey);
  });

  it("preserves unnamed fields on the scheduled route", () => {
    const drafts = ofType(
      collect("broadcast_scheduled", fixture("broadcast-scheduled.json")),
      "broadcast.scheduled_observed",
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.data.sourceList).toBe("scheduled");
    expect(drafts[0]!.data.scheduledFor).toBe("2026-08-18T02:26:40.000Z");
    expect(drafts[0]!.data.servedExtras).toMatchObject({
      someUnnamedFutureField: "kept-verbatim",
    });
  });

  it("keeps poll options and their vote counts verbatim", () => {
    const drafts = ofType(collect("polls", fixture("polls.json").rows), "poll.observed");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.data.options).toEqual([
      { optionRef: "000900000000000016", optionOrdinal: 0, title: "Latex", voteCount: 412 },
      { optionRef: "000900000000000017", optionOrdinal: 1, title: "Stockings", voteCount: 388 },
    ]);
  });

  it("stores recap statValue as a STRING, never coerced", () => {
    const drafts = ofType(collect("recapstats", fixture("recapstats.json").rows), "recap.stat_observed");
    expect(drafts).toHaveLength(3);
    const numeric = drafts.find((draft) => draft.data.statRef === "recap_messages_sent")!;
    // It LOOKS numeric. It stays a string, because a recap value can be a
    // count, a duration, a name or a formatted phrase and parsing one is a
    // guess about which.
    expect(numeric.data.statValue).toBe("18402");
    expect(typeof numeric.data.statValue).toBe("string");
    expect(numeric.data.statValueWasString).toBe(true);
    const duration = drafts.find((draft) => draft.data.statRef === "recap_watch_time")!;
    expect(duration.data.statValue).toBe("3d 14h 22m");
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
