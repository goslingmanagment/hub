import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  canonicalizeFanslyCatalogObservation,
  canParseFanslyCatalogObservation,
  FANSLY_AUTOMATION_TEMPLATE_FALLBACK_DIAGNOSTIC,
  FANSLY_CATALOG_CANONICALIZED_KINDS,
  FANSLY_CATALOG_EVENT_TYPES,
  parseAutomationTemplate,
  parseAutomationTriggerMetadata,
} from "../apps/runtime/src/services/canonicalize/fansly-catalog.ts";
import { CANONICALIZER_FAMILIES } from "../apps/runtime/src/services/canonicalize/index.ts";
import { WRITTEN_OBSERVATION_KINDS } from "../apps/runtime/src/services/observation-kinds.ts";
import type {
  CanonicalEventDraft,
  CanonicalizableObservation,
} from "../apps/runtime/src/services/canonicalize/types.ts";

// WP-F3 — the `fansly-catalog` family, fixture by fixture.
//
// The four things this file is actually guarding, because they are the four
// ways this family can be wrong in a way `pnpm check` would otherwise call fine:
//
// 1. THE PRICE. `plans[].price`, never `tier.price` — the live capture had all
//    five tiers at `tier.price = 5000` while plans ran to 499 990. A parser
//    that read the tier head would report every page as a $5 page.
// 2. THE FIELD NAME. `plans[].billingCycle`, not `plans[].duration` — the plan
//    document says `duration` and the payload has no such key. `duration` DOES
//    exist on `promos[]`, one level down, which is how the mistake happens.
// 3. THE UNITS. One response mixes seconds and milliseconds. A single
//    heuristic that guesses right today is a 1970 row the day it changes.
// 4. THE URLS. Two of these shapes embed raw media with signed CDN locations.
//    No event may carry one.

const FIXTURES = path.resolve("tests/fixtures/fansly-catalog");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as unknown;
}

const RECEIVED_AT = new Date("2026-08-22T09:00:00.000Z");

function observation(kind: string, payload: unknown): CanonicalizableObservation {
  return {
    id: 1,
    source: "pull",
    producer: "sync",
    platform: "fansly",
    accountId: 7,
    kind,
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
  };
}

function drafts(kind: string, payload: unknown, diagnostics?: string[]): CanonicalEventDraft[] {
  return canonicalizeFanslyCatalogObservation(observation(kind, payload), {
    nativeAccountRefByAccountId: new Map(),
    ...(diagnostics === undefined
      ? {}
      : { diagnostics: { record: (code: string) => void diagnostics.push(code) } }),
  });
}

function ofType(list: readonly CanonicalEventDraft[], type: string): CanonicalEventDraft[] {
  return list.filter((draft) => draft.type === type);
}

function roster(list: readonly CanonicalEventDraft[], listingKind: string): CanonicalEventDraft {
  const found = ofType(list, "catalog.listing_observed")
    .find((draft) => draft.data.listingKind === listingKind);
  expect(found, `roster ${listingKind}`).toBeDefined();
  return found!;
}

/** Every string anywhere in a value, so a URL cannot hide in a nested array. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) allStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) allStrings(item, out);
  }
  return out;
}

function allKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      out.push(key);
      allKeys(item, out);
    }
  }
  return out;
}

describe("fansly-catalog family registration", () => {
  it("claims exactly the nine catalog kinds, and every one is a registered writer", () => {
    expect([...FANSLY_CATALOG_CANONICALIZED_KINDS]).toEqual([
      "vault_albums",
      "uservault_albums",
      "subscription_tiers",
      "gift_codes",
      "automated_messages",
      "account_walls",
      "vault_media",
      "account_media_batch",
      "account_media_bundle_batch",
    ]);
    const written = new Set(WRITTEN_OBSERVATION_KINDS.map((entry) => entry.kind));
    for (const kind of FANSLY_CATALOG_CANONICALIZED_KINDS) {
      expect(written.has(kind), `${kind} registered in observation-kinds`).toBe(true);
    }
  });

  it("is registered as a projection-only pull family on its own lane", () => {
    const family = CANONICALIZER_FAMILIES.find((entry) => entry.lane === "catalog");
    expect(family).toBeDefined();
    expect(family?.source).toBe("pull");
    expect(family?.projectionOnly).toBe(true);
    expect(family?.kinds).toEqual([...FANSLY_CATALOG_CANONICALIZED_KINDS]);
  });

  it("emits only its declared event types, and never mints media.observed itself", () => {
    const declared = new Set<string>(FANSLY_CATALOG_EVENT_TYPES);
    // `media.observed` is F0(b)'s type, reused verbatim by the vault walk and
    // the batch hydration. It is deliberately NOT in this family's declared
    // list, because the MEDIA PLANE owns it — declaring it here would make the
    // projection registry's ownership claim untrue.
    expect(declared.has("media.observed")).toBe(false);
    const everything = [
      ...drafts("vault_albums", fixture("vault-albums")),
      ...drafts("uservault_albums", fixture("uservault-albums")),
      ...drafts("subscription_tiers", fixture("subscription-tiers")),
      ...drafts("gift_codes", fixture("gift-codes")),
      ...drafts("automated_messages", fixture("automated-messages")),
      ...drafts("account_walls", fixture("account-walls")),
      ...drafts("vault_media", fixture("vault-media-page")),
    ];
    for (const draft of everything) {
      expect(declared.has(draft.type), draft.type).toBe(true);
    }
  });
});

describe("fansly-catalog: vaults", () => {
  const list = drafts("vault_albums", fixture("vault-albums"));

  it("emits one album event per album, keyed by vault kind", () => {
    const albums = ofType(list, "vault.album_observed");
    expect(albums).toHaveLength(6);
    for (const album of albums) {
      expect(album.data.vaultKind).toBe("creator");
      expect(album.dedupKey).toMatch(/^album:v1:7:creator:0009\d{14}:[0-9a-f]{64}$/u);
    }
  });

  it("keeps the system albums' NULL title and RAW type code", () => {
    const albums = ofType(list, "vault.album_observed");
    const system = albums.filter((album) => album.data.albumType !== null);
    expect(system.map((album) => Number(album.data.albumType)).sort((a, b) => a - b))
      .toEqual([1000, 5000, 38000]);
    for (const album of system) {
      // A title is not identity: the system albums have none.
      expect(album.data.title).toBeNull();
    }
  });

  it("reads album createdAt as MILLISECONDS", () => {
    const album = ofType(list, "vault.album_observed")
      .find((draft) => draft.data.albumRef === "000900000000000101");
    // 1690000000000 ms = 2023-07-22. Read as seconds it would be the year
    // 55531; read with a heuristic that guessed wrong it would be 1970.
    expect(album?.data.createdAtPlatform).toBe("2023-07-22T04:26:40.000Z");
  });

  it("is receipt-time (§3.2b): occurredAt is the observation, never the album's date", () => {
    for (const draft of list) {
      expect(draft.occurredAt).toEqual(RECEIVED_AT);
      // A receipt-time draft is inside the clamp window by construction, so a
      // clamp marker here would prove the family dated at provider time after
      // all. The 2023-dated album above is what makes this assertion bite.
      expect(draft.data.occurredAtClamped).toBeUndefined();
      expect(draft.data.occurredAtRaw).toBeUndefined();
    }
  });

  it("stores itemCount AS SERVED, and Σ itemCount over-counts the real inventory", () => {
    const albums = ofType(list, "vault.album_observed");
    const sum = albums.reduce((total, album) => total + Number(album.data.itemCount ?? 0), 0);
    // The fixture mirrors the live double-count: the system albums 38000 and
    // 5000 share a lastItemId, so they are VIEWS over the same media.
    expect(sum).toBe(760);
    const byRef = new Map(albums.map((album) => [album.data.albumRef, album.data]));
    expect(byRef.get("000900000000000103")?.lastItemRef)
      .toBe(byRef.get("000900000000000104")?.lastItemRef);
    // …which is exactly why Σ is not M. M is counted over creator_media.
  });

  it("puts NO delivery URL, location or variant into any event", () => {
    const keys = new Set(allKeys(list.map((draft) => draft.data)));
    for (const banned of ["location", "locations", "variants", "variantHash", "filename"]) {
      expect(keys.has(banned), `${banned} reached an event`).toBe(false);
    }
    for (const value of allStrings(list.map((draft) => draft.data))) {
      expect(value).not.toContain("SIGNED");
    }
  });

  it("reads the user vault as its OWN kind, with the sidecar's membership", () => {
    const userList = drafts("uservault_albums", fixture("uservault-albums"));
    const albums = ofType(userList, "vault.album_observed");
    expect(albums).toHaveLength(2);
    for (const album of albums) {
      expect(album.data.vaultKind).toBe("user");
    }
    // `itemCount: null` on the Likes shelf stays null — never coalesced to 0.
    expect(albums.find((a) => a.data.albumRef === "000900000000000201")?.data.itemCount)
      .toBeNull();

    const members = ofType(userList, "vault.album_membership_observed");
    expect(members).toHaveLength(1);
    expect(members[0]?.data.vaultKind).toBe("user");
    // The membership row's OWN id — the walk cursor, NOT the media offer id.
    expect(members[0]?.data.memberRef).toBe("000900000000000701");
    expect(members[0]?.data.mediaOfferRef).toBe("000900000000000601");
    // MILLISECONDS on this field, in the SAME response whose accountMedia rows
    // are seconds.
    expect(members[0]?.data.createdAtPlatform).toBe("2026-08-12T17:44:23.000Z");
  });

  it("emits NO media.observed from the user vault — those are somebody else's media", () => {
    const userList = drafts("uservault_albums", fixture("uservault-albums"));
    // The Purchases shelf carries an `accountMedia[]` sidecar of media bought
    // FROM OTHER CREATORS. Writing it to creator_media would inflate M by the
    // size of the page's shopping history.
    expect(ofType(userList, "media.observed")).toHaveLength(0);
  });
});

describe("fansly-catalog: the vault media walk", () => {
  const list = drafts("vault_media", fixture("vault-media-page"));

  it("emits membership from albumMedia, keyed without a hash", () => {
    const members = ofType(list, "vault.album_membership_observed");
    expect(members).toHaveLength(2);
    // NO hash in the key: membership is binary. An album either contains an
    // offer or it does not, and a neighbouring field moving must not mint a
    // second event for the same fact.
    expect(members[0]?.dedupKey)
      .toBe("albummem:v1:7:000900000000000101:000900000000000611");
    expect(members[0]?.data.vaultKind).toBe("creator");
  });

  it("has NO roster — a paged walk cannot assert what an album does not hold", () => {
    expect(ofType(list, "catalog.listing_observed")).toHaveLength(0);
  });

  it("reads nothing from the raw media[] sidecar", () => {
    const keys = new Set(allKeys(list.map((draft) => draft.data)));
    for (const banned of ["location", "locations", "variants"]) {
      expect(keys.has(banned)).toBe(false);
    }
    // No accountMedia sidecar in the observed shape ⇒ no media.observed.
    expect(ofType(list, "media.observed")).toHaveLength(0);
  });
});

describe("fansly-catalog: the batch hydrations", () => {
  it("mints media.observed with first_origin account_media_batch, priced from permissions", () => {
    const list = drafts("account_media_batch", fixture("account-media-batch"));
    const media = ofType(list, "media.observed");
    expect(media).toHaveLength(2);
    const first = media.find((draft) => draft.data.mediaOfferRef === "000900000000000611");
    expect(first?.data.subject).toBe("media");
    expect(first?.data.firstOrigin).toBe("account_media_batch");
    // THE PRICE PATH: permissions.permissionFlags[].price, as a decimal STRING
    // of mills. The top-level `price` was 0 on this row, as it is live.
    expect(first?.data.priceMills).toBe("79000");
    expect(first?.data.permissionEntries).toHaveLength(2);
    // saleStats.total is NET (A12) and is never coalesced to 0 when absent.
    expect(first?.data.salesNetMills).toBe("63200");
    const second = media.find((draft) => draft.data.mediaOfferRef === "000900000000000613");
    expect(second?.data.salesNetMills).toBeNull();
    expect(second?.data.salesCount).toBeNull();
  });

  it("mints bundle events with subject 'bundle' and their membership", () => {
    const list = drafts("account_media_bundle_batch", fixture("account-media-bundle-batch"));
    const bundles = ofType(list, "media.observed");
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.data.subject).toBe("bundle");
    expect(bundles[0]?.data.bundleRef).toBe("000900000000000651");
    expect(bundles[0]?.data.memberRefs)
      .toEqual(["000900000000000611", "000900000000000613"]);
    expect(bundles[0]?.data.priceMills).toBe("120000");
    expect(bundles[0]?.data.firstOrigin).toBe("account_media_batch");
  });

  it("keeps every media URL out of the events it mints", () => {
    const list = [
      ...drafts("account_media_batch", fixture("account-media-batch")),
      ...drafts("account_media_bundle_batch", fixture("account-media-bundle-batch")),
    ];
    for (const value of allStrings(list.map((draft) => draft.data))) {
      expect(value).not.toContain("SIGNED");
    }
  });
});

describe("fansly-catalog: subscription tiers (FEAT-002)", () => {
  const list = drafts("subscription_tiers", fixture("subscription-tiers"));

  it("keeps tier.price as basePriceMills — a BASE, never the price", () => {
    const tiers = ofType(list, "subscription.tier_observed");
    expect(tiers).toHaveLength(2);
    for (const tier of tiers) {
      // Every observed tier carried 5 000 while its plans ran to 499 990.
      expect(tier.data.basePriceMills).toBe("5000");
      expect(tier.data.priceMills).toBeUndefined();
    }
  });

  it("normalizes plan prices, with 499 990 as the maximum the payload can carry", () => {
    const plans = ofType(list, "subscription.tier_plan_observed");
    expect(plans).toHaveLength(4);
    const prices = plans.map((plan) => plan.data.priceMills).sort();
    expect(prices).toEqual(["10000", "16500", "40000", "499990"]);
    // Decimal STRINGS. A number here would be a float in the ledger.
    for (const price of prices) {
      expect(typeof price).toBe("string");
    }
  });

  it("reads duration from billingCycle, NOT from the promo's `duration`", () => {
    const plans = ofType(list, "subscription.tier_plan_observed");
    const byRef = new Map(plans.map((plan) => [plan.data.planRef, plan.data]));
    expect(byRef.get("000900000000000401")?.durationDays).toBe(30);
    expect(byRef.get("000900000000000402")?.durationDays).toBe(90);
    expect(byRef.get("000900000000000404")?.durationDays).toBe(60);
    // The promo one level down carries `duration: 30`; the PLAN carries
    // `billingCycle: 90`. Reading the wrong one would report a quarterly plan
    // as monthly at a discounted price.
    const promos = byRef.get("000900000000000401")?.promos as Record<string, unknown>[];
    expect(promos[0]?.duration).toBe(30);
  });

  it("keeps plans and promos verbatim beside the normalized rows", () => {
    const tier = ofType(list, "subscription.tier_observed")
      .find((draft) => draft.data.tierRef === "000900000000000302");
    const plans = tier?.data.plans as Record<string, unknown>[];
    expect(plans).toHaveLength(2);
    // An unnamed future key survives into the verbatim array untouched, which
    // is what makes the normalized table safe to narrow.
    expect(plans[0]?.someUnnamedFutureField).toBe("kept-verbatim");
  });

  it("emits two rosters from one response — tiers and plans move independently", () => {
    expect(roster(list, "subscription_tiers").data.refs)
      .toEqual(["000900000000000301", "000900000000000302"]);
    expect(roster(list, "subscription_tier_plans").data.refs).toHaveLength(4);
  });

  it("keys the roster per LOOK, so a set that returns is not mistaken for one that never moved", () => {
    const payload = fixture("subscription-tiers") as { rows: unknown[] };
    // The SAME observation replays to the same key — replay stays a no-op.
    expect(roster(drafts("subscription_tiers", payload), "subscription_tiers").dedupKey)
      .toBe(roster(list, "subscription_tiers").dedupKey);

    // A DIFFERENT look appends a new roster even when the ref set is identical,
    // and that is the whole correction: a tier that disappears and comes back
    // unchanged hashes to the roster it had before it vanished, so a hash-keyed
    // roster would dedupe and leave the row marked `missing_since` forever.
    const laterLook = canonicalizeFanslyCatalogObservation(
      { ...observation("subscription_tiers", payload), id: 2 },
      { nativeAccountRefByAccountId: new Map() },
    );
    expect(roster(laterLook, "subscription_tiers").dedupKey)
      .not.toBe(roster(list, "subscription_tiers").dedupKey);
    // …while the content hash it carries is unchanged, which is what a reader
    // uses to see that the set itself did not move.
    expect(roster(laterLook, "subscription_tiers").data.contentHash)
      .toBe(roster(list, "subscription_tiers").data.contentHash);

    const shrunk = drafts("subscription_tiers", { rows: [payload.rows[0]] });
    expect(roster(shrunk, "subscription_tiers").data.contentHash)
      .not.toBe(roster(list, "subscription_tiers").data.contentHash);
    expect(roster(shrunk, "subscription_tiers").data.refs).toEqual(["000900000000000301"]);
  });

  it("emits an EMPTY roster for an empty listing — the case with no row events", () => {
    const empty = drafts("subscription_tiers", { rows: [] });
    expect(ofType(empty, "subscription.tier_observed")).toHaveLength(0);
    // …and this is the whole reason the roster exists. Without it, a page whose
    // last tier was retired would keep reading as if all five were live.
    expect(roster(empty, "subscription_tiers").data.refs).toEqual([]);
    expect(roster(empty, "subscription_tier_plans").data.refs).toEqual([]);
  });

  it("mints one new event on a changed price and reuses the key otherwise", () => {
    const payload = fixture("subscription-tiers") as {
      rows: { plans: { price: number }[] }[];
    };
    const before = ofType(list, "subscription.tier_plan_observed")[0]!.dedupKey;
    payload.rows[0]!.plans[0]!.price = 12000;
    const after = ofType(drafts("subscription_tiers", payload), "subscription.tier_plan_observed")
      .find((draft) => draft.data.planRef === "000900000000000401")?.dedupKey;
    expect(after).not.toBe(before);
  });
});

describe("fansly-catalog: gift codes", () => {
  const list = drafts("gift_codes", fixture("gift-codes"));

  it("reads original_price by its SNAKE_CASE name", () => {
    const codes = ofType(list, "promo.gift_code_observed");
    expect(codes).toHaveLength(2);
    const byRef = new Map(codes.map((code) => [code.data.codeRef, code.data]));
    expect(byRef.get("000900000000001101")?.originalPriceMills).toBe("50000");
    expect(byRef.get("000900000000001102")?.originalPriceMills).toBe("499990");
  });

  it("keeps a full-comp code's price at 0 rather than null", () => {
    const code = ofType(list, "promo.gift_code_observed")
      .find((draft) => draft.data.codeRef === "000900000000001101");
    // `price: 0` on a gift code is a REAL full-comp code, not an unpopulated
    // field — the opposite of the saleStats rule, and it matters because the
    // two look identical in JSON.
    expect(code?.data.priceMills).toBe("0");
  });

  it("reads gift-code timestamps as MILLISECONDS, and keeps nulls null", () => {
    const byRef = new Map(
      ofType(list, "promo.gift_code_observed").map((code) => [code.data.codeRef, code.data]),
    );
    expect(byRef.get("000900000000001101")?.createdAtPlatform)
      .toBe("2026-08-02T17:34:01.000Z");
    expect(byRef.get("000900000000001101")?.startsAtPlatform).toBeNull();
    expect(byRef.get("000900000000001101")?.endsAtPlatform).toBeNull();
    expect(byRef.get("000900000000001102")?.endsAtPlatform).toBe("2026-08-14T07:20:41.000Z");
  });

  it("carries uses and maxUses without coalescing an unspent code to null", () => {
    const byRef = new Map(
      ofType(list, "promo.gift_code_observed").map((code) => [code.data.codeRef, code.data]),
    );
    expect(byRef.get("000900000000001101")?.uses).toBe(0);
    expect(byRef.get("000900000000001101")?.maxUses).toBe(100);
  });
});

describe("fansly-catalog: automated messages", () => {
  it("parses the OBJECT template — the live shape in all seven values", () => {
    const list = drafts("automated_messages", fixture("automated-messages"));
    const automations = ofType(list, "automation.definition_observed");
    expect(automations).toHaveLength(2);
    const first = automations[0]!.data;
    expect(first.parseOk).toBe(true);
    expect(first.messageText).toBe("hi, welcome");
    expect(first.templateType).toBe(1);
    // Id-relations only. `contentId` is a media offer, never a URL.
    expect(first.attachmentRefs).toEqual([
      { contentType: 1, contentId: "000900000000000601" },
      { contentType: 1, contentId: "000900000000000602" },
    ]);
    expect(first.triggerType).toBe(3);
    expect(first.triggerMetadata).toEqual({});
  });

  it("parses triggerMetadata out of the JSON STRING the platform sends", () => {
    const list = drafts("automated_messages", fixture("automated-messages"));
    const tiered = ofType(list, "automation.definition_observed")
      .find((draft) => draft.data.triggerType === 15);
    expect(tiered?.data.triggerMetadata).toEqual({
      subscriptionTierId: "000900000000000301",
      subscriptionTierName: "Basic",
    });
    expect(tiered?.data.delaySeconds).toBe(25000);
    expect(tiered?.data.cooldownSeconds).toBe(3600);
  });

  it("falls back on the March STRING shape: parse_ok FALSE, row still written", () => {
    const diagnostics: string[] = [];
    const list = drafts(
      "automated_messages",
      fixture("automated-messages-string-template"),
      diagnostics,
    );
    const automations = ofType(list, "automation.definition_observed");
    expect(automations).toHaveLength(2);

    const unparsed = automations.find((draft) => draft.data.automationRef === "000900000000001301");
    // The single-quoted pseudo-JSON: the ROW lands, `parseOk` is FALSE, and the
    // text is NULL rather than "" — an automation with no text and one we could
    // not read are different facts.
    expect(unparsed?.data.parseOk).toBe(false);
    expect(unparsed?.data.messageText).toBeNull();
    expect(unparsed?.data.attachmentRefs).toEqual([]);
    // Unreadable trigger metadata is WRAPPED, never dropped.
    expect(unparsed?.data.triggerMetadata).toEqual({ raw: "not json either" });

    const encoded = automations.find((draft) => draft.data.automationRef === "000900000000001302");
    // The same template as a VALID JSON string: the encoding changed, the
    // content did not, so parseOk stays true.
    expect(encoded?.data.parseOk).toBe(true);
    expect(encoded?.data.messageText).toBe("hi again");

    // Both string-shaped templates are counted, whether or not they parsed —
    // a systematic encoding change should be visible before it is a mystery.
    expect(diagnostics.filter((code) => code === FANSLY_AUTOMATION_TEMPLATE_FALLBACK_DIAGNOSTIC))
      .toHaveLength(2);
  });

  it("parseAutomationTemplate and parseAutomationTriggerMetadata refuse to invent", () => {
    expect(parseAutomationTemplate(null).parseOk).toBe(false);
    expect(parseAutomationTemplate(42).parseOk).toBe(false);
    // A string that parses to a SCALAR is not an object template.
    expect(parseAutomationTemplate('"hello"').parseOk).toBe(false);
    expect(parseAutomationTriggerMetadata(undefined)).toEqual({});
    expect(parseAutomationTriggerMetadata("")).toEqual({});
    expect(parseAutomationTriggerMetadata("5")).toEqual({ raw: "5" });
    expect(parseAutomationTriggerMetadata({ already: "object" })).toEqual({ already: "object" });
  });
});

describe("fansly-catalog: walls", () => {
  const list = drafts("account_walls", fixture("account-walls"));

  it("keeps mainWall and defaultWall as two independent flags", () => {
    const walls = ofType(list, "page.wall_observed");
    expect(walls).toHaveLength(3);
    const byRef = new Map(walls.map((wall) => [wall.data.wallRef, wall.data]));
    // Most walls are neither. One boolean would lose which of the two a wall is.
    expect(byRef.get("000900000000001401")?.defaultWall).toBe(true);
    expect(byRef.get("000900000000001401")?.mainWall).toBeNull();
    expect(byRef.get("000900000000001403")?.mainWall).toBe(true);
    expect(byRef.get("000900000000001403")?.defaultWall).toBeNull();
    expect(byRef.get("000900000000001402")?.mainWall).toBeNull();
    expect(byRef.get("000900000000001402")?.defaultWall).toBeNull();
  });

  it("emits the wall roster", () => {
    expect(roster(list, "page_walls").data.refs).toEqual([
      "000900000000001401",
      "000900000000001402",
      "000900000000001403",
    ]);
  });
});

describe("fansly-catalog: the parse gate", () => {
  it("refuses a kind it does not claim, and an observation with no account", () => {
    expect(canParseFanslyCatalogObservation({
      kind: "notifications",
      payload: [],
      accountId: 7,
    })).toBe(false);
    expect(canParseFanslyCatalogObservation({
      kind: "gift_codes",
      payload: [],
      accountId: null,
    })).toBe(false);
  });

  it("accepts an EMPTY listing — the empty roster is what marks rows missing", () => {
    expect(canParseFanslyCatalogObservation({
      kind: "gift_codes",
      payload: [],
      accountId: 7,
    })).toBe(true);
    expect(canParseFanslyCatalogObservation({
      kind: "vault_albums",
      payload: { albums: [] },
      accountId: 7,
    })).toBe(true);
  });

  it("refuses a DRIFTED shape rather than consuming it with zero events", () => {
    // Without this the observation would be stamped parsed and never revisited:
    // "capture now, parse later" quietly becomes "capture now, never parse".
    expect(canParseFanslyCatalogObservation({
      kind: "vault_albums",
      payload: { somethingElse: true },
      accountId: 7,
    })).toBe(false);
    expect(canParseFanslyCatalogObservation({
      kind: "vault_media",
      payload: { media: [] },
      accountId: 7,
    })).toBe(false);
  });

  it("ignores unknown keys while the journal keeps them", () => {
    const payload = fixture("vault-albums") as { albums: Record<string, unknown>[] };
    const album = ofType(drafts("vault_albums", payload), "vault.album_observed")
      .find((draft) => draft.data.albumRef === "000900000000000106");
    expect(album?.data.someUnnamedFutureField).toBeUndefined();
    // …and the fixture still carries it, which is the journal's job.
    expect(payload.albums.find((row) => row.id === "000900000000000106")
      ?.someUnnamedFutureField).toBe("kept-verbatim");
  });
});
