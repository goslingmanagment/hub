import { describe, expect, it } from "vitest";

import { isProjectionOnlyDomainEventType } from "@agency_hub_core/db";

import { familyForObservation } from "../apps/runtime/src/services/canonicalize/index.ts";
import {
  buildPostObservedDraft,
  canParsePostsObservation,
  canonicalizePostsObservation,
} from "../apps/runtime/src/services/canonicalize/posts.ts";
import type { CanonicalizableObservation } from "../apps/runtime/src/services/canonicalize/types.ts";

const RECEIVED_AT = new Date("2026-08-02T12:00:00Z");

function observation(
  payload: unknown,
  overrides: Partial<CanonicalizableObservation> = {},
): CanonicalizableObservation {
  return {
    id: 71,
    source: "pull",
    producer: "sync:fansly:posts",
    platform: "fansly",
    accountId: 9,
    kind: "posts",
    payload,
    observedAt: null,
    receivedAt: RECEIVED_AT,
    ...overrides,
  };
}

describe("creator-post canonicalizer", () => {
  it("registers posts as its own projection-only pull family", () => {
    const family = familyForObservation(observation({ posts: [] }));
    expect(family).toMatchObject({
      source: "pull",
      version: 1,
      projectionOnly: true,
    });
    expect(family?.kinds).toEqual(["posts"]);
    expect(isProjectionOnlyDomainEventType("post.observed")).toBe(true);
  });

  it("keeps provider text verbatim, converts Fansly epoch seconds and counts attachments", () => {
    const events = canonicalizePostsObservation(observation({
      posts: [{
        id: "post-42",
        content: "<p>Hello &amp; welcome</p><p>Second line</p>",
        createdAt: 1_754_136_000,
        attachments: [{ id: "a" }, { id: "b" }],
      }],
    }));

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "post.observed",
      postRef: "post-42",
      occurredAt: new Date("2025-08-02T12:00:00.000Z"),
      schemaVersion: 1,
      data: {
        platform: "fansly",
        textPlain: "<p>Hello &amp; welcome</p><p>Second line</p>",
        publishedAt: "2025-08-02T12:00:00.000Z",
        observedAt: RECEIVED_AT.toISOString(),
        attachmentCount: 2,
      },
    });
    expect(events[0]!.dedupKey).toMatch(/^post:fansly:post-42:[0-9a-f]{64}:obs:71$/);
    expect(events[0]!.data.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts empty/media-only posts but refuses invalid timestamps and wrong text types", () => {
    expect(canParsePostsObservation(observation({ posts: [] }))).toBe(true);
    expect(canParsePostsObservation(observation({
      posts: [{ id: "media-only", createdAt: 1_754_136_000, attachments: [{}] }],
    }))).toBe(true);
    expect(canonicalizePostsObservation(observation({
      posts: [{ id: "media-only", content: null, createdAt: 1_754_136_000 }],
    }))[0]!.data.textPlain).toBe("");
    expect(canParsePostsObservation(observation({
      posts: [{ id: "bad-time", content: "x", createdAt: "not-a-date" }],
    }))).toBe(false);
    expect(canParsePostsObservation(observation({
      posts: [{ id: "bad-text", content: 123, createdAt: 1_754_136_000 }],
    }))).toBe(false);
  });

  it("dedupes one capture retry but keeps later unchanged sightings distinct", () => {
    const material = {
      platform: "fansly" as const,
      postId: "same-post",
      textPlain: "same text",
      publishedAt: new Date("2026-07-01T00:00:00Z"),
      observedAt: RECEIVED_AT,
      attachmentCount: 0,
    };
    const first = buildPostObservedDraft({ ...material, observationId: 10 });
    const retry = buildPostObservedDraft({ ...material, observationId: 10 });
    const later = buildPostObservedDraft({
      ...material,
      observationId: 11,
      observedAt: new Date("2026-08-03T12:00:00Z"),
    });

    expect(retry.dedupKey).toBe(first.dedupKey);
    expect(later.dedupKey).not.toBe(first.dedupKey);
    expect(later.data.contentHash).toBe(first.data.contentHash);
  });
});
