import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { canonicalizeFanslyCatalogObservation } from "../apps/runtime/src/services/canonicalize/fansly-catalog.ts";
import { canonicalizePostsObservation } from "../apps/runtime/src/services/canonicalize/posts.ts";
import { fanslyRawMediaDrafts } from "../apps/runtime/src/services/canonicalize/raw-media.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

function observation(payload: unknown, kind = "vault_media"): CanonicalizableObservation {
  return { id: 12, source: "pull", producer: "sync", platform: "fansly", accountId: 7,
    kind, payload, observedAt: null, receivedAt: new Date("2026-09-01T10:00:00Z") };
}

const fixture = JSON.parse(readFileSync(new URL("./fixtures/fansly-catalog/content-media-vault.json", import.meta.url), "utf8"));

describe("raw media identities", () => {
  it("keeps raw files without offers, source dimensions and fractional timing, without URLs", () => {
    const events = fanslyRawMediaDrafts(observation(fixture));
    expect(events).toHaveLength(3);
    expect(events[0]?.data).toMatchObject({ mediaRef: "file-1", filename: "8_43 ????????.mp4",
      durationMs: 522682, originalWidth: 2160, originalHeight: 3840,
      width: 720, height: 1280, frameRateMilli: 30210 });
    expect(events[1]?.data.durationMs).toBeNull();
    expect(JSON.stringify(events)).not.toMatch(/DO_NOT_COPY|https:|variants|location/);
  });

  it("preserves a retry key but advances a new sighting and a changed membership title", () => {
    const original = observation(fixture);
    const first = canonicalizeFanslyCatalogObservation(original);
    expect(canonicalizeFanslyCatalogObservation(original)).toEqual(first);
    const later = canonicalizeFanslyCatalogObservation({ ...original, id: 13,
      receivedAt: new Date("2026-09-02T10:00:00Z") });
    expect(later[0]?.dedupKey).not.toEqual(first[0]?.dedupKey);
    expect(later[0]?.occurredAt.toISOString()).toBe("2026-09-02T10:00:00.000Z");
    const renamed = structuredClone(fixture);
    renamed.albumMedia[0].customFilename = "Новое название";
    const changed = canonicalizeFanslyCatalogObservation(observation(renamed));
    expect(changed[0]?.data.customFilename).toBe("Новое название");
    expect(changed[0]?.dedupKey).not.toEqual(first[0]?.dedupKey);
    expect(changed[1]?.data.customFilename).toBe("");
  });

  it("turns malformed measurements into unknowns without inventing zeroes", () => {
    const [draft] = fanslyRawMediaDrafts(observation({ media: [{ id: "file", width: -1, height: 2147483648,
      metadata: '{"duration":"522","originalWidth":-1,"frameRate":null}' }] }));
    expect(draft?.data).toMatchObject({ durationMs: null, width: null, height: null, originalWidth: null,
      originalHeight: null, frameRateMilli: null });
  });

  it("captures post-side offer and file identities without changing the original observation time", () => {
    const payload = { posts: [{ id: "post-1", createdAt: 1738411200, content: "caption",
      attachments: [{ pos: 0, contentType: 1, contentId: "offer-1" }] }],
      accountMedia: [{ id: "offer-1", accountId: "creator-1", mediaId: "file-1",
        media: fixture.media[0] }] };
    const events = canonicalizePostsObservation(observation(payload, "posts"));
    expect(events.map((event) => event.type)).toEqual(["post.observed", "media.observed", "media.file_observed"]);
    expect(events[1]?.data).toMatchObject({ mediaOfferRef: "offer-1", mediaRef: "file-1", firstOrigin: "post" });
    expect(events[2]?.data.filename).toBe("8_43 ????????.mp4");
    expect(events[0]?.data.observedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(JSON.stringify(events)).not.toContain("DO_NOT_COPY");
  });
});
