import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import { contentHash } from "../apps/runtime/src/services/canonicalize/sync-pull.ts";
import { buildCanonicalDrafts } from "../apps/runtime/src/services/canonicalize-drafts.ts";
import {
  contentKeyedLegacyKey,
  truncatedDurationLegacyKey,
} from "../apps/runtime/src/sync/fansly/lib/family-replay.ts";

// The two legacy key spellings the journal replay accepts for a missing
// canonical key (design §3.12 B5, `lib/family-replay.ts`): the content keys
// #281 moved per look, and the truncated media durations #122 rounded. Each
// translation is pinned against the literal the old code minted.

describe("contentKeyedLegacyKey (#281, b8cebac5)", () => {
  const OBS = 3094561;

  it("maps each per-look row key of this observation to the content key the old code minted", () => {
    // The exact pre-#281 literals from the b8cebac5 diff, the obs suffix removed.
    const pairs: Array<[string, string]> = [
      [`album:v2:10:creator:928408212237991937:bbccb176:obs:${OBS}`, "album:v1:10:creator:928408212237991937:bbccb176"],
      [`tier:v2:10:900000000000000001:aa11:obs:${OBS}`, "tier:v1:10:900000000000000001:aa11"],
      [`tierplan:v2:10:900000000000000001:900000000000000002:bb22:obs:${OBS}`, "tierplan:v1:10:900000000000000001:900000000000000002:bb22"],
      [`giftcode:v2:10:900000000000000003:cc33:obs:${OBS}`, "giftcode:v1:10:900000000000000003:cc33"],
      [`automation:v2:10:900000000000000004:dd44:obs:${OBS}`, "automation:v1:10:900000000000000004:dd44"],
      [`wall:v2:10:900000000000000005:ee55:obs:${OBS}`, "wall:v1:10:900000000000000005:ee55"],
      [`payoutmethod:v2:10:900000000000000006:ff66:obs:${OBS}`, "payoutmethod:v1:10:900000000000000006:ff66"],
      // The production pair of the 2026-10-02 report (lora-1).
      [
        `comment:v2:1:805643272306311169:7a09efa8e78d24391c6ae9e4eb9b12ab9d9d8b2fb2844c84a5e68afc9882e45e:obs:${OBS}`,
        "comment:v1:1:805643272306311169:7a09efa8e78d24391c6ae9e4eb9b12ab9d9d8b2fb2844c84a5e68afc9882e45e",
      ],
    ];
    for (const [key, legacy] of pairs) expect(contentKeyedLegacyKey(key, OBS), key).toBe(legacy);
  });

  it("refuses another observation's key and every key #281 did not move", () => {
    expect(contentKeyedLegacyKey(`comment:v2:1:805643272306311169:7a09:obs:${OBS}`, OBS + 1)).toBeNull();
    for (const key of [
      `cataloglisting:v1:10:vault_albums:creator:${OBS}:4bd7`,
      `commentlist:v1:1:805643272306311169:${OBS}:9c22`,
      `rawmedia:v1:10:960870398319153152:ecb3:obs:${OBS}`,
      `albummem:v2:10:928408212237991937:960870398319153152:obs:${OBS}`,
      "media:v1:1:924340816799879168:ab64",
      `comment:v1:1:805643272306311169:7a09`,
      `pull:v3:checkpoint:${OBS}`,
    ]) {
      expect(contentKeyedLegacyKey(key, OBS), key).toBeNull();
    }
  });
});

describe("truncatedDurationLegacyKey (#122, 31ead004)", () => {
  const PAGE = 1;
  const stats = JSON.parse(readFileSync(path.resolve("tests/fixtures/fansly-stats/stats-account-daily.json"), "utf8")) as {
    aggregationData: { accountMedia: Array<Record<string, unknown>> };
  } & Record<string, unknown>;

  /** The fixture's video with this duration (seconds), under a fresh offer id. */
  function video(offerRef: string, seconds: number | null): Record<string, unknown> {
    const row = structuredClone(stats.aggregationData.accountMedia[0]!);
    const media = row.media as Record<string, unknown>;
    const metadata = JSON.parse(media.metadata as string) as Record<string, unknown>;
    if (seconds === null) delete metadata.duration;
    else metadata.duration = seconds;
    return { ...row, id: offerRef, media: { ...media, metadata: JSON.stringify(metadata) } };
  }

  function drafts(rows: Array<Record<string, unknown>>) {
    const payload = structuredClone(stats);
    payload.aggregationData.accountMedia = [...rows, stats.aggregationData.accountMedia[1]!];
    const family = familyForObservation({ source: "pull", kind: "account_stats", platform: "fansly" })!;
    const outcome = buildCanonicalDrafts(family, {
      id: 2107730, source: "pull", producer: "test", platform: "fansly", accountId: PAGE, kind: "account_stats",
      payload, observedAt: null, receivedAt: new Date("2026-09-03T05:02:22Z"),
    }, { nativeAccountRefByAccountId: new Map([[PAGE, "000900000000000003"]]), now: new Date("2026-09-03T05:03:00Z") });
    if (outcome.kind !== "accepted") throw new Error("the stats fixture must canonicalize");
    return outcome.drafts;
  }

  /** The key the pre-#122 code minted: `Math.trunc(seconds × 1000)`, built here independently. */
  function preRoundingKey(draft: { dedupKey: string; data: Record<string, unknown> }, seconds: number): string {
    const material: Record<string, unknown> = { ...draft.data };
    delete material.contentHash;
    return `media:v1:${PAGE}:${String(material.mediaOfferRef)}:${contentHash({ ...material, durationMs: Math.trunc(seconds * 1000) })}`;
  }

  it("names the key the truncating code minted exactly when rounding changed the duration", () => {
    // 192.866667 s and the float noise of 5.291 s round up; 10 s does not move.
    const seconds = new Map([["900000000000000101", 192.866667], ["900000000000000102", 5.291], ["900000000000000103", 10]]);
    const media = drafts([...seconds].map(([ref, s]) => video(ref, s)))
      .filter((draft) => draft.type === "media.observed" && seconds.has(String(draft.data.mediaOfferRef)));
    expect(media.map((draft) => draft.data.durationMs)).toEqual([192_867, 5_291, 10_000]);
    for (const draft of media) {
      const s = seconds.get(String(draft.data.mediaOfferRef))!;
      const legacy = preRoundingKey(draft, s);
      if (Math.trunc(s * 1000) === Math.round(s * 1000)) expect(legacy).toBe(draft.dedupKey);
      else expect(truncatedDurationLegacyKey(draft)).toBe(legacy);
    }
    expect(truncatedDurationLegacyKey(media[0]!)).not.toBe(media[0]!.dedupKey);
  });

  it("has no other spelling for a bundle, a media row without a duration, or any other event", () => {
    const all = drafts([video("900000000000000104", null), video("900000000000000105", 0)]);
    const noDuration = all.filter((draft) => draft.type === "media.observed"
      && ["900000000000000104", "900000000000000105"].includes(String(draft.data.mediaOfferRef)));
    expect(noDuration.map((draft) => draft.data.durationMs)).toEqual([null, 0]);
    for (const draft of noDuration) expect(truncatedDurationLegacyKey(draft)).toBeNull();
    const bundles = all.filter((draft) => draft.dedupKey.startsWith("mediabundle:v1:"));
    expect(bundles.length).toBeGreaterThan(0);
    for (const draft of bundles) expect(truncatedDurationLegacyKey(draft)).toBeNull();
    const others = all.filter((draft) => draft.type !== "media.observed");
    expect(others.length).toBeGreaterThan(0);
    for (const draft of others) expect(truncatedDurationLegacyKey(draft)).toBeNull();
  });
});
