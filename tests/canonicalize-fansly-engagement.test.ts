import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  fanslyNotificationConfidence,
  fanslyNotificationLabel,
  FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL,
  FANSLY_NOTIFICATION_DECLARED_TYPE_CODES,
  FANSLY_NOTIFICATION_DECLARED_TYPE_CSV,
  FANSLY_NOTIFICATION_LABEL_VERSION,
  FANSLY_NOTIFICATION_PURCHASE_CODES,
  FANSLY_NOTIFICATION_TYPE_GROUPS,
  FANSLY_NOTIFICATION_TYPES,
  isFanslyPurchaseNotificationType,
  isKnownFanslyNotificationType,
} from "@agency_hub_core/shared";

import {
  canonicalizeFanslyEngagementObservation,
  canParseFanslyEngagementObservation,
  FANSLY_ENGAGEMENT_CANONICALIZED_KINDS,
  FANSLY_ENGAGEMENT_EVENT_TYPES,
  FANSLY_NOTIFICATION_UNKNOWN_TYPE_DIAGNOSTIC,
  parseNotificationMetadata,
  purchasePriceMills,
} from "../apps/runtime/src/services/canonicalize/fansly-engagement.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import type {
  CanonicalEventDraft,
  CanonicalizableObservation,
} from "../apps/runtime/src/services/canonicalize/types.ts";

// WP-F2 — the `fansly-engagement` family, over SYNTHETIC fixtures.
//
// The 30 MB HAR the shapes came from holds session tokens and is never
// committed. What the fixtures preserve is the SHAPE, including the parts that
// are easy to get wrong: timestamps in SECONDS (not ms), `metadata` as a JSON
// STRING (sometimes not JSON at all, sometimes already an object), a purchase
// with no served price, and the row-type census itself.

const FIXTURES = path.resolve("tests/fixtures/fansly-engagement");

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8")) as Record<string, unknown>;
}

const RECEIVED_AT = new Date("2026-08-19T19:10:00.000Z");

function observation(
  payload: unknown,
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalizableObservation {
  return {
    id: 5150,
    source: "pull",
    producer: "sync:fansly:notifications",
    platform: "fansly",
    accountId: 11,
    kind: "notifications",
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

function collect(
  payload: unknown,
  diagnostics?: { record: (code: string) => void },
): CanonicalEventDraft[] {
  return canonicalizeFanslyEngagementObservation(
    observation(payload),
    diagnostics === undefined
      ? { nativeAccountRefByAccountId: new Map() }
      : { nativeAccountRefByAccountId: new Map(), diagnostics },
  );
}

function ofType(drafts: CanonicalEventDraft[], type: string): CanonicalEventDraft[] {
  return drafts.filter((draft) => draft.type === type);
}

function countingDiagnostics() {
  const counts = new Map<string, number>();
  return {
    counts,
    record: (code: string) => counts.set(code, (counts.get(code) ?? 0) + 1),
  };
}

const census = () => fixture("notifications-census.json");
const edges = () => fixture("notifications-edge-cases.json");

describe("A22-1: the notification label table", () => {
  it("pins the corrected code table, and the two money codes the spec never had", () => {
    // The eight codes A22-1 found the spec wrong about. Getting any of these
    // back to front is not a cosmetic error: 2007/2008 are MONEY, and the spec
    // filed them as like undo/redo.
    expect(fanslyNotificationLabel(2007)).toBe("media_purchase");
    expect(fanslyNotificationLabel(2008)).toBe("media_purchase_bundle");
    expect(fanslyNotificationLabel(1004)).toBe("post_reply");
    expect(fanslyNotificationLabel(1005)).toBe("post_quote");
    expect(fanslyNotificationLabel(1002)).toBe("post_like");
    expect(fanslyNotificationLabel(2002)).toBe("account_media_like");
    expect(fanslyNotificationLabel(15007)).toBe("expired_subscriptions");
    expect(fanslyNotificationLabel(15011)).toBe("promotions");
    // Absent from the spec ENTIRELY, and both are purchases.
    expect(fanslyNotificationLabel(32007)).toBe("locked_text_purchase");
    expect(fanslyNotificationLabel(45012)).toBe("stream_ticket_purchase");
  });

  it("marks 2007 confirmed and everything else inferred", () => {
    // The promotion rule is binding: `confirmed` needs TWO independent live
    // examples agreeing with a second source. Client code proves the CLIENT's
    // intent, not the SERVER's behaviour — so every client-derived label is
    // `inferred`, and 2007's UI↔payload match is the only exception at ship.
    expect(fanslyNotificationConfidence(2007)).toBe("confirmed");
    const confirmed = FANSLY_NOTIFICATION_TYPES
      .filter((row) => row.confidence === "confirmed")
      .map((row) => row.code);
    expect(confirmed).toEqual([2007]);
    for (const code of [2008, 32007, 45012, 1002, 2002, 1004, 1005, 5003, 15007, 15011]) {
      expect(fanslyNotificationConfidence(code), String(code)).toBe("inferred");
    }
  });

  it("gives every row a citation, because a label with no source is a guess", () => {
    for (const row of FANSLY_NOTIFICATION_TYPES) {
      expect(row.citation.length, String(row.code)).toBeGreaterThan(60);
    }
    // No duplicate codes: two rows for one code is a table that silently
    // depends on iteration order.
    const codes = FANSLY_NOTIFICATION_TYPES.map((row) => row.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("treats a DECLARED-but-unlabelled code as unknown, not as known", () => {
    // 1003 is in the client's tab map with no filter label. "We can see it" is
    // not "we can name it", and pretending otherwise would suppress the anomaly
    // that is the only signal a new code arrived.
    expect(fanslyNotificationLabel(1003)).toBe("unknown:1003");
    expect(isKnownFanslyNotificationType(1003)).toBe(false);
    expect(fanslyNotificationConfidence(1003)).toBeNull();
  });

  it("labels the 24001–24999 alert band by family and nothing else by accident", () => {
    expect(fanslyNotificationLabel(24001)).toBe(FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL);
    expect(fanslyNotificationLabel(24500)).toBe(FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL);
    expect(fanslyNotificationLabel(24999)).toBe(FANSLY_NOTIFICATION_ALERT_FAMILY_LABEL);
    // The band's edges are edges.
    expect(fanslyNotificationLabel(24000)).toBe("unknown:24000");
    expect(fanslyNotificationLabel(25000)).toBe("unknown:25000");
    // …and an unknown code outside it stays unknown rather than being absorbed.
    expect(fanslyNotificationLabel(99999)).toBe("unknown:99999");
    expect(isKnownFanslyNotificationType(99999)).toBe(false);
    expect(fanslyNotificationLabel(Number.NaN)).toBe("unknown:NaN");
  });

  it("names exactly four purchase codes", () => {
    expect([...FANSLY_NOTIFICATION_PURCHASE_CODES]).toEqual([2007, 2008, 32007, 45012]);
    for (const code of FANSLY_NOTIFICATION_PURCHASE_CODES) {
      expect(isFanslyPurchaseNotificationType(code), String(code)).toBe(true);
    }
    // A like code is NOT commerce, whatever the spec said about 2007/2008.
    for (const code of [1002, 2002, 5003, 3003, 7001]) {
      expect(isFanslyPurchaseNotificationType(code), String(code)).toBe(false);
    }
  });

  it("[A22] carries the client's FULL declared CSV, never the eight-code UI list", () => {
    // The narrow list is `15006,15016,3002,3003,7001,2007,2008,15007` — the
    // eight codes the walked UI happened to send. It silently excludes 32007
    // and 45012, BOTH of which are money, on exactly the degraded path where a
    // silent gap is least affordable.
    expect(FANSLY_NOTIFICATION_DECLARED_TYPE_CSV).toBe(
      "24001,24002,1002,2002,5003,1004,1005,7001,3002,3003,2007,2008,15006,15016,15007,15011,32007,45012",
    );
    expect(FANSLY_NOTIFICATION_DECLARED_TYPE_CODES).toHaveLength(18);
    for (const code of FANSLY_NOTIFICATION_PURCHASE_CODES) {
      expect(FANSLY_NOTIFICATION_DECLARED_TYPE_CODES, `${code} must survive the fallback`)
        .toContain(code);
    }
  });

  it("splits the declared set into groups that cover it exactly once", () => {
    const flattened = FANSLY_NOTIFICATION_TYPE_GROUPS.flatMap((group) => [...group]);
    expect(new Set(flattened).size).toBe(flattened.length);
    expect(new Set(flattened)).toEqual(new Set(FANSLY_NOTIFICATION_DECLARED_TYPE_CODES));
  });

  it("versions the table so a re-derivation is a bump, not a data rewrite", () => {
    expect(FANSLY_NOTIFICATION_LABEL_VERSION).toBe(1);
  });
});

describe("fansly-engagement family registration", () => {
  it("is registered projection-only, on its own lane, claiming `notifications`", () => {
    const family = CANONICALIZER_FAMILIES.find((entry) => entry.lane === "engagement");
    expect(family).toBeDefined();
    expect(family?.source).toBe("pull");
    expect(family?.projectionOnly).toBe(true);
    // Mutually exclusive with `mixed`: a family is one or the other.
    expect(family?.mixed).toBeUndefined();
    expect(family?.kinds).toEqual([...FANSLY_ENGAGEMENT_CANONICALIZED_KINDS]);
    expect([...FANSLY_ENGAGEMENT_CANONICALIZED_KINDS]).toEqual(["notifications"]);
  });

  it("parses an EMPTY page — the floor evidence has to be stampable", () => {
    // The empty page at the end of the deep backfill IS the retention-floor
    // proof. Refusing to stamp it would make the walk re-read it forever.
    expect(canParseFanslyEngagementObservation({
      kind: "notifications",
      accountId: 11,
      payload: { notifications: [] },
    })).toBe(true);
    expect(collect({ notifications: [] })).toEqual([]);
  });

  it("refuses a drifted shape rather than consuming it with zero events", () => {
    for (const payload of [null, {}, { notifications: "nope" }, []]) {
      expect(
        canParseFanslyEngagementObservation({ kind: "notifications", accountId: 11, payload }),
        JSON.stringify(payload),
      ).toBe(false);
    }
    expect(canParseFanslyEngagementObservation({
      kind: "notifications",
      accountId: null,
      payload: { notifications: [] },
    })).toBe(false);
  });
});

describe("layer 1: the verbatim notification event", () => {
  it("emits exactly one event per row, for every code in the §2.3 census", () => {
    const drafts = collect(census());
    const verbatim = ofType(drafts, "notification.observed");
    // 200 rows in, 200 verbatim events out. Not 199, and not "the ones we
    // recognized".
    expect(verbatim).toHaveLength(200);

    const byCode = new Map<number, number>();
    for (const draft of verbatim) {
      const code = draft.data.rawTypeCode as number;
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    }
    // The census, re-aggregated from the raw HAR 2026-08-19 (FINAL-PLAN §2.3).
    expect(Object.fromEntries([...byCode].sort((a, b) => b[1] - a[1]))).toEqual({
      3003: 97,
      2007: 30,
      15016: 26,
      7001: 26,
      15007: 15,
      2008: 6,
    });
  });

  it("carries the provider's fields and dedups on the content hash", () => {
    const drafts = ofType(collect(edges()), "notification.observed");
    const alert = drafts.find((draft) => draft.data.rawTypeCode === 24001);
    expect(alert?.data).toMatchObject({
      correlationRef: null,
      correlationGroupRef: null,
      acknowledgedAtSeconds: null,
      knownType: true,
      mappingVersion: FANSLY_NOTIFICATION_LABEL_VERSION,
    });
    const locked = drafts.find((draft) => draft.data.rawTypeCode === 32007);
    expect(locked?.dedupKey).toBe(
      `notif:v1:11:000990000000000001:${String(locked?.data.contentHash)}`,
    );
    expect(String(locked?.data.contentHash)).toMatch(/^[0-9a-f]{64}$/u);
    // A re-parse of the same body mints byte-identical keys, so a re-capture
    // appends nothing.
    expect(collect(edges()).map((draft) => draft.dedupKey))
      .toEqual(collect(edges()).map((draft) => draft.dedupKey));
  });

  it("reads timestamps as SECONDS", () => {
    const drafts = ofType(collect(edges()), "notification.observed");
    const locked = drafts.find((draft) => draft.data.rawTypeCode === 32007);
    // 1787100000 seconds, not milliseconds. Read as ms this is 1970-01-21.
    expect(locked?.data.occurredAtSeconds).toBe("2026-08-19T00:40:00.000Z");
    expect(locked?.data.acknowledgedAtSeconds).toBe("2026-08-19T00:43:20.000Z");
  });

  it("skips a row with no id or no type, and keeps the rest of the page", () => {
    // The verbatim body still holds it; what it cannot do is take a place on a
    // table keyed by notification ref.
    const drafts = ofType(collect(edges()), "notification.observed");
    expect(drafts).toHaveLength(8);
    expect(drafts.every((draft) => typeof draft.data.notificationRef === "string")).toBe(true);
  });
});

describe("metadata: parsed when it can be, preserved when it cannot", () => {
  it("parses a JSON-string object", () => {
    expect(parseNotificationMetadata("{\"accountMediaPrice\":80000}"))
      .toEqual({ accountMediaPrice: 80000 });
  });

  it("wraps a string that is not JSON as {\"raw\": …}", () => {
    expect(parseNotificationMetadata("not json at all")).toEqual({ raw: "not json at all" });
  });

  it("wraps a string that parses to a SCALAR as raw too", () => {
    // `5` in a metadata column is a shape nothing can join on, and the string
    // is preserved either way.
    expect(parseNotificationMetadata("5")).toEqual({ raw: "5" });
    expect(parseNotificationMetadata("true")).toEqual({ raw: "true" });
  });

  it("accepts metadata already served as an object", () => {
    expect(parseNotificationMetadata({ subscriptionStreak: 4 })).toEqual({ subscriptionStreak: 4 });
  });

  it("reads absent metadata as an empty object, never as a loss", () => {
    expect(parseNotificationMetadata(null)).toEqual({});
    expect(parseNotificationMetadata(undefined)).toEqual({});
    expect(parseNotificationMetadata("")).toEqual({});
  });

  it("lands both shapes on the events", () => {
    const drafts = ofType(collect(edges()), "notification.observed");
    const notJson = drafts.find((draft) => draft.data.rawTypeCode === 7001);
    expect(notJson?.data.metadataJson).toEqual({ raw: "not json at all" });
    const asObject = drafts.find((draft) => draft.data.rawTypeCode === 15016);
    expect(asObject?.data.metadataJson).toEqual({ subscriptionStreak: 4 });
  });
});

describe("layer 2: typed derivations, IN ADDITION", () => {
  it("emits a purchase signal for all four money codes, with mills through the constructor", () => {
    const purchases = ofType(collect(edges()), "media.purchase_notification_observed");
    expect(purchases.map((draft) => draft.data.rawTypeCode).sort()).toEqual([32007, 45012]);

    const locked = purchases.find((draft) => draft.data.rawTypeCode === 32007);
    // 9990 on the wire IS mills ($9.99). It travels as a decimal STRING: JSON
    // cannot carry a bigint and a float would re-open the 1000× footgun.
    expect(locked?.data.priceMills).toBe("9990");
    expect(locked?.data.confidence).toBe("inferred");
    expect(locked?.data.label).toBe("locked_text_purchase");

    // An unserved price is NULL, never 0 — a free purchase and an unmeasured
    // one are different facts.
    const ticket = purchases.find((draft) => draft.data.rawTypeCode === 45012);
    expect(ticket?.data.priceMills).toBeNull();
  });

  it("marks 2007 confirmed and 2008 inferred on the live census", () => {
    const purchases = ofType(collect(census()), "media.purchase_notification_observed");
    expect(purchases).toHaveLength(36); // 30 × 2007 + 6 × 2008
    const confirmed = purchases.filter((draft) => draft.data.confidence === "confirmed");
    expect(confirmed).toHaveLength(30);
    expect(new Set(confirmed.map((draft) => draft.data.rawTypeCode))).toEqual(new Set([2007]));
    const inferred = purchases.filter((draft) => draft.data.confidence === "inferred");
    expect(new Set(inferred.map((draft) => draft.data.rawTypeCode))).toEqual(new Set([2008]));
    // $80 rendered against 80 000 (§2.3): the wire unit is mills.
    expect(purchases.some((draft) => draft.data.priceMills === "80000")).toBe(true);
    expect(purchases.some((draft) => draft.data.priceMills === "14990")).toBe(true);
  });

  it("refuses a fractional or negative price rather than rounding one into existence", () => {
    expect(purchasePriceMills({ accountMediaPrice: 12.5 })).toBeNull();
    expect(purchasePriceMills({ accountMediaPrice: -1 })).toBeNull();
    expect(purchasePriceMills({ accountMediaPrice: "80000" })).toBeNull();
    expect(purchasePriceMills({})).toBeNull();
    expect(purchasePriceMills({ accountMediaPrice: 0 })).toBe("0");
  });

  it("emits the generic engagement event for every OTHER nameable code", () => {
    const drafts = collect(census());
    const engagement = ofType(drafts, "engagement.notification_observed");
    // 200 rows − 36 purchases.
    expect(engagement).toHaveLength(164);
    expect(new Set(engagement.map((draft) => draft.data.rawTypeCode)))
      .toEqual(new Set([3003, 15016, 7001, 15007]));
    // It claims NO field-level semantics: the code, the label, the confidence,
    // the refs, and nothing else invented.
    const follow = engagement.find((draft) => draft.data.rawTypeCode === 3003);
    expect(follow?.data.label).toBe("follow_family");
    expect(follow?.data.confidence).toBe("inferred");
  });

  it("NEVER derives a like — nothing here can write post_likes [E4]", () => {
    // The v1 plan's "2007/2008 = media-like undo/redo, flip post_likes.state"
    // is refuted (§2.3) and this is the pin that keeps it deleted. The three
    // event types are the whole surface; there is no like event to project.
    expect([...FANSLY_ENGAGEMENT_EVENT_TYPES]).toEqual([
      "notification.observed",
      "media.purchase_notification_observed",
      "engagement.notification_observed",
    ]);
    for (const payload of [census(), edges()]) {
      for (const draft of collect(payload)) {
        expect(FANSLY_ENGAGEMENT_EVENT_TYPES).toContain(
          draft.type as (typeof FANSLY_ENGAGEMENT_EVENT_TYPES)[number],
        );
        expect(JSON.stringify(draft.data)).not.toMatch(/liker|likeState|post_likes/iu);
      }
    }
  });
});

describe("unknown codes: journaled, surfaced, never dropped (A1)", () => {
  it("writes the verbatim row AND raises the anomaly", () => {
    const diagnostics = countingDiagnostics();
    const drafts = collect(edges(), diagnostics);
    const unknown = ofType(drafts, "notification.observed")
      .filter((draft) => draft.data.knownType === false);
    // 99999 (never seen) and 1003 (declared, unnameable).
    expect(unknown.map((draft) => draft.data.rawTypeCode).sort((a, b) =>
      Number(a) - Number(b)
    )).toEqual([1003, 99999]);
    expect(diagnostics.counts.get(FANSLY_NOTIFICATION_UNKNOWN_TYPE_DIAGNOSTIC)).toBe(2);
  });

  it("derives NOTHING typed from a code it cannot name", () => {
    const drafts = collect(edges());
    const refs = new Set(
      ofType(drafts, "notification.observed")
        .filter((draft) => draft.data.knownType === false)
        .map((draft) => draft.data.notificationRef),
    );
    for (const draft of drafts) {
      if (draft.type === "notification.observed") {
        continue;
      }
      expect(refs.has(draft.data.notificationRef)).toBe(false);
    }
  });
});

describe("§3.2b: receipt time, and no clamp marker anywhere", () => {
  it("dates every event at the observation instant, provider time in `data`", () => {
    const drafts = collect(edges());
    for (const draft of drafts) {
      expect(draft.occurredAt.toISOString()).toBe(RECEIVED_AT.toISOString());
    }
    // The pre-2024 row: the PROVIDER instant is 2022 and it survives, typed,
    // while the event is dated at receipt. `domain_events` is monthly
    // partitioned and a 2022-dated append would aim at a detached partition and
    // fail ExecFindPartition (23514) forever.
    const historical = ofType(drafts, "notification.observed")
      .find((draft) => draft.data.notificationRef === "000990000000000008");
    expect(historical?.data.occurredAtSeconds).toBe("2022-08-08T23:06:40.000Z");
    expect(historical?.occurredAt.toISOString()).toBe(RECEIVED_AT.toISOString());
  });

  it("carries NO occurredAtClamped and NO occurredAtRaw — their presence is the failure", () => {
    // A receipt-time draft is inside `clampDraftOccurredAt`'s window by
    // construction, so a clamp marker on THIS family would prove the family
    // dated the draft at provider time after all.
    for (const draft of [...collect(edges()), ...collect(census())]) {
      expect(Object.hasOwn(draft.data, "occurredAtClamped")).toBe(false);
      expect(Object.hasOwn(draft.data, "occurredAtRaw")).toBe(false);
    }
  });

  it("keeps every event far under the 64 KiB payload ceiling", () => {
    for (const draft of collect(census())) {
      expect(Buffer.byteLength(JSON.stringify(draft.data))).toBeLessThan(64 * 1024);
    }
  });
});
